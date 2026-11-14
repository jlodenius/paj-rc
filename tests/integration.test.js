import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../src/daemon.js';
import { createSessionAdapter } from '../src/session.js';
import { createConnector } from '../src/connector.js';

async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await delay(10);
  }
  throw new Error('Condition timed out');
}

function liveSession(name) {
  const identity = { id: randomUUID(), piSessionId: randomUUID(), pid: process.pid,
    name, projectRoot: `/projects/${name}`, role: 'primary', parentPiSessionId: null };
  const handlers = new Map();
  const entries = [{ type: 'message', id: randomUUID(), message: { role: 'user', content: 'Existing terminal prompt' } }];
  let idle = true;
  let stopped = 0;
  const reservations = new Set();
  const ctx = { mode: 'tui', hasUI: true, model: { input: ['text', 'image'] },
    isIdle: () => idle, abort: () => { stopped++; },
    sessionManager: { getSessionId: () => identity.piSessionId, getBranch: () => entries } };
  const submitted = [];
  const pi = { on(event, callback) {
    const listeners = handlers.get(event) ?? new Set();
    listeners.add(callback);
    handlers.set(event, listeners);
    return () => listeners.delete(callback);
  }, sendUserMessage(text, options) { submitted.push({ text, options }); } };
  const paj = { version: 1, getSnapshot: () => ({ identity, editorBusy: false }),
    tryReserve: token => {
      if (reservations.has(token)) return true;
      if (reservations.size) return false;
      reservations.add(token); return true;
    }, release: token => reservations.delete(token) };
  const adapter = createSessionAdapter({ pi, ctx, paj, env: {} });
  return { identity, adapter, submitted, get stopped() { return stopped; },
    setModel(input) { ctx.model = { input }; this.emit('model_select'); },
    emit(event, data = {}) {
      if (event === 'agent_start') idle = false;
      if (event === 'agent_settled') idle = true;
      for (const callback of handlers.get(event) ?? []) callback(data, ctx);
      if (event === 'message_end') entries.push({ type: 'message', id: randomUUID(), message: data.message });
    } };
}

test('two live adapters expose separate chats, keep work alive on browser loss, and reconnect after daemon restart', async t => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-rc-integration-'));
  const paths = { runtimeDir, socketPath: join(runtimeDir, 'rc.sock') };
  const config = { port: 0, allowedOrigins: [], idleTimeoutMs: 10000,
    pairingKey: randomBytes(32).toString('base64url') };
  const first = liveSession('backend');
  const second = liveSession('website');
  const listSessions = async () => [first.identity, second.identity];
  let daemon = await startDaemon(config, { paths, listSessions });
  const connectors = [first, second].map(session => createConnector({ adapter: session.adapter,
    socketPath: paths.socketPath, ensureService: async () => true, retryInitialMs: 10, retryMaxMs: 20 }));
  for (const connector of connectors) connector.start();
  t.after(async () => {
    for (const connector of connectors) connector.close();
    first.adapter.close(); second.adapter.close();
    await daemon.close();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const login = async () => {
    const response = await fetch(`${daemon.address}/api/login`, { method: 'POST',
      headers: { Origin: daemon.address, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: config.pairingKey }) });
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await response.json();
    return { Cookie: cookie, Origin: daemon.address, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' };
  };
  let headers = await login();
  const sessions = () => fetch(`${daemon.address}/api/sessions`, { headers }).then(response => response.json());
  await until(async () => (await sessions()).sessions.length === 2);
  const route = `/api/sessions/${first.identity.id}`;
  const snapshot = await (await fetch(`${daemon.address}${route}/snapshot`, { headers })).json();
  assert.equal(snapshot.messages[0].text, 'Existing terminal prompt');
  const input = { generation: snapshot.generation, requestId: randomUUID(), text: 'Investigate backend', deliverAs: 'reject' };
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${daemon.address}${route}/prompt`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
  }
  assert.equal(first.submitted.length, 1);
  assert.equal(second.submitted.length, 0);
  first.emit('agent_start');
  const controller = new AbortController();
  const events = await fetch(`${daemon.address}/api/events`, { headers, signal: controller.signal });
  const reader = events.body.getReader();
  await reader.read();
  controller.abort();
  first.emit('message_start', { message: { role: 'assistant', content: [] } });
  first.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Still working' } });
  await daemon.close();
  assert.equal(first.stopped, 0);
  daemon = await startDaemon(config, { paths, listSessions });
  headers = await login();
  await until(async () => (await sessions()).sessions.length === 2);
  const resumed = await (await fetch(`${daemon.address}${route}/snapshot`, { headers })).json();
  assert.equal(resumed.messages.at(-1).text, 'Still working');
  assert.equal(resumed.state.busy, true);
  assert.equal(first.submitted.length, 1);
  for (const text of ['First steering instruction', 'Second steering instruction']) {
    const response = await fetch(`${daemon.address}${route}/prompt`, { method: 'POST', headers,
      body: JSON.stringify({ generation: resumed.generation, requestId: randomUUID(),
        text, deliverAs: 'steer' }) });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(first.submitted.slice(1).map(input => input.text),
    ['First steering instruction', 'Second steering instruction']);
  assert.equal(second.submitted.length, 0);
  const image = { mimeType: 'image/png', data: (await readFile(
    new URL('../public/icons/icon-192.png', import.meta.url))).toString('base64') };
  const photoInput = { generation: resumed.generation, requestId: randomUUID(),
    text: '', images: [image], deliverAs: 'steer' };
  const photo = await fetch(`${daemon.address}${route}/image-prompt`, { method: 'POST', headers,
    body: JSON.stringify(photoInput) });
  assert.equal(photo.status, 200);
  assert.deepEqual(first.submitted.at(-1).text, [{ type: 'image', ...image }]);
  first.emit('message_end', { message: { role: 'user', content: [{ type: 'image', ...image }] } });
  const photoHistory = await (await fetch(`${daemon.address}${route}/snapshot`, { headers })).json();
  const sentPhoto = photoHistory.messages.find(message => message.imageCount === 1);
  assert.ok(sentPhoto);
  assert.equal(sentPhoto.text, '[Image attached]');
  assert.equal(JSON.stringify(photoHistory).includes(image.data), false);
  first.setModel(['text']);
  await until(async () => (await sessions()).sessions.find(session => session.id === first.identity.id)
    ?.state.supportsImages === false);
  const replay = await fetch(`${daemon.address}${route}/image-prompt`, { method: 'POST', headers,
    body: JSON.stringify(photoInput) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal(first.submitted.length, 4);
  const unsupported = await fetch(`${daemon.address}${route}/image-prompt`, { method: 'POST', headers,
    body: JSON.stringify({ ...photoInput, requestId: randomUUID() }) });
  assert.equal(unsupported.status, 409);
  assert.equal(first.submitted.length, 4);
  const stale = await fetch(`${daemon.address}${route}/abort`, { method: 'POST', headers,
    body: JSON.stringify({ generation: snapshot.generation, runId: 'old-run' }) });
  assert.equal(stale.status, 409);
  const stop = await fetch(`${daemon.address}${route}/abort`, { method: 'POST', headers,
    body: JSON.stringify({ generation: resumed.generation, runId: resumed.state.runId }) });
  assert.equal(stop.status, 200);
  assert.equal(first.stopped, 1);
});
