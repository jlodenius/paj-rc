import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { installRemoteExtension } from '../extensions/index.ts';

function harness({ configured = true, mode = 'tui', role = 'primary', ready = true,
  version = 1, env = {}, approved = false, confirm, execute } = {}) {
  const bus = new EventEmitter();
  const events = new Map();
  const commands = new Map();
  const notices = [];
  const calls = [];
  const executions = [];
  const confirmations = [];
  let identity = ready ? { id: 'paj', piSessionId: 'pi', pid: process.pid, role } : null;
  const paj = { version, getSnapshot: () => ({ identity, editorBusy: false }) };
  const ctx = { mode, hasUI: mode === 'tui' || mode === 'rpc',
    sessionManager: { getSessionId: () => 'pi' }, ui: {
      notify: (message) => notices.push(message),
      async confirm(...args) { confirmations.push(args); return confirm ? confirm() : approved; },
    } };
  const pi = {
    events: { emit: (event, data) => bus.emit(event, data),
      on(event, fn) { bus.on(event, fn); return () => bus.off(event, fn); } },
    on(event, fn) { events.set(event, fn); },
    registerCommand(name, command) { commands.set(name, command); },
    async exec(command, args, options) {
      executions.push({ command, args, options });
      const result = execute ? await execute() : { code: 0, killed: false, stdout: 'SECRET', stderr: 'SECRET' };
      if (!result.killed && result.code === 0) configured = true;
      return result;
    },
  };
  bus.on('paj:external:v1', ({ reply }) => reply(paj));
  const dependencies = {
    env,
    getPaths: () => ({ socketPath: '/private/socket' }),
    loadConfig: () => configured ? { version: 1, port: 43187, idleTimeoutMs: 30000,
      allowedOrigins: ['http://127.0.0.1:43187'], pairingKey: 'SECRET', pajCommand: '/private/paj' } : null,
    ensureService() { calls.push('ensure'); },
    createSessionAdapter() {
      calls.push('adapter');
      return { close() { calls.push('adapter-close'); }, notifyState() { calls.push('state'); } };
    },
    createConnector(options) {
      calls.push('connector');
      assert.equal(options.socketPath, '/private/socket');
      return { start() { calls.push('start'); options.ensureService(); options.onStatus('connected'); },
        close() { calls.push('connector-close'); } };
    },
  };
  installRemoteExtension(pi, dependencies);
  return { calls, ctx, notices, executions, confirmations,
    start: () => events.get('session_start')({}, ctx),
    stop: (reason = 'quit') => events.get('session_shutdown')({ reason }, ctx),
    async identity(value) { identity = value; bus.emit('paj:external:changed:v1'); await immediate(); },
    command: (args) => commands.get('rc').handler(args, ctx) };
}

test('factory is inert and only configured, registered main TUI starts service', async () => {
  for (const options of [{ configured: false }, { mode: 'rpc' }, { mode: 'json' },
    { role: 'subagent' }, { ready: false }]) {
    const h = harness(options);
    assert.deepEqual(h.calls, []);
    h.start();
    assert.deepEqual(h.calls, []);
    h.stop();
  }
  const h = harness();
  assert.deepEqual(h.calls, []);
  h.start();
  assert.deepEqual(h.calls, ['adapter', 'connector', 'start', 'ensure']);
  await h.command('status');
  assert.match(h.notices.at(-1), /^Remote chat: connected\n/);
  h.stop();
  h.stop();
  assert.equal(h.calls.filter((call) => call === 'connector-close').length, 1);
});

test('registration readiness and removal refresh without child fallback', async () => {
  const h = harness({ ready: false });
  h.start();
  assert.deepEqual(h.calls, []);
  await h.identity({ id: 'paj', piSessionId: 'pi', pid: process.pid, role: 'primary' });
  assert.equal(h.calls.includes('start'), true);
  await h.identity(null);
  assert.equal(h.calls.at(-1), 'adapter-close');
  await h.identity({ id: 'child', piSessionId: 'pi', pid: process.pid, role: 'subagent' });
  assert.equal(h.calls.filter((call) => call === 'start').length, 1);
  h.stop();
});

