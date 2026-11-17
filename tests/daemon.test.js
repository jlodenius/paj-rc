import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { startDaemon } from '../dist/src/daemon.js';

async function fixture(t, options = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-rc-test-'));
  const config = { version: 1, port: 0, idleTimeoutMs: options.idleTimeoutMs ?? 10000, allowedOrigins: [],
    pairingKey: randomBytes(32).toString('base64url'), pajCommand: '/not-used' };
  const daemon = await startDaemon(config, { paths: { runtimeDir, socketPath: join(runtimeDir, 'rc.sock') },
    listSessions: async () => [], startupGraceMs: 0, ...options });
  t.after(async () => { await daemon.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const origin = daemon.address;
  const request = (path, init = {}) => fetch(`${origin}${path}`, {
    ...init, headers: { Origin: origin, ...init.headers },
  });
  return { config, daemon, request, origin };
}

async function pair(request, key) {
  const response = await request('/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await response.json();
  return { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' };
}

async function endpoint(t, path, identity, options = {}) {
  const socket = createConnection(path);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  let buffer = '';
  socket.on('data', data => {
    buffer += data.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame.type === 'registered') socket.emit('registered');
      if (frame.type === 'request') {
        options.onRequest?.(frame);
        if (frame.method === 'prompt' && frame.params.images?.length && options.supportsImages === false) {
          socket.write(JSON.stringify({ type: 'response', id: frame.id, ok: false,
            error: { code: 'images_unsupported', message: 'The selected Pi model does not support images' } }) + '\n');
          continue;
        }
        socket.write(JSON.stringify({ type: 'response', id: frame.id, ok: true,
          result: frame.method === 'snapshot' ? { sessionId: identity.piSessionId,
            generation: options.generation ?? 'generation-1', seq: 0,
            state: { busy: false, runId: null, editorBusy: false, terminalRequired: false },
            messages: [{ id: 'm1', role: 'assistant', text: 'Live reply' }], hasMore: false, before: null } :
            { status: 'submitted', requestId: frame.params.requestId } }) + '\n');
      }
    }
  });
  socket.write(JSON.stringify({ type: 'register', protocol: 1, identity,
    generation: options.generation ?? 'generation-1',
    state: { busy: false, runId: null, editorBusy: false, terminalRequired: false,
      ...(options.supportsImages === undefined ? {} : { supportsImages: options.supportsImages }) } }) + '\n');
  return socket;
}

test('browser must pair before accessing sessions and use CSRF protection for writes', async t => {
  const { config, request } = await fixture(t);
  assert.equal((await request('/api/sessions')).status, 401);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: config.pairingKey }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  const { csrfToken } = await login.json();
  const remembered = await request('/api/sessions', { headers: { Cookie: cookie } });
  assert.equal(remembered.status, 200);
  assert.match(remembered.headers.get('set-cookie'), /Max-Age=34560000/);
  assert.equal((await request('/api/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  const logout = await request('/api/logout', { method: 'POST', headers: {
    Cookie: cookie, 'X-CSRF-Token': csrfToken } });
  assert.equal(logout.status, 200);
  assert.equal((await request('/api/sessions', { headers: { Cookie: cookie } })).status, 401);
});

test('image attachments require an explicitly capable adapter and forward only normalized payloads', async t => {
  const identity = { id: randomUUID(), piSessionId: randomUUID(), pid: process.pid,
    name: 'Images', role: 'primary', parentPiSessionId: null };
  const { daemon, config, request } = await fixture(t, { listSessions: async () => [identity] });
  const frames = [];
  const socket = await endpoint(t, daemon.socketPath, identity,
    { supportsImages: true, onRequest: frame => frames.push(frame) });
  await once(socket, 'registered');
  const headers = await pair(request, config.pairingKey);
  const image = { mimeType: 'image/png', data: readFileSync(
    new URL('../dist/public/icons/icon-192.png', import.meta.url)).toString('base64') };
  const input = { generation: 'generation-1', requestId: randomUUID(), text: '', deliverAs: 'steer',
    images: [{ ...image, url: 'not-forwarded' }] };
  const path = `/api/sessions/${identity.id}/prompt`;
  const send = (body, overrides = {}) => request(path, { method: 'POST', headers,
    body: JSON.stringify(body), ...overrides });
  assert.equal((await send(input)).status, 200);
  assert.deepEqual(frames.at(-1).params, { ...input, images: [image] });
  assert.equal((await send({ ...input, padding: 'x'.repeat(200 * 1024) })).status, 200);
  assert.equal((await send({ ...input, padding: 'x'.repeat(1536 * 1024) })).status, 413);
  assert.equal((await send({ ...input, images: [{ ...image, data: 'bad' }] })).status, 400);
  assert.equal((await send({ ...input, images: [], text: '' })).status, 400);
  assert.equal((await send({ ...input, images: [], text: 'x'.repeat(16001) })).status, 400);
  assert.equal((await send({ ...input, padding: 'x'.repeat(1536 * 1024) },
    { headers: { Origin: daemon.address, 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await send({ ...input, padding: 'x'.repeat(1536 * 1024) },
    { headers: { ...headers, 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await request(`/api/sessions/${identity.id}/abort`, { method: 'POST', headers,
    body: JSON.stringify({ generation: 'generation-1', runId: 'run', padding: 'x'.repeat(129 * 1024) }) })).status, 413);
  assert.equal((await request('/api/login', { method: 'POST', headers,
    body: JSON.stringify({ key: config.pairingKey, padding: 'x'.repeat(129 * 1024) }) })).status, 413);
});

test('image prompts fail closed for older adapters and models without image support', async t => {
  for (const supportsImages of [undefined, false]) {
    const identity = { id: randomUUID(), piSessionId: randomUUID(), pid: process.pid,
      name: 'No images', role: 'primary', parentPiSessionId: null };
    const { daemon, config, request } = await fixture(t, { listSessions: async () => [identity] });
    const frames = [];
    const socket = await endpoint(t, daemon.socketPath, identity,
      { supportsImages, onRequest: frame => frames.push(frame) });
    await once(socket, 'registered');
    const headers = await pair(request, config.pairingKey);
    const response = await request(`/api/sessions/${identity.id}/prompt`, { method: 'POST', headers,
      body: JSON.stringify({ generation: 'generation-1', requestId: randomUUID(), text: '', deliverAs: 'steer',
        images: [{ mimeType: 'image/png', data: readFileSync(
          new URL('../dist/public/icons/icon-192.png', import.meta.url)).toString('base64') }] }) });
    assert.equal(response.status, 409);
    const data = await response.json();
    assert.equal(data.error.code, 'images_unsupported');
    assert.match(data.error.message, supportsImages === false ? /model does not support/ : /Reload the Pi extension/);
    assert.equal(frames.length, supportsImages === false ? 1 : 0);
  }
});

test('idle service closes itself rather than leaving an unavailable listener running', async t => {
  let resolveIdle;
  const idle = new Promise(resolve => { resolveIdle = resolve; });
  const { request } = await fixture(t, { idleTimeoutMs: 30, onIdle: resolveIdle });
  await idle;
  await assert.rejects(() => request('/api/auth'));
});

test('browser sees only validated main endpoints and can read and prompt a live session', async t => {
  const identity = { id: randomUUID(), piSessionId: randomUUID(), pid: process.pid,
    name: 'Backend', projectRoot: '/projects/backend', role: 'primary', parentPiSessionId: null };
  const { daemon, config, request } = await fixture(t, { listSessions: async () => [identity] });
  const socket = await endpoint(t, daemon.socketPath, identity);
  await once(socket, 'registered');
  const headers = await pair(request, config.pairingKey);
  const sessions = await (await request('/api/sessions', { headers })).json();
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].name, 'Backend');
  const snapshot = await (await request(`/api/sessions/${identity.id}/snapshot`, { headers })).json();
  assert.equal(snapshot.messages[0].text, 'Live reply');
  const prompt = await request(`/api/sessions/${identity.id}/prompt`, { method: 'POST', headers,
    body: JSON.stringify({ generation: 'generation-1', requestId: randomUUID(), text: 'Run tests', deliverAs: 'reject' }) });
  assert.equal(prompt.status, 200);
  assert.equal((await prompt.json()).status, 'submitted');
  const child = await endpoint(t, daemon.socketPath, { ...identity, id: randomUUID(), role: 'subagent',
    parentPiSessionId: identity.piSessionId });
  await once(child, 'close');
  assert.equal((await (await request('/api/sessions', { headers })).json()).sessions.length, 1);
});
