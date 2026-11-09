// Tiny HTTP helpers shared by the route modules.

export function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

export async function readJson(req, limitBytes = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

export function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}
