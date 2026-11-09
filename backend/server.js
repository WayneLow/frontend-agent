// PoC server: one process, one port.
//
//   POST /login, /token, /proxy/v1/chat/completions   -> session, TVM, AI gateway (tvm.js)
//   GET/POST /api/tickets                               -> list / buy tickets (tickets.js)
//   POST /api/agent, /api/agent/elicitation             -> backend agent + elicitation (agent.js)
//   everything else                                     -> Vite dev middleware serving ../public

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { answerElicitation, ask } from './agent.js';
import { log, readJson, send } from './http.js';
import { buyTickets, listBookings } from './tickets.js';
import { getSession, handleLogin, handleProxy, handleToken, rateLimit } from './tvm.js';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

/** Wraps a session-authenticated JSON route. */
const withUser = (handler, { bucket, perMinute } = {}) => async (req, res) => {
  const session = getSession(req);
  if (!session) return send(res, 401, { error: 'not_logged_in' });
  if (bucket && rateLimit(bucket, session.userId, perMinute) === null) return send(res, 429, { error: 'rate_limited' });
  const body = req.method === 'POST' ? await readJson(req) : {};
  send(res, 200, await handler(session.userId, body));
};

const routes = {
  'POST /login': handleLogin,
  'POST /token': handleToken,
  'POST /proxy/v1/chat/completions': handleProxy,
  'GET /api/tickets': withUser((userId) => ({ bookings: listBookings(userId) })),
  'POST /api/tickets': withUser((userId, body) => {
    const booking = buyTickets(userId, body);
    log('tickets bought', userId, booking.id, `${booking.quantity}x ${booking.title}`);
    return { booking };
  }),
  'POST /api/agent': withUser(ask, { bucket: 'agent', perMinute: 10 }),
  'POST /api/agent/elicitation': withUser(answerElicitation, { bucket: 'agent', perMinute: 10 }),
};

const server = http.createServer();
const vite = await createVite({
  root: PUBLIC_DIR,
  appType: 'spa',
  server: { middlewareMode: true, hmr: { server } },
});

server.on('request', async (req, res) => {
  const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (!route) return vite.middlewares(req, res, () => send(res, 404, { error: 'not_found' }));
  try {
    await route(req, res);
  } catch (err) {
    log('error', err.message);
    send(res, err.status ?? 500, { error: err.status ? err.message : 'internal_error' });
  }
});

server.listen(PORT, () => {
  log(`PoC running on http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) log('WARNING: OPENAI_API_KEY not set; /proxy and /api/agent will fail until it is.');
});
