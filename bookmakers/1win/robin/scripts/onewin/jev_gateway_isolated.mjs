// An ISOLATED instance of the Jev gateway for integration checks: the REAL function source of
// dev:/srv/jev/netlify/functions/jev.ts (auth, content-type, size and question validation, answer
// mapping) behind a plain HTTP server, with the TypeSafe SDK replaced by a local stub so that no model,
// no Netlify account and no credential is involved. Needs Node >= 22.6 (--experimental-strip-types).
//
//   node --experimental-strip-types jev_gateway_isolated.mjs --source <jev.ts> --token <t> [--mode ok|api502|sdk_error]
// prints {"port": N} on stdout and serves POST /api/jev until killed.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const source = arg('source');
const token = arg('token', 'isolated-test-token');
const mode = arg('mode', 'ok');
if (!source) throw new Error('--source is required');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-isolated-'));
fs.mkdirSync(path.join(dir, 'netlify/functions'), { recursive: true });
fs.mkdirSync(path.join(dir, 'node_modules/@typesafe-ai/sdk'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
fs.writeFileSync(path.join(dir, 'node_modules/@typesafe-ai/sdk/package.json'),
  JSON.stringify({ name: '@typesafe-ai/sdk', type: 'module', main: 'index.js', exports: './index.js' }));
fs.writeFileSync(path.join(dir, 'node_modules/@typesafe-ai/sdk/index.js'), `
export class APIError extends Error { constructor(message, status = 502, body = null) { super(message); this.status = status; this.body = body; } }
export class TypeSafeError extends Error {}
export const choice = (prompt, options) => ({ type: 'choice', prompt, options });
export const noul = (prompt, criteria) => ({ type: 'noul', prompt, criteria });
export const score = (prompt, levels) => ({ type: 'score', prompt, levels });
export class TypeSafeClient {
  async systemOne({ state, questions }) {
    const MODE = ${JSON.stringify(mode)};
    if (MODE === 'api502') throw new APIError('upstream unavailable token=abc123', 502, { error: 'upstream unavailable' });
    if (MODE === 'sdk_error') throw new TypeSafeError('questions rejected by sdk');
    const answers = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const keys = Object.keys(q.options);
        const pick = keys.includes('INVESTIGATE') ? 'INVESTIGATE' : keys[0];
        answers[name] = { type: 'choice', choice: pick, confidence: 0.91, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.91 : 0.09 / Math.max(1, keys.length - 1)])) };
      } else if (q.type === 'noul') answers[name] = { type: 'noul', noul: 0.5 };
      else answers[name] = { type: 'score', score: 1, confidence: 0.5, legend: Object.fromEntries(q.levels.map((l, i) => [String(i), String(l)])), probabilities: {} };
    }
    return { answers, model: 'jev-1.13.0', usage: { input_tokens: JSON.stringify(state ?? null).length, output_tokens: 1 } };
  }
}
`);
fs.copyFileSync(source, path.join(dir, 'netlify/functions/jev.ts'));
process.env.JEV_PROXY_TOKEN = token;
const handler = (await import(pathToFileURL(path.join(dir, 'netlify/functions/jev.ts')).href)).default;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/api/jev') { res.statusCode = 404; res.end('not found'); return; }
  const request = new Request(`http://localhost${url.pathname}`, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const response = await handler(request, {});
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port, mode })}\n`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }); setTimeout(() => process.exit(0), 500); });
}
