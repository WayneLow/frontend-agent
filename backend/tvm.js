// Session, Token Vending Machine and AI Gateway.
//
//   POST /login                       -> demo session cookie (stands in for the real app login)
//   POST /token                       -> validates session + quota, vends a short-lived signed JWT
//   POST /proxy/v1/chat/completions   -> verifies JWT, rate-limits per user, attaches the vendor key,
//                                        forwards to OpenAI. The vendor key never leaves this process.

import crypto from 'node:crypto';
import { log, readJson, send } from './http.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const JWT_SECRET = process.env.JWT_SECRET ?? crypto.randomBytes(32).toString('hex');

const TOKEN_TTL_SECONDS = 5 * 60;
const TOKENS_PER_USER_PER_DAY = 50; // "billing quota" for the demo
const REQUESTS_PER_MINUTE = 30; // gateway rate limit (one agent task is ~3-6 model calls)
const MAX_OUTPUT_TOKENS = 1024;

// --- In-memory state (a real deployment would use Redis / a DB) -------------

const sessions = new Map(); // sid -> { userId }
const tokensIssued = new Map(); // `${userId}:${yyyy-mm-dd}` -> count
const requestLog = new Map(); // `${bucket}:${userId}` -> [timestamps]

// --- JWT (HS256) --------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  const [header, body, sig] = token?.split('.') ?? [];
  if (!header || !body || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (claims.scope !== 'inference') return null;
  return claims;
}

// --- Shared guards ---------------------------------------------------------------

export function getSession(req) {
  const sid = req.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  return sid ? sessions.get(sid) : undefined;
}

/** Sliding 60s window per user and bucket. Returns the count, or null when over the limit. */
export function rateLimit(bucket, userId, perMinute = REQUESTS_PER_MINUTE) {
  const key = `${bucket}:${userId}`;
  const now = Date.now();
  const recent = (requestLog.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) {
    requestLog.set(key, recent);
    return null;
  }
  recent.push(now);
  requestLog.set(key, recent);
  return recent.length;
}

// --- Routes --------------------------------------------------------------------

export function handleLogin(req, res) {
  // Demo only: every visitor becomes "demo-user". Replace with the real auth session.
  const sid = crypto.randomBytes(16).toString('hex');
  sessions.set(sid, { userId: 'demo-user' });
  log('login', 'demo-user');
  send(res, 200, { userId: 'demo-user' }, {
    'set-cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/`,
  });
}

export function handleToken(req, res) {
  // 1. Validate the user's session.
  const session = getSession(req);
  if (!session) return send(res, 401, { error: 'not_logged_in' });

  // 2. Check billing / usage quota.
  const quotaKey = `${session.userId}:${new Date().toISOString().slice(0, 10)}`;
  const issued = tokensIssued.get(quotaKey) ?? 0;
  if (issued >= TOKENS_PER_USER_PER_DAY) return send(res, 402, { error: 'quota_exhausted' });
  tokensIssued.set(quotaKey, issued + 1);

  // 3. Vend a short-lived, user-bound JWT (NOT a vendor key).
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: session.userId,
    scope: 'inference',
    models: [OPENAI_MODEL],
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
  log('token vended', claims.sub, `jti=${claims.jti.slice(0, 8)}`, `quota=${issued + 1}/${TOKENS_PER_USER_PER_DAY}`);
  send(res, 200, { token: signJwt(claims), expiresAt: claims.exp, quotaRemaining: TOKENS_PER_USER_PER_DAY - issued - 1 });
}

export async function handleProxy(req, res) {
  // 1. Verify the vended JWT.
  const claims = verifyJwt(req.headers.authorization?.replace(/^Bearer /, ''));
  if (!claims) return send(res, 401, { error: 'invalid_or_expired_token' });

  // 2. Per-user rate limit.
  const count = rateLimit('proxy', claims.sub);
  if (count === null) return send(res, 429, { error: 'rate_limited' }, { 'retry-after': '60' });

  if (!OPENAI_API_KEY) return send(res, 503, { error: 'OPENAI_API_KEY not configured on the backend' });

  // 3. Only forward an allow-listed shape; the server decides model and limits.
  const body = await readJson(req);
  const upstreamBody = {
    model: claims.models[0],
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tools?.length ? body.tool_choice ?? 'auto' : undefined,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    user: claims.sub,
  };

  // 4. Attach the hidden vendor key server-side and forward.
  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(upstreamBody),
  });
  const data = await upstream.json();
  log('proxy', claims.sub, `status=${upstream.status}`, `model=${data.model ?? '?'}`, `rate=${count}/${REQUESTS_PER_MINUTE}`,
    data.usage ? `tokens=${data.usage.total_tokens}` : '');

  // Upstream failures stay server-side: a vendor 401 must not look like our JWT
  // being rejected, and vendor error details are not the client's business.
  if (!upstream.ok) {
    log('upstream error', upstream.status, data.error?.message ?? '');
    return send(res, 502, { error: 'upstream_error', upstreamStatus: upstream.status });
  }
  send(res, 200, data);
}