test('new session lifecycle can restart after non-reload shutdown; commands never install', async () => {
  const h = harness();
  h.start();
  await h.command('setup');
  assert.match(h.notices.at(-1), /setup canceled; nothing installed/);
  assert.equal(h.executions.length, 0);
  h.stop('new');
  h.start();
  assert.equal(h.calls.filter((call) => call === 'start').length, 2);
  h.stop();
});

test('setup requires explicit eligible TUI confirmation and uses absolute bounded execution', async () => {
  const h = harness({ configured: false, approved: true });
  h.start();
  assert.equal(h.executions.length, 0);
  await h.command('setup');
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0][1], /private authentication.*systemd user unit/);
  assert.match(h.confirmations[0][1], /not enabled at login/);
  assert.equal(h.confirmations[0][2].timeout, 60000);
  assert.deepEqual(h.executions, [{ command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'setup', '--yes'],
    options: { timeout: 30000 } }]);
  assert.equal(isAbsolute(h.executions[0].command), true);
  assert.equal(isAbsolute(h.executions[0].args[0]), true);
  assert.equal(h.calls.filter((call) => call === 'start').length, 1);
  assert.match(h.notices.at(-1), /setup complete/);
  assert.equal(h.notices.join('\n').includes('SECRET'), false);
  h.stop();
});

test('setup fails closed for children, wrong modes, missing Paj or incompatible contract', async () => {
  for (const options of [{ mode: 'rpc' }, { mode: 'json' }, { role: 'subagent' },
    { ready: false }, { version: 2 }, { env: { PAJ_SPAWN_ID: 'spawn' } },
    { env: { PAJ_PARENT_PI_SESSION_ID: 'parent' } }]) {
    const h = harness({ ...options, approved: true });
    h.start();
    await h.command('setup');
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.executions.length, 0);
    h.stop();
  }
});

test('setup rechecks identity and lifecycle after confirmation and rejects overlapping setup', async () => {
  let decide;
  const h = harness({ configured: false, confirm: () => new Promise(resolve => { decide = resolve; }) });
  h.start();
  const pending = h.command('setup');
  await h.command('setup');
  assert.equal(h.confirmations.length, 1);
  assert.match(h.notices.at(-1), /already pending/);
  await h.identity(null);
  decide(true);
  await pending;
  assert.equal(h.executions.length, 0);
  assert.match(h.notices.at(-1), /eligibility changed/);
  h.stop();
  const replaced = harness({ configured: false, confirm: () => new Promise(resolve => { decide = resolve; }) });
  replaced.start();
  const old = replaced.command('setup');
  replaced.stop('new');
  decide(true);
  await old;
  assert.equal(replaced.executions.length, 0);
});

test('setup checks exit status, handles timeout and never exposes process output', async () => {
  for (const execute of [() => ({ code: 1, killed: false, stderr: 'SECRET', stdout: 'SECRET' }),
    () => ({ code: 0, killed: true, stderr: 'SECRET' }),
    () => { throw new Error('SECRET'); }]) {
    const h = harness({ configured: false, approved: true, execute });
    h.start();
    await h.command('setup');
    assert.equal(h.executions.length, 1);
    assert.match(h.notices.at(-1), /setup (failed|unavailable)/);
    assert.equal(h.notices.join('\n').includes('SECRET'), false);
    assert.equal(h.calls.includes('start'), false);
    h.stop();
  }
});

test('status and settings show whitelisted values and absolute CLI guidance without secrets', async () => {
  const h = harness();
  h.start();
  for (const command of ['status', 'settings']) {
    await h.command(command);
    const message = h.notices.at(-1);
    assert.match(message, /"port": 43187/);
    assert.match(message, /"idleTimeoutMs": 30000/);
    assert.match(message, /http:\/\/127.0.0.1:43187/);
    assert.equal(message.includes('SECRET'), false);
    assert.equal(message.includes('/private/paj'), false);
    assert.equal(message.includes(process.execPath), true);
    assert.equal(message.includes(fileURLToPath(new URL('../src/cli.js', import.meta.url))), true);
    assert.equal(message.includes('Run paj-rc'), false);
  }
  assert.equal(h.executions.length, 0);
  assert.equal(h.confirmations.length, 0);
  h.stop();
});
