// Frontend agent (Vercel AI SDK), the orchestrator that lives in the browser.
//
// Model selection (capability cascade):
//   1. On-device model: Chrome built-in AI (Gemini Nano) via @built-in-ai/core
//   2. Cloud fallback: OpenAI provider pointed at our AI Gateway (/proxy/v1), authorised
//      with a short-lived JWT from the Token Vending Machine
// Tools:
//   - WebMCP page tools run locally in the page
//   - ask_backend_agent delegates bookings/refunds to the backend agent, and relays
//     any elicitation it raises to the user as a form

import { createOpenAI } from '@ai-sdk/openai';
import { builtInAI } from '@built-in-ai/core';
import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { executeTool, hasNativeWebMCP, listTools } from './webmcp.js';

const MAX_STEPS = 8;
const NANO_OPTIONS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
const SYSTEM_PROMPT = `You are CineFlow's in-page assistant. You operate the page through the provided tools.
- Call query_content to see what's available before selecting a showtime.
- To buy tickets: select_showtime, then prefill_checkout. You cannot buy; tell the user to review and click Buy.
- You cannot see existing bookings. For anything about existing bookings, refunds or cancellations, call ask_backend_agent and relay its answer.
Reply in short plain text without markdown.
Today is ${new Date().toLocaleDateString('en-CA')}; tomorrow is ${new Date(Date.now() + 864e5).toLocaleDateString('en-CA')}.`;

const $ = (sel) => document.querySelector(sel);

// --- Trace panel (makes the end-to-end flow visible during the demo) ------------

function trace(kind, text) {
  const li = document.createElement('li');
  li.className = `trace-${kind}`;
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('#trace').prepend(li);
}

function chat(role, text, model) {
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.textContent = text; // never innerHTML model output
  if (model) {
    const meta = document.createElement('div');
    meta.className = 'msg-model';
    meta.textContent = `via ${model}`;
    div.append(meta);
  }
  $('#messages').append(div);
  div.scrollIntoView({ block: 'end' });
}

// --- Token Vending Machine client ------------------------------------------------

const tvm = {
  token: null,
  expiresAt: 0,

  async get() {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.expiresAt - now > 30) return this.token;
    const res = await fetch('/token', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(`Token vending failed: ${data.error}`);
    this.token = data.token;
    this.expiresAt = data.expiresAt;
    trace('token', `TVM vended JWT (expires in ${data.expiresAt - now}s, daily quota left: ${data.quotaRemaining})`);
    return this.token;
  },

  invalidate() {
    this.token = null;
  },
};

