import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnector } from '../src/connector.js';

async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Condition did not become true');
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'paj-rc-connector-'));
  const socketPath = join(directory, 'socket');
  const sockets = new Set();
  const frames = [];
  let subscribed;
  let eligible = options.eligible ?? true;
  let ensured = 0;
  let prompts = 0;
  let closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        frames.push(frame);
        if (frame.type === 'register' && options.ack !== false) {
          socket.write(JSON.stringify({ type: 'registered', protocol: options.protocol ?? 1 }) + '\n');
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const adapter = { generation: 'generation', identity: { id: 'paj' },
    eligible: () => eligible, state: () => ({ busy: false }),
    subscribe(fn) { subscribed = fn; return () => { subscribed = undefined; }; },
    prompt() { prompts++; return { status: 'submitted' }; },
    snapshot() { return { seq: 1, messages: [] }; },
    abort() { throw Object.assign(new Error('Old run'), { code: 'stale_run' }); },
    close() { closed = true; } };
  const connector = createConnector({ adapter, socketPath,
    ensureService: async () => { ensured++; }, heartbeatMs: 20, handshakeMs: 40,
    retryInitialMs: 10, retryMaxMs: 40, ...options });
  t.after(async () => {
    connector.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { connector, frames, sockets, adapter, ensured: () => ensured,
    prompts: () => prompts, closed: () => closed,
    event: (frame) => subscribed?.(frame), eligible: (value) => { eligible = value; } };
}

test('ineligible child never starts service or connects', async (t) => {
  const h = await fixture(t, { eligible: false });
  h.connector.start();
  await delay(30);
  assert.equal(h.ensured(), 0);
  assert.equal(h.frames.length, 0);
});

test('registration, heartbeat, request routing, errors and bounded event path', async (t) => {
  const h = await fixture(t);
  h.connector.start();
  await until(() => h.frames.some((frame) => frame.type === 'heartbeat'));
  assert.equal(h.frames[0].generation, 'generation');
  assert.equal(h.frames[0].protocol, 1);
  const socket = [...h.sockets][0];
  socket.write(JSON.stringify({ type: 'request', id: 'read', method: 'snapshot', params: {} }) + '\n' +
    JSON.stringify({ type: 'request', id: 'stop', method: 'abort', params: {} }) + '\n');
  await until(() => h.frames.filter((frame) => frame.type === 'response').length === 2);
  assert.deepEqual(h.frames.find((frame) => frame.id === 'read').result.messages, []);
  assert.equal(h.frames.find((frame) => frame.id === 'stop').error.code, 'stale_run');
  h.event({ type: 'event', seq: 2, event: { type: 'reset' } });
  await until(() => h.frames.some((frame) => frame.seq === 2));
});

test('disconnect reconnects without canceling Pi or replaying writes', async (t) => {
  const h = await fixture(t);
  h.connector.start();
  await until(() => h.frames.some((frame) => frame.type === 'heartbeat'));
  const socket = [...h.sockets][0];
  socket.write(JSON.stringify({ type: 'request', id: 'write', method: 'prompt', params: {} }) + '\n');
  await until(() => h.prompts() === 1);
  socket.destroy();
  await until(() => h.frames.filter((frame) => frame.type === 'register').length === 2);
  assert.equal(h.prompts(), 1);
  assert.equal(h.closed(), false);
  assert.ok(h.ensured() >= 2);
  h.connector.close();
  await delay(60);
  assert.equal(h.closed(), false);
});

test('incompatible handshake and silent endpoint fail closed', async (t) => {
  const incompatible = await fixture(t, { protocol: 2 });
  incompatible.connector.start();
  await until(() => incompatible.frames.filter((frame) => frame.type === 'register').length >= 2);
  assert.equal(incompatible.frames.some((frame) => frame.type === 'heartbeat'), false);
  const silent = await fixture(t, { ack: false });
  silent.connector.start();
  await until(() => silent.frames.filter((frame) => frame.type === 'register').length >= 2);
  assert.equal(silent.frames.some((frame) => frame.type === 'heartbeat'), false);
});

test('eligibility loss stops heartbeat and rejects future reconnect attempts', async (t) => {
  const h = await fixture(t);
  h.connector.start();
  await until(() => h.frames.some((frame) => frame.type === 'heartbeat'));
  h.eligible(false);
  await until(() => h.sockets.size === 0);
  const attempts = h.ensured();
  await delay(100);
  assert.equal(h.ensured(), attempts);
});

test('oversized or malformed incoming frames close endpoint', async (t) => {
  const h = await fixture(t);
  h.connector.start();
  await until(() => h.frames.some((frame) => frame.type === 'heartbeat'));
  const previous = [...h.sockets][0];
  previous.write('x'.repeat(2 * 1024 * 1024 + 1));
  await until(() => !h.sockets.has(previous));
  await until(() => h.frames.filter((frame) => frame.type === 'register').length >= 2);
  [...h.sockets][0].write('{invalid}\n');
  await until(() => h.frames.filter((frame) => frame.type === 'register').length >= 3);
});
