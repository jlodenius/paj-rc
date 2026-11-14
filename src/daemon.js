import { createServer } from 'node:http';
import { createAuth } from './auth.js';
import { validateImages } from './images.js';
import { startBroker } from './broker.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);
const publicRoot = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/state.js', ['state.js', 'text/javascript; charset=utf-8']],
  ['/paths.js', ['paths.js', 'text/javascript; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['/images.js', ['images.js', 'text/javascript; charset=utf-8']],
  ['/image-limits.js', ['image-limits.js', 'text/javascript; charset=utf-8']],
  ['/fonts/fira-code-latin.woff2', ['fonts/fira-code-latin.woff2', 'font/woff2']],
  ['/fonts/space-grotesk-latin.woff2', ['fonts/space-grotesk-latin.woff2', 'font/woff2']],
  ['/fonts/firacode-OFL.txt', ['fonts/firacode-OFL.txt', 'text/plain; charset=utf-8']],
  ['/fonts/spacegrotesk-OFL.txt', ['fonts/spacegrotesk-OFL.txt', 'text/plain; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icons/icon-192.png', ['icons/icon-192.png', 'image/png']],
  ['/icons/icon-512.png', ['icons/icon-512.png', 'image/png']],
  ['/icons/apple-touch-icon.png', ['icons/apple-touch-icon.png', 'image/png']],
]);

function json(response, status, data, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(data));
}

function fail(response, status, code, message) {
  json(response, status, { error: { code, message } });
}

async function body(request, limit = 128 * 1024) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw Object.assign(new Error('Expected application/json'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('Invalid JSON object'), { status: 400 });
  }
}

