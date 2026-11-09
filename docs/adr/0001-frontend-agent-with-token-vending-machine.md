# ADR 0001: Host the agent in the frontend and vend inference tokens from the backend

- **Status:** Proposed (PoC in progress)
- **Date:** 2026-11-09
- **Deciders:** Frontend and backend squads
- **References:**
  - *Architectural Strategies for Orchestrating Frontend WebMCP and Backend MCP via Vercel Eve Agents* (internal research doc)
  - *Architectural Strategies for Local Agent Orchestration: Evaluating WebMCP, Frontend Models, and OS-Native AI* (internal research doc)
  - [GoogleChromeLabs/webmcp-tools, ticket-booking demo](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/demos/ticket-booking)

## Context

The frontend registers WebMCP tools (`document.modelContext.registerTool`) that drive UI state: filtering lists, navigating views and filling forms. The backend runs an eve agent behind a public API, connected to backend MCP servers for data access and integrations.

The browser holds the WebMCP tools, and a cloud LLM cannot see or call them. Some piece of the system has to bridge that gap. We also cannot ship a vendor API key (OpenAI or Anthropic) to the browser.

## Options considered

### Option 1: AI SDK proxy and deferred execution (backend orchestrates)

The browser sends its WebMCP tool schemas to the backend eve agent with each chat request. The agent mounts them as `dynamicTool`s with no `execute`. When the LLM calls one, the AI SDK streams the call to the browser. The browser runs it through `onToolCall`, returns the result with `addToolResult`, and re-POSTs to continue the loop.

- **Pros:** idiomatic in the Vercel stack, durable checkpointing on the backend, no extra infrastructure.
- **Cons:**
  - Every UI action is a cloud round trip: LLM generation, then SSE down, then a POST back up.
  - The backend has to mirror a tool catalogue that changes as the user moves between views.
  - Backend tracing never sees client-side tool results.
  - Client-supplied tool names, descriptions and schemas go straight into the backend agent's context. That is a new tool-poisoning and prompt-injection input on the backend.

### Option 2: Bidirectional WebSocket relay (MCP gateway)

The browser opens a persistent WebSocket to an MCP gateway and acts as a remote MCP server. The gateway merges browser tools with backend MCP tools and routes `tools/call` messages to the right browser session.

- **Pros:** protocol-pure and framework-agnostic, with one place to watch and police all tool traffic.
- **Cons:**
  - Needs a new stateful, long-lived service (WebSocket gateway plus a Redis backplane), which fits poorly with serverless.
  - Browser reconnect and backgrounding are hard to handle.
  - Opens a new inbound tunnel. The backend can now push commands into user browsers, and every connection is a session the backend must authenticate and route. **This is the largest new attack surface of the three options.**

### Option 3: Frontend-driven dual agent delegation (local agent orchestrates) ✅

An agent in the browser is the main orchestrator. It calls WebMCP tools directly in the page. The backend eve agent appears to it as one macro-tool (`query_backend_agent`) and is called over the existing public HTTP API only when a task needs backend data or integrations.

The local agent picks its model by capability:

1. An on-device model if one is available: Chrome's Gemini Nano through `LanguageModel`, or Apple Foundation Models on native.
2. Otherwise, the **Token Vending Machine (TVM) / AI gateway** fallback:
   1. The frontend asks the backend for a short-lived inference token.
   2. The backend checks the user's session and quota, then signs a short-lived JWT. It never hands out a vendor key.
   3. The frontend calls the gateway proxy route with that JWT.
   4. The gateway verifies the JWT and applies a per-user rate limit (for example, 10 requests a minute). It then attaches the real vendor key on the server and forwards the request to the LLM.

## Decision

**We adopt Option 3, with the TVM / AI gateway as the cloud fallback for the frontend agent's model.**

## Rationale

### Security: Option 3 does not grow the backend's attack surface

The backend eve agent already works on **zero trust towards client requests**. Every request carries the user's token. Tools run with that user's permissions (no shared service account) and enforce row-level scoping from the `sub` claim. Request content is treated as untrusted input.

With Option 3, delegation to the backend arrives as an ordinary request on that same public API, so nothing new is exposed:

