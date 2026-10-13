// Temporary loopback CONNECT bridge in front of ONE authenticated SOCKS5 upstream.
//
// Chromium cannot authenticate to a SOCKS5 proxy, so the browser is pointed at this loopback HTTP
// proxy, which opens every CONNECT through the configured upstream. There is no direct fallback:
// when the upstream refuses, the client gets 502 and nothing else is tried. The bridge owns every
// socket it creates and closes them all on close(), which is idempotent.
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadSocks() {
  for (const spec of ['socks', '/srv/betting/automation/node_modules/socks']) {
    try { return require(spec); } catch { /* next */ }
  }
  throw new Error('SOCKS_MODULE_UNAVAILABLE');
}

export async function startConnectBridge({
  upstream,
  allowedPorts = [80, 443],
  connectTimeoutMs = 15000,
  allowedHosts = null,
} = {}) {
  if (!upstream || typeof upstream.host !== 'string' || !Number.isInteger(upstream.port)) {
    throw new Error('BRIDGE_UPSTREAM_REQUIRED');
  }
  const { SocksClient } = loadSocks();
  const sockets = new Set();
  const stats = { connect_requests: 0, upstream_connections: 0, refused_port: 0, refused_host: 0, upstream_failures: 0 };
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const server = http.createServer((request, response) => { response.writeHead(405).end(); });
  server.on('connection', track);
  server.on('connect', async (request, client, head) => {
    stats.connect_requests += 1;
    client.on('error', () => {});
    try {
      const destination = new URL(`https://${request.url}`);
      const port = Number(destination.port || 443);
      if (!allowedPorts.includes(port)) { stats.refused_port += 1; throw new Error('PORT_REJECTED'); }
      if (Array.isArray(allowedHosts) && !allowedHosts.includes(destination.hostname)) { stats.refused_host += 1; throw new Error('HOST_REJECTED'); }
      const { socket } = await SocksClient.createConnection({
        command: 'connect',
        timeout: connectTimeoutMs,
        proxy: { host: upstream.host, port: upstream.port, type: 5, userId: upstream.username || undefined, password: upstream.password || undefined },
        destination: { host: destination.hostname, port },
      });
      stats.upstream_connections += 1;
      track(socket);
      if (client.destroyed) { socket.destroy(); return; }
      socket.on('error', () => client.destroy());
      client.on('close', () => socket.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    } catch {
      stats.upstream_failures += 1;
      try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* gone */ }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  let closed = false;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ ...stats, open_sockets: sockets.size }),
    get closed() { return closed; },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// Parses the private proxy config without ever returning or logging the credentials as text.
export function parseProxyUrl(value) {
  const url = new URL(String(value));
  return {
    scheme: url.protocol.replace(':', ''),
    host: url.hostname,
    port: Number(url.port),
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : '',
    endpoint: `${url.hostname}:${url.port}`,
  };
}