export async function startDaemon(config, options = {}) {
  const auth = createAuth(config.pairingKey, {
    file: join(options.paths.configDir ?? options.paths.runtimeDir, 'browser-sessions.json'),
  });
  let address;
  let allowed;
  let attempts = [];
  let writes = [];
  let closing = false;
  let idleTimer;
  const streams = new Set();
  const publish = (name, data) => {
    const record = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of streams) {
      if (client.response.destroyed || client.response.writableEnded) streams.delete(client);
      else if (!client.response.write(record)) client.response.destroy();
    }
  };
  let registryPending;
  const listSessions = options.listSessions ?? (() => {
    if (!registryPending) {
      registryPending = exec(config.pajCommand, ['--json', 'session', 'list', '--all'], {
        timeout: 4000, maxBuffer: 4 * 1024 * 1024,
      }).then(result => JSON.parse(result.stdout)).finally(() => { registryPending = undefined; });
    }
    return registryPending;
  });
  let broker;
  let controller;
  const scheduleIdle = (size, timeout = config.idleTimeoutMs) => {
    clearTimeout(idleTimer);
    if (size || closing) return;
    idleTimer = setTimeout(() => {
      if (!closing && broker.size === 0) {
        closing = true;
        controller.close().then(() => options.onIdle?.()).catch(error => {
          console.error('paj-rc idle shutdown failed:', error.message);
        });
      }
    }, timeout);
    idleTimer.unref();
  };
  broker = await startBroker({ paths: options.paths, listSessions, onEvent: publish,
    onMembership: scheduleIdle, ...options.brokerOptions });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' blob:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const hosts = new Set([...allowed].map(origin => new URL(origin).host));
    const origin = request.headers.origin;
    if (!hosts.has(request.headers.host) || (origin && (!allowed.has(origin) ||
        new URL(origin).host !== request.headers.host))) {
      return fail(response, 403, 'origin', 'Host or origin is not allowed');
    }
    if (!['GET', 'HEAD'].includes(request.method) && !origin) {
      return fail(response, 403, 'origin', 'An allowed Origin header is required');
    }
    const secure = [...allowed].some(value => value.startsWith('https://') &&
      new URL(value).host === request.headers.host);
    let url;
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192) {
        return fail(response, 400, 'invalid', 'Invalid request target');
      }
      url = new URL(request.url, address);
    } catch { return fail(response, 400, 'invalid', 'Invalid request target'); }
    const path = url.pathname;
    try {
      if (request.method === 'GET' && assets.has(path)) {
        const [filename, mime] = assets.get(path);
        const content = await readFile(new URL(filename, publicRoot));
        if (path === '/sw.js') response.setHeader('Service-Worker-Allowed', '/');
        response.writeHead(200, { 'Content-Type': mime });
        response.end(content);
        return;
      }
      const session = auth.read(request);
      if (session) response.setHeader('Set-Cookie', auth.refresh(session, secure));
      if (request.method === 'GET' && path === '/api/auth') {
        return json(response, 200, session ? { authenticated: true, csrfToken: session.csrfToken } :
          { authenticated: false });
      }
      if (request.method === 'POST' && path === '/api/login') {
        attempts = attempts.filter(time => Date.now() - time < 60000);
        if (attempts.length >= 10) return fail(response, 429, 'rate_limit', 'Too many pairing attempts; wait a minute');
        attempts.push(Date.now());
        const input = await body(request);
        const login = auth.login(input.key, secure);
        if (!login) return fail(response, 401, 'unauthorized', 'Invalid pairing key');
        return json(response, 200, { csrfToken: login.csrfToken }, { 'Set-Cookie': login.cookie });
      }
      if (!session) return fail(response, 401, 'unauthorized', 'Pair this browser first');
      if (!['GET', 'HEAD'].includes(request.method) && !auth.verifyCsrf(session, request.headers['x-csrf-token'])) {
        return fail(response, 403, 'csrf', 'Invalid CSRF token');
      }
      if (request.method === 'POST' && path === '/api/logout') {
        const cookie = auth.logout(session, secure);
        for (const client of streams) if (client.token === session.token) client.response.end();
        return json(response, 200, {}, { 'Set-Cookie': cookie });
      }
      if (closing) return fail(response, 503, 'stopping', 'Service is stopping; reconnect shortly');
      if (request.method === 'GET' && path === '/api/sessions') {
        return json(response, 200, { sessions: broker.list(), imageUploads: true });
      }
      if (request.method === 'GET' && path === '/api/events') {
        if (streams.size >= 32) return fail(response, 429, 'overloaded', 'Too many live browser connections');
        response.writeHead(200, { 'Content-Type': 'text/event-stream',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('event: resync\ndata: {}\n\n');
        const client = { response, token: session.token, expires: session.expires };
        streams.add(client);
        response.on('close', () => streams.delete(client));
        response.on('error', () => { streams.delete(client); response.destroy(); });
        return;
      }
      const route = path.match(/^\/api\/sessions\/([a-zA-Z0-9-]{1,128})\/(snapshot|prompt|image-prompt|abort)$/);
      if (route && request.method === 'GET' && route[2] === 'snapshot') {
        const before = url.searchParams.get('before');
        if (before && before.length > 128) return fail(response, 400, 'invalid', 'Invalid history cursor');
        return json(response, 200, await broker.request(route[1], 'snapshot', { before }));
      }
      if (route && request.method === 'POST' && ['prompt', 'image-prompt', 'abort'].includes(route[2])) {
        const method = route[2] === 'image-prompt' ? 'prompt' : route[2];
        writes = writes.filter(time => Date.now() - time < 60000);
        if (writes.length >= 120) return fail(response, 429, 'rate_limit', 'Too many control requests');
        writes.push(Date.now());
        const input = await body(request, method === 'prompt' ? 1536 * 1024 : 128 * 1024);
        if (typeof input.generation !== 'string' || !input.generation || input.generation.length > 128) {
          return fail(response, 400, 'invalid', 'A current session generation is required');
        }
        let params;
        if (method === 'prompt') {
          const images = validateImages(input.images);
          if (typeof input.text !== 'string' || (!input.text.trim() && !images.length) || input.text.length > 16000 ||
              typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(input.requestId) ||
              !['reject', 'steer', 'followUp'].includes(input.deliverAs)) {
            return fail(response, 400, 'invalid', 'Invalid prompt or explicit delivery mode');
          }
          if (images.length) {
            const target = broker.list().find(session => session.id === route[1]);
            if (target && typeof target.state.supportsImages !== 'boolean') {
              return fail(response, 409, 'images_unsupported', 'Reload the Pi extension before sending images');
            }
          }
          params = { generation: input.generation, requestId: input.requestId,
            text: input.text, deliverAs: input.deliverAs,
            ...(images.length ? { images } : {}) };
        } else {
          if (typeof input.runId !== 'string' || !input.runId || input.runId.length > 128) {
            return fail(response, 400, 'invalid', 'A current run ID is required');
          }
          params = { generation: input.generation, runId: input.runId };
        }
        return json(response, 200, await broker.request(route[1], method, params));
      }
      fail(response, 404, 'not_found', 'Not found');
    } catch (error) {
      if (!response.headersSent) fail(response, error.status ?? 500, error.code ?? 'request_failed',
        error.status ? error.message : 'Request failed');
      else response.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await broker.close();
    throw error;
  }
  server.on('error', () => {});
  address = `http://127.0.0.1:${server.address().port}`;
  allowed = new Set(config.port === 0
    ? [address, `http://localhost:${server.address().port}`, ...config.allowedOrigins]
    : config.allowedOrigins);
  scheduleIdle(0, Math.max(config.idleTimeoutMs, options.startupGraceMs ?? 5000));
  const keepalive = setInterval(() => {
    for (const client of streams) {
      if (client.response.destroyed || client.response.writableEnded) streams.delete(client);
      else if (client.expires !== null && Date.now() > client.expires) client.response.end();
      else if (!client.response.write(': heartbeat\n\n')) client.response.destroy();
    }
  }, options.keepaliveIntervalMs ?? 10000);
  keepalive.unref();
  let closePromise;
  controller = {
    address, socketPath: options.paths.socketPath,
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearTimeout(idleTimer);
        clearInterval(keepalive);
        for (const client of streams) client.response.end();
        server.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), broker.close()]);
      })();
      return closePromise;
    },
  };
  return controller;
}