| Concern | Option 1 | Option 2 | Option 3 |
|---|---|---|---|
| New inbound channel to the backend | No | **Yes**: stateful WebSocket gateway | No: same public API |
| Backend sends commands into the browser | Yes, via SSE tool calls | **Yes**, via the tunnel | No |
| Client-controlled tool metadata in the backend agent's context | **Yes** | **Yes** | No: the backend agent only sees a task description |
| Confused-deputy risk on the backend | Mitigated by zero trust | Mitigated by zero trust plus session routing | Mitigated by zero trust |

A compromised or malicious frontend agent gets nothing beyond what a malicious user could already do by calling the public API directly.

**Residual risk.** The TVM adds two small, stateless endpoints: `/token` and `/proxy`. They are covered by:

- short JWT lifetimes, measured in minutes;
- binding each JWT to the user (`sub`) and to an allowed model list;
- per-user rate limits and quota checks;
- keeping the vendor key on the server only;
- never logging raw prompts that might contain secrets.

The browser-side WebMCP tools rely on the browser's same-origin sandbox, `exposedTo` allowlists, and `consequentialHint` confirmation for destructive actions.

### Cost efficiency

Running a cloud agent to click simple UI elements spends expensive cloud tokens on trivial work. Sending routine navigation and client-side filtering to on-device models cuts cloud token use and API cost. We also avoid the hosting cost of the stateful WebSocket gateways that Option 2 needs to tunnel backend requests down to the browser.

### Response time

A cloud agent takes seconds per action: LLM generation plus network transit, even for simple screen changes. When the local agent orchestrates, WebMCP tools are chosen and run on the device. UI changes never touch the network and feel instant. The backend eve agent is called only when its compute or data access is actually needed.

### Multi-squad velocity (Conway's Law)

The pattern maps cleanly onto squad boundaries:

- **Frontend and mobile squads** own the local agent, UI state and WebMCP tool definitions.
- **Backend squad** no longer tracks fine-grained UI state or whether a React component is mounted. It focuses on the eve agent: durable, complex backend integrations and subagent delegation inside the cloud firewall.

The two domains talk over a single, well-defined API boundary.

## Consequences

**Positive**
- Instant UI actions, lower cloud spend, and no new stateful infrastructure.
- No vendor key ever reaches the client. Cloud inference is metered per user through the TVM.
- Clear ownership split between frontend and backend.

**Negative or accepted trade-offs**
- **Model capability gap:** on-device models such as Gemini Nano (4K context on Apple) are weaker at tool selection and at deciding when to delegate. The TVM cloud fallback reduces this.
- **Two agent loops to maintain:** a small, constrained frontend loop and the backend eve loop, which means separate prompts, evals and tracing.
- **Distributed tracing** across the client/server boundary must be designed in. A trace ID should travel on every delegation call.
- **Device availability varies:** Gemini Nano needs Chrome with enough disk space and VRAM. The capability check and fallback cascade are required, not optional.

## PoC scope

The PoC is meant to prove one thing: **an agent hosted in the frontend can run end to end on a token vended by the backend, without ever holding a vendor key.**

- A WebMCP page, based on the CineFlow ticket-booking demo, registers UI tools.
- A frontend agent loop probes for `LanguageModel` and otherwise falls back to the TVM.
- A Node.js backend provides `POST /token` (issues the JWT) and `POST /proxy` (verifies the JWT, rate-limits, attaches the vendor key and forwards).
- **Human-in-the-loop purchase:** a `prefill_checkout` WebMCP tool fills in the checkout form. Only the user's **Buy** click calls `POST /api/tickets`, and the backend re-validates everything sent.
- **Delegation to the backend agent:** the frontend agent's `ask_backend_agent` tool calls `POST /api/agent` on the existing session, not with the inference JWT. The backend agent stands in for eve and is built on the Vercel AI SDK. It handles bookings and refunds with tools scoped to the session user.
- **Elicitation:** `refund_booking` uses the AI SDK's `needsApproval`. The backend pauses and returns an MCP-style elicitation (`message` + `requestedSchema`), and the frontend renders it as a form. The answer resumes the backend loop through `POST /api/agent/elicitation`. Conversation state, including pending approvals, stays on the server, so the client can only answer elicitations this server issued to this user.
- **Both agents use the Vercel AI SDK v6.** The frontend reaches the gateway through `@ai-sdk/openai` with a custom `fetch` that attaches the JWT, and reaches Gemini Nano through `@built-in-ai/core`. v6 is used because `@built-in-ai/core` does not support v7 yet.