/** fetch used by the AI SDK OpenAI provider: swaps in the vended JWT and surfaces gateway errors. */
async function tvmFetch(url, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await tvm.get()}`);
    const started = performance.now();
    const res = await fetch(url, { ...init, headers });
    if (res.ok) {
      const data = await res.clone().json();
      diag.set('Cloud model', data.model);
      trace('net', `POST /proxy → ${data.model} in ${Math.round(performance.now() - started)}ms (${data.usage?.total_tokens ?? '?'} tokens)`);
      return res;
    }
    const data = await res.clone().json().catch(() => ({}));
    if (res.status === 401 && data.error === 'invalid_or_expired_token' && attempt === 0) {
      trace('warn', 'Gateway rejected token (expired?) → re-vending');
      tvm.invalidate();
      continue;
    }
    if (res.status === 429) throw new Error('Rate limited by the gateway (30 req/min). Wait a minute.');
    if (res.status === 502) throw new Error(`LLM provider returned ${data.upstreamStatus}. Check the backend log.`);
    return res;
  }
}

// --- Models ---------------------------------------------------------------------------

const gateway = createOpenAI({
  baseURL: `${location.origin}/proxy/v1`,
  apiKey: 'vended-per-request', // placeholder; tvmFetch replaces it with the JWT
  fetch: tvmFetch,
});

const MODELS = {
  cloud: { model: gateway.chat('chosen-by-gateway'), label: 'Cloud via TVM gateway' },
  local: { model: builtInAI('text', NANO_OPTIONS), label: 'On-device · Gemini Nano', name: 'Gemini Nano (Chrome built-in, on-device)' },
};

async function nanoAvailability() {
  if (!('LanguageModel' in self)) return 'no-api';
  try {
    return await LanguageModel.availability(NANO_OPTIONS);
  } catch (err) {
    return `error: ${err.message}`;
  }
}

// --- Delegation to the backend agent, with elicitation ------------------------------

let backendConversationId = null;

/** Renders an MCP-style elicitation (message + requestedSchema) and resolves with the user's answer. */
function elicit({ message, requestedSchema }) {
  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'msg msg-elicitation';
    const title = document.createElement('strong');
    title.textContent = '🔐 Backend agent needs your input';
    const text = document.createElement('p');
    text.textContent = message;
    form.append(title, text);

    for (const [key, prop] of Object.entries(requestedSchema.properties)) {
      const label = document.createElement('label');
      const required = requestedSchema.required?.includes(key);
      let input;
      if (prop.enum) {
        input = document.createElement('select');
        input.append(new Option('Choose…', ''), ...prop.enum.map((v) => new Option(v, v)));
      } else if (prop.type === 'boolean') {
        input = Object.assign(document.createElement('input'), { type: 'checkbox' });
      } else {
        input = document.createElement('input');
      }
      input.name = key;
      input.required = required;
      label.append(input, ` ${prop.title ?? key}`);
      form.append(label);
    }

    const actions = document.createElement('div');
    actions.className = 'elicitation-actions';
    const submit = Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Confirm refund', className: 'primary' });
    const decline = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Decline' });
    actions.append(submit, decline);
    form.append(actions);

    const finish = (answer) => {
      form.querySelectorAll('input, select, button').forEach((el) => { el.disabled = true; });
      form.classList.add('answered');
      trace('elicit', `User ${answer.action}ed elicitation${answer.content ? ` (${answer.content.reason})` : ''}`);
      resolve(answer);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const content = {};
      for (const [key, prop] of Object.entries(requestedSchema.properties)) {
        const el = form.elements[key];
        content[key] = prop.type === 'boolean' ? el.checked : el.value;
      }
      finish({ action: 'accept', content });
    };
    decline.onclick = () => finish({ action: 'decline' });

    $('#messages').append(form);
    form.scrollIntoView({ block: 'end' });
  });
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`Backend agent: ${data.error}`);
  return data;
}

async function askBackendAgent(task) {
  trace('delegate', `→ backend agent: "${task}"`);
  let reply = await postJson('/api/agent', { task, conversationId: backendConversationId });
  backendConversationId = reply.conversationId;
  while (reply.status === 'elicitation') {
    trace('elicit', `Backend agent (${reply.model}) requested elicitation: ${reply.elicitation.message}`);
    const answer = await elicit(reply.elicitation);
    reply = await postJson('/api/agent/elicitation', { conversationId: backendConversationId, elicitationId: reply.elicitation.id, ...answer });
  }
  trace('delegate', `← backend agent (${reply.model}): "${reply.text}"`);
  return { status: 'success', answer: reply.text, answered_by: reply.model };
}

// --- Tools ------------------------------------------------------------------------------

function buildTools() {
  const tools = {};
  for (const t of listTools()) {
    tools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: async (args) => {
        const result = await executeTool(t.name, args);
        trace('tool', `WebMCP ${t.name}(${JSON.stringify(args)}) → ${result.status}`);
        return result;
      },
    });
  }
  tools.ask_backend_agent = tool({
    description: 'Delegates a task to the secure backend agent, which can see and refund the user\'s existing bookings. Use for anything about existing bookings, refunds or cancellations. The user may be asked to confirm.',
    inputSchema: z.object({ task: z.string().describe('What the user wants, in plain language, including any booking id or movie they mentioned.') }),
    execute: async ({ task }) => askBackendAgent(task),
  });
  return tools;
}

// --- Diagnostics panel: why is (or isn't) the on-device model usable? -------------

const NANO_HINTS = {
  'no-api': `Chrome is not exposing the Prompt API (window.LanguageModel) to this page.
1. Open chrome://flags/#prompt-api-for-gemini-nano → Enabled.
2. Open chrome://flags/#optimization-guide-on-device-model → "Enabled BypassPerfRequirement" (useful on machines below spec).
3. Relaunch Chrome and click Re-check.
Model status and download logs are at chrome://on-device-internals.`,
  unavailable: `The API exists, but Chrome says this device or configuration can't run Gemini Nano.
Typical causes: under ~22 GB free disk on the Chrome profile volume, a GPU with 4 GB VRAM or less (and no CPU fallback: 16 GB RAM + 4 cores), or an unsupported OS.
Check chrome://on-device-internals → "Model Status" for the exact reason.`,
  downloadable: 'Chrome can run Gemini Nano but has not downloaded it yet. Click "Download Gemini Nano" (Chrome needs a user click to start; ~4 GB, unmetered connection).',
  downloading: 'Gemini Nano is downloading. Progress is shown below, and also at chrome://on-device-internals.',
  available: 'Gemini Nano is ready. Untick "Force cloud fallback" to use it.',
};

