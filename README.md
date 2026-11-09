# Frontend Agent + Token Vending Machine PoC

Proves that an agent hosted **in the browser** can:
- drive WebMCP tools on the page,
- fall back to a cloud LLM using a **short-lived token vended by the backend** (the browser never holds a vendor key),
- hand booking and refund work to a **backend agent**, which can pause to ask the user for structured input (**elicitation**).

Both agents are built on the Vercel AI SDK v6.

- Decision record: [docs/adr/0001-frontend-agent-with-token-vending-machine.md](docs/adr/0001-frontend-agent-with-token-vending-machine.md)
- Architecture diagrams: [docs/architecture.md](docs/architecture.md)

## Run

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY and a JWT_SECRET
npm run dev            # API + Vite-served frontend on one port
open http://localhost:3000
```

## Demo script

1. **Page actions with the agent.** Ask: *"Book 2 tickets for The Boogeyman in London tomorrow at 8:00 PM for Jane Doe, jane@example.com"*.
   The agent filters, selects the showtime and prefills checkout, then stops. **You** click **Buy**.
2. **Delegation and elicitation.** Ask: *"I can no longer go, please refund my Boogeyman tickets"*.
   The frontend agent hands the task to the backend agent. The backend agent finds the booking and pauses, and a 🔐 form appears in the chat. Pick a reason, tick the confirmation and click **Confirm refund**, or click **Decline**.
3. Tick **Force cloud fallback** to show the TVM path even when Gemini Nano is available.

## What to look at

| Where | What it shows |
|---|---|
| Badge and "via …" under each reply | The exact model that answered (from the gateway response) or Gemini Nano |
| Model diagnostics | Prompt API presence, Gemini Nano status, how to fix it, and a download button |
| Trace panel | Capability check → JWT vended → `/proxy` calls → WebMCP tools → backend delegation → elicitation |
| Server console | Token, proxy, ticket, backend agent and elicitation events |
| DevTools → Network | The browser sends only `Bearer <JWT>`; the OpenAI key never appears |

## Layout

```
backend/server.js        Routing + Vite dev middleware
backend/tvm.js           POST /login (demo session), POST /token (TVM), POST /proxy/v1/chat/completions (AI gateway)
backend/tickets.js       Bookings store, purchase validation, refund policy (until 2h before the show)
backend/agent.js         Backend agent (AI SDK): list_my_bookings, refund_booking (needsApproval → elicitation)
public/cineflow-data.js  Original CineFlow catalogue (62 movies, poster URLs), copied verbatim
public/movies.js         Derived catalogue (14 days of showtimes), shared with the backend
public/webmcp.js         Tool registry (also registers with native document.modelContext when present)
public/app.js            CineFlow UI + WebMCP tools: update_location, query_content, select_showtime, prefill_checkout
public/agent.js          Frontend agent (AI SDK): Gemini Nano → TVM cloud fallback, ask_backend_agent, elicitation UI
```

## Guardrails

- **JWT:** HS256, 5-minute lifetime, bound to `sub`, `scope: inference` and the allowed models.
- **Quota and rate limits:** 50 tokens per user per day. 30 requests per minute per user at `/proxy`, and 10 per minute at `/api/agent`.
- **Gateway:** forwards only `messages` and `tools`; the server picks the model and the output-token cap.
- **Purchases:** only the user's **Buy** click purchases. The backend re-validates movie, showtime, quantity and email.
- **Backend agent:** the user comes from the session, every tool is scoped to that user, and the refund policy is enforced in code. Elicitations are tracked on the server and are single-use.
- **Rendering:** model output is shown with `textContent`, never `innerHTML`.

## Not in scope

- Real authentication. `/login` is a stand-in, and every visitor is `demo-user`.
- Persistent storage. Bookings, quotas and conversations are in memory and reset when the server restarts.
- Streaming responses, and a production build (`vite build`).

## Attribution

The CineFlow UI layout and movie data (`public/cineflow-data.js`, poster images on `lh3.googleusercontent.com`) come from
[GoogleChromeLabs/webmcp-tools `demos/ticket-booking`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/demos/ticket-booking),
Copyright 2026 Google LLC, licensed under Apache-2.0. Styling uses the Tailwind Play CDN, as the original does.
