import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBroker } from '../dist/src/broker.js';
import { readFrames, writeFrame } from '../dist/src/protocol.js';

const base = { busy: false, runId: null, editorBusy: false, terminalRequired: false };
const metadata = { model: { id: 'model', provider: 'provider', name: 'Model' },
  context: { tokens: null, contextWindow: 200000 } };

async function fixture(t, options = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-rc-broker-'));
  const identity = { id: 'main', piSessionId: 'pi', pid: process.pid, role: 'primary' };
  const events = [];
  const paths = { runtimeDir, socketPath: join(runtimeDir, 'rc.sock') };
  const broker = await startBroker({ paths, listSessions: async () => [identity],
    onEvent: (type, value) => events.push({ type, value }), ...options });
  t.after(async () => { await broker.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  async function connect(state) {
    const socket = createConnection(paths.socketPath);
    socket.on('error', () => {});
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.resume();
    writeFrame(socket, { type: 'register', protocol: 1, identity, generation: 'generation', state });
    return socket;
  }
  return { broker, connect, events };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Timed out waiting for broker');
}

test('Captain badge follows only fresh identity-matched registry capability, never endpoint claims', async t => {
  const token = '019ab311-a8dc-7000-8000-000000000001';
  const identity = { id: 'main', piSessionId: 'pi', pid: process.pid, role: 'primary' };
  let record = { ...identity, captainInspection: token, lastHeartbeatMs: Date.now() };
  let failed = false;
  const { broker, connect, events } = await fixture(t, { pollIntervalMs: 10,
    listSessions: async () => { if (failed) throw new Error('unavailable'); return [record]; } });
  const socket = await connect({ ...base, captain: true });
  await until(() => broker.size === 1);
  assert.equal(broker.list()[0].captain, true, 'initial registry snapshot');
  assert.doesNotMatch(JSON.stringify(broker.list()), new RegExp(token));
  for (const capability of [undefined, null, false, true, 'true', '', 'not-a-uuid']) {
    record = { ...identity, captainInspection: capability, lastHeartbeatMs: Date.now() };
    await until(() => broker.list()[0]?.captain === false);
    record.captainInspection = token;
    await until(() => broker.list()[0]?.captain === true);
  }
  for (const heartbeat of [undefined, 'now', Date.now() - 61000, Date.now() + 60000]) {
    record = { ...identity, captainInspection: token, lastHeartbeatMs: heartbeat };
    await until(() => broker.list()[0]?.captain === false);
    record.lastHeartbeatMs = Date.now();
    await until(() => broker.list()[0]?.captain === true);
  }
  writeFrame(socket, { type: 'event', seq: 1,
    event: { type: 'state', state: { ...base, captain: false } } });
  await until(() => events.some(event => event.type === 'session'));
  assert.equal(broker.list()[0].captain, true, 'endpoint state cannot override registry');
  assert.ok(events.filter(event => event.type === 'sessions').length > 2, 'changes notify browsers');
  failed = true;
  await until(() => broker.list().length === 0);
  failed = false;
  record = { ...identity };
  await connect(base);
  await until(() => broker.list()[0]?.captain === false);
  assert.equal(broker.list()[0].captain, false, 'reconnect never retains an old capability');
  record = { ...identity, pid: process.pid + 1, captainInspection: token, lastHeartbeatMs: Date.now() };
  await until(() => broker.list().length === 0);
});

test('Captain capability expires even while a registry poll is stuck', async t => {
  const now = Date.now;
  let instant = now();
  Date.now = () => instant;
  t.after(() => { Date.now = now; });
  const identity = { id: 'main', piSessionId: 'pi', pid: process.pid, role: 'primary',
    captainInspection: '019ab311-a8dc-7000-8000-000000000001', lastHeartbeatMs: instant };
  let reads = 0;
  let finish;
  const { broker, connect, events } = await fixture(t, { pollIntervalMs: 10,
    listSessions: async () => ++reads === 1 ? [identity] : new Promise(resolve => { finish = resolve; }) });
  await connect(base);
  await until(() => broker.size === 1);
  assert.equal(broker.list()[0].captain, true);
  await until(() => finish);
  instant += 61000;
  await until(() => events.filter(event => event.type === 'sessions').length > 1);
  assert.equal(broker.list()[0].captain, false);
  finish([identity]);
  await delay(15);
  assert.equal(broker.list()[0]?.captain ?? false, false, 'late stale result cannot revive badge');
});

test('late registry polls cannot restore Captain capability after a newer validation', async t => {
  const identity = { id: 'main', piSessionId: 'pi', pid: process.pid, role: 'primary' };
  const active = { ...identity, captainInspection: '019ab311-a8dc-7000-8000-000000000001',
    lastHeartbeatMs: Date.now() };
  let reads = 0;
  let finish;
  const { broker, connect } = await fixture(t, { pollIntervalMs: 10,
    listSessions: async () => {
      reads++;
      if (reads === 1) return [active];
      if (reads === 3) return [identity];
      return new Promise(resolve => { finish = resolve; });
    } });
  const socket = await connect(base);
  await until(() => broker.list()[0]?.captain === true);
  await until(() => finish);
  readFrames(socket, frame => {
    if (frame.type === 'request') writeFrame(socket, { type: 'response', id: frame.id, ok: true,
      result: { state: base, messages: [] } });
  });
  await broker.request('main', 'snapshot', {});
  assert.equal(broker.list()[0].captain, false, 'newer request validation observes revocation');
  const oldPoll = finish;
  oldPoll([active]);
  await delay(15);
  assert.equal(broker.list()[0].captain, false, 'older poll cannot overwrite newer validation');
});

test('broker accepts legacy state and whitelists metadata across registration, events and snapshots', async t => {
  const { broker, connect, events } = await fixture(t);
  const socket = await connect(base);
  await until(() => broker.size === 1);
  assert.deepEqual(broker.list()[0].state, base);
  const extended = { ...base, ...metadata, secret: 'SECRET',
    model: { ...metadata.model, apiKey: 'SECRET' }, context: { ...metadata.context, raw: 'SECRET' } };
  writeFrame(socket, { type: 'event', seq: 1, event: { type: 'state', state: extended, raw: 'SECRET' } });
  await until(() => events.some(event => event.type === 'session'));
  assert.deepEqual(broker.list()[0].state, { ...base, ...metadata });
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
  readFrames(socket, frame => {
    if (frame.type === 'request') writeFrame(socket, { type: 'response', id: frame.id, ok: true,
      result: { state: { ...extended, context: { tokens: 0, contextWindow: 1000, secret: 'SECRET' } },
        messages: [] } });
  });
  const snapshot = await broker.request('main', 'snapshot', {});
  assert.deepEqual(snapshot.state.context, { tokens: 0, contextWindow: 1000 });
  assert.deepEqual(broker.list()[0].state, snapshot.state);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
  writeFrame(socket, { type: 'event', seq: 2,
    event: { type: 'state', state: { ...base, model: null, context: null } } });
  await until(() => broker.list()[0]?.state.model === null);
  assert.deepEqual(broker.list()[0].state, { ...base, model: null, context: null });
});

test('broker rejects malformed snapshot state without forwarding it', async t => {
  const { broker, connect } = await fixture(t);
  const socket = await connect(base);
  await until(() => broker.size === 1);
  readFrames(socket, frame => {
    if (frame.type === 'request') writeFrame(socket, { type: 'response', id: frame.id, ok: true,
      result: { state: { ...base, context: { tokens: -1, contextWindow: 1000 } } } });
  });
  await assert.rejects(broker.request('main', 'snapshot', {}), { code: 'disconnected' });
  await until(() => broker.size === 0);
});

test('broker rejects malformed optional metadata on registration and state events', async t => {
  const { broker, connect } = await fixture(t);
  const malformed = [
    { model: {} }, { model: [] }, { model: 'model' },
    { model: { ...metadata.model, name: 'x'.repeat(201) } },
    { model: { ...metadata.model, id: 'bad\nvalue' } },
    { context: {} }, { context: [] }, { context: 'usage' },
    ...[0, -1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1].map(contextWindow =>
      ({ context: { tokens: 0, contextWindow } })),
    ...[-1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1].map(tokens =>
      ({ context: { tokens, contextWindow: 1000 } })),
  ];
  for (const invalid of malformed) {
    const socket = await connect({ ...base, ...invalid });
    if (!socket.destroyed) await once(socket, 'close');
    assert.equal(broker.size, 0);
  }
  const socket = await connect({ ...base, ...metadata });
  await until(() => broker.size === 1);
  writeFrame(socket, { type: 'event', seq: 1,
    event: { type: 'state', state: { ...base, context: { tokens: -1, contextWindow: 1000 } } } });
  await once(socket, 'close');
  await until(() => broker.size === 0);
});

test('snapshot commands are optional, bounded, and stripped of private native provenance', async t => {
  const { broker, connect } = await fixture(t);
  const socket = await connect(base);
  await until(() => broker.size === 1);
  let commands;
  readFrames(socket, frame => {
    if (frame.type === 'request') writeFrame(socket, { type: 'response', id: frame.id, ok: true,
      result: { state: base, messages: [], ...(commands === undefined ? {} : { commands }) } });
  });
  assert.equal(Object.hasOwn(await broker.request('main', 'snapshot', {}), 'commands'), false);
  commands = [{ name: 'review', description: 'Review changes', source: 'prompt',
    sourceInfo: { path: 'SECRET' }, content: 'SECRET' },
  { name: 'skill:check', description: '', source: 'skill', template: 'SECRET' }];
  const snapshot = await broker.request('main', 'snapshot', {});
  assert.deepEqual(snapshot.commands, [
    { name: 'review', description: 'Review changes', source: 'prompt' },
    { name: 'skill:check', description: '', source: 'skill' },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});

test('broker fails closed on malformed or executable-extension snapshot catalogs', async t => {
  const { broker, connect } = await fixture(t);
  const valid = { name: 'review', description: 'Review', source: 'prompt' };
  for (const commands of [null, {}, [null], [{ ...valid, source: 'extension' }],
    [{ ...valid, name: '/review' }], [{ ...valid, name: 'bad name' }],
    [{ ...valid, name: 'x'.repeat(101) }], [{ ...valid, source: 'skill' }],
    [{ ...valid, description: 'x'.repeat(241) }], [{ ...valid, description: 'bad\nvalue' }],
    [valid, valid], Array.from({ length: 129 }, (_, i) => ({ ...valid, name: `p${i}` }))]) {
    const socket = await connect(base);
    await until(() => broker.size === 1);
    readFrames(socket, frame => {
      if (frame.type === 'request') writeFrame(socket, { type: 'response', id: frame.id, ok: true,
        result: { state: base, messages: [], commands } });
    });
    await assert.rejects(broker.request('main', 'snapshot', {}), { code: 'disconnected' });
    await until(() => broker.size === 0);
  }
});