const diag = {
  set(key, value) {
    let row = document.querySelector(`#diag-list [data-key="${key}"]`);
    if (!row) {
      row = document.createElement('div');
      row.dataset.key = key;
      row.append(Object.assign(document.createElement('dt'), { textContent: key }), document.createElement('dd'));
      $('#diag-list').append(row);
    }
    row.querySelector('dd').textContent = value;
  },

  async refresh() {
    const brand = navigator.userAgentData?.brands?.find((b) => /Chrome/.test(b.brand));
    this.set('Browser', brand ? `${brand.brand} ${brand.version}` : navigator.userAgent);
    this.set('Native WebMCP', hasNativeWebMCP() ? 'yes (document.modelContext)' : 'no (in-page registry)');
    this.set('Prompt API', 'LanguageModel' in self ? 'present' : 'missing');
    const status = await nanoAvailability();
    this.set('Gemini Nano status', status);
    $('#diag-hint').textContent = NANO_HINTS[status] ?? `Unexpected status "${status}". See chrome://on-device-internals.`;
    $('#nano-download').hidden = !['downloadable', 'downloading'].includes(status);
    return status;
  },
};

$('#diag-recheck').onclick = async () => {
  const status = await diag.refresh();
  trace('info', `Re-checked on-device model: ${status}`);
  pickModel(true);
};

$('#nano-download').onclick = async () => {
  const progress = $('#nano-progress');
  progress.hidden = false;
  trace('info', 'Starting Gemini Nano download (user-initiated)');
  try {
    await MODELS.local.model.createSessionWithProgress((p) => {
      progress.value = p;
      diag.set('Download', `${Math.round(p * 100)}%`);
    });
    trace('local', 'Gemini Nano downloaded and ready');
  } catch (err) {
    trace('warn', `Gemini Nano download failed: ${err.message}`);
  }
  progress.hidden = true;
  $('#diag-recheck').click();
};

// --- Orchestrator --------------------------------------------------------------------------

const history = []; // ModelMessages shared across turns (and across model switches)
let current = null;

async function pickModel(announce = false) {
  const forceCloud = $('#force-cloud').checked;
  const status = await nanoAvailability();
  const next = !forceCloud && status === 'available' ? MODELS.local : MODELS.cloud;
  if (next !== current || announce) {
    trace('info', forceCloud
      ? 'Capability check skipped (forced) → cloud fallback via TVM'
      : `Capability check: Gemini Nano "${status}" → ${next === MODELS.local ? 'on-device' : 'cloud fallback via TVM'}`);
  }
  current = next;
  $('#provider').textContent = current.label;
  return current;
}

async function run(userText) {
  const { model, name } = await pickModel();
  history.push({ role: 'user', content: userText });
  const started = performance.now();
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: history,
    tools: buildTools(),
    stopWhen: stepCountIs(MAX_STEPS),
    maxRetries: 0,
  });
  history.push(...result.response.messages);
  const modelName = name ?? result.response.modelId;
  if (current === MODELS.local) trace('local', `Gemini Nano finished in ${Math.round(performance.now() - started)}ms (no network)`);
  $('#provider').textContent = current === MODELS.cloud ? `Cloud · ${modelName}` : current.label;
  return { text: result.text || 'Done.', model: modelName };
}

$('#chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chat('user', text);
  $('#chat-form').classList.add('busy');
  try {
    const { text: reply, model } = await run(text);
    chat('assistant', reply, model);
  } catch (err) {
    const message = err.cause?.message ?? err.message;
    trace('warn', message);
    chat('error', message);
  } finally {
    $('#chat-form').classList.remove('busy');
  }
};

$('#force-cloud').onchange = () => pickModel(true);

// Boot: establish the demo session (stands in for the app's real login), then probe.
await fetch('/login', { method: 'POST' });
trace('info', `Session established. Native WebMCP: ${hasNativeWebMCP() ? 'yes' : 'no (using in-page registry)'}`);
trace('info', `${listTools().length} WebMCP tools registered: ${listTools().map((t) => t.name).join(', ')} (+ ask_backend_agent)`);
diag.set('Cloud model', 'not called yet');
await diag.refresh();
pickModel(true);
