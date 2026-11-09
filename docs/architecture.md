# Architecture: Frontend Agent + Token Vending Machine

See [ADR 0001](adr/0001-frontend-agent-with-token-vending-machine.md) for the decision record.

## Components

```mermaid
flowchart LR
  subgraph Browser["Browser (user's device)"]
    UI["Web page<br/>(CineFlow UI)"]
    WMCP["WebMCP tools<br/>document.modelContext"]
    AGENT["Frontend agent<br/>(orchestrator loop)"]
    NANO["On-device model<br/>Gemini Nano / Apple FM"]
    UI --- WMCP
    AGENT -- "call tools (local, ~0 latency)" --> WMCP
    AGENT -. "1st choice" .-> NANO
  end

  subgraph Backend["Node.js backend"]
    TVM["POST /token<br/>Token Vending Machine<br/>session + quota check → signed JWT"]
    GW["POST /proxy<br/>AI Gateway<br/>verify JWT · rate limit · attach vendor key"]
    EVE["POST /api/agent<br/>Backend agent (AI SDK)<br/>session-scoped tools · elicitation"]
    TIX["POST /api/tickets<br/>buy (re-validated)"]
  end

  LLM[("Cloud LLM<br/>OpenAI / Anthropic")]

  AGENT -- "2a. no local model → request token" --> TVM
  AGENT -- "2b. inference w/ JWT" --> GW
  GW -- "vendor key (server-only)" --> LLM
  AGENT -- "3. ask_backend_agent<br/>(refunds, bookings)" --> EVE
  UI -- "user clicks Buy" --> TIX
  EVE -- "vendor key (server-only)" --> LLM
```

## End-to-end flow (cloud fallback path)

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Page as Page + WebMCP tools
  participant Agent as Frontend agent
  participant TVM as Backend /token
  participant GW as Backend /proxy
  participant LLM as Cloud LLM

  User->>Agent: "Show horror movies in London"
  Agent->>Agent: LanguageModel.availability()
  alt On-device model available
    Agent->>Agent: Prompt Gemini Nano (no network)
  else Fallback to cloud
    Agent->>TVM: Request token (session cookie)
    TVM->>TVM: Validate session, check quota
    TVM-->>Agent: Short-lived JWT (e.g. 5 min)
    Agent->>GW: messages + WebMCP tool schemas, Bearer JWT
    GW->>GW: Verify JWT, per-user rate limit
    GW->>LLM: Forward with vendor API key
    LLM-->>GW: tool_call: update_location, query_content
    GW-->>Agent: tool calls
  end
  Agent->>Page: Execute WebMCP tools locally
  Page-->>Agent: Tool results
  Agent->>GW: Tool results (loop until done)
  GW->>LLM: Forward
  LLM-->>GW: Final answer
  GW-->>Agent: Final answer
  Agent-->>User: "Here are horror movies in London"
```

**Key property:** the vendor API key never leaves the backend; the browser only ever holds a short-lived, user-bound, rate-limited JWT.

## Purchase and refund (delegation + elicitation)

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Page as Page + WebMCP tools
  participant Agent as Frontend agent
  participant API as Backend /api/tickets
  participant BA as Backend agent /api/agent

  User->>Agent: "Book 2 tickets for The Quiet House tomorrow 8 PM"
  Agent->>Page: select_showtime, prefill_checkout
  Page-->>User: Checkout form prefilled (agent cannot buy)
  User->>API: Clicks Buy (session cookie)
  API-->>Page: Booking BK-XXXX confirmed

  User->>Agent: "Refund my Quiet House tickets"
  Agent->>BA: ask_backend_agent(task) (session cookie, zero trust)
  BA->>BA: list_my_bookings (scoped to session user)
  BA->>BA: refund_booking → needsApproval
  BA-->>Agent: elicitation {message, requestedSchema}
  Agent-->>User: Renders form (reason + confirm)
  User->>Agent: Accept / Decline
  Agent->>BA: POST /api/agent/elicitation (server-issued id only)
  BA->>BA: Refund executes (policy re-checked in code)
  BA-->>Agent: "Refunded $24"
  Agent-->>User: Relays answer
```
