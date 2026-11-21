import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getPaths, loadConfig, saveConfig } from '../dist/src/config.js';
import { ensureService, installService, renderUnit, resolveExecutable, serviceStatus, uninstallService } from '../dist/src/service.js';
import { main } from '../dist/src/cli.js';
import { startDaemon } from '../dist/src/daemon.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'paj-rc service %-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: join(root, 'run') };
  const paths = getPaths(env);
  const packageDir = join(root, 'package "with" $ spaces');
  mkdirSync(join(packageDir, 'dist', 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'dist', 'src', 'cli.js'), '');
  const pajCommand = join(root, 'paj executable');
  writeFileSync(pajCommand, '#!/bin/sh\nexit 0\n');
  chmodSync(pajCommand, 0o700);
  const calls = [];
  const execute = args => { calls.push(args); return 'active\n'; };
  return { root, env, paths, packageDir, pajCommand, calls, execute };
}

test('setup requires approval and never invokes systemctl without it', async t => {
  const f = fixture(t);
  await assert.rejects(installService(f), /approval/);
  assert.equal(existsSync(f.paths.configFile), false);
  assert.deepEqual(f.calls, []);
});

test('setup writes private config, escaped unit, and does not start or enable login', async t => {
  const f = fixture(t);
  await installService({ ...f, approved: true });
  const config = loadConfig(f.paths);
  assert.equal(config.port, 43187);
  assert.equal(config.idleTimeoutMs, 30000);
  assert.match(config.pairingKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(config.pajCommand, f.pajCommand);
  assert.equal(statSync(f.paths.runtimeDir).mode & 0o777, 0o700);
  assert.deepEqual(f.calls, [['daemon-reload']]);
  const unit = readFileSync(f.paths.serviceFile, 'utf8');
  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /WantedBy|Restart=always/);
  assert.ok(unit.includes('service %%'));
  assert.ok(unit.includes('package \\"with\\" $$ spaces'));
  assert.match(unit, /ExecStart="[^\n]+" "[^\n]+" serve/);
  await installService({ ...f, approved: true });
  assert.equal(loadConfig(f.paths).pairingKey, config.pairingKey);
});

test('systemd environment preserves dollars while ExecStart escapes them', () => {
  const unit = renderUnit({ nodePath: '/path/with $cash/node', cliPath: '/path/100%/cli.js', env: { HOME: '/home/$user' } });
  assert.ok(unit.includes('Environment="HOME=/home/$user"'));
  assert.ok(unit.includes('ExecStart="/path/with $$cash/node" "/path/100%%/cli.js" serve'));
  assert.throws(() => renderUnit({ nodePath: '/bad\npath', cliPath: '/cli' }), /control/);
});

test('setup preserves explicit Paj runtime directory with systemd escaping', async t => {
  const f = fixture(t);
  f.env.PAJ_RUNTIME_DIR = join(f.root, 'paj "registry" $ 100%');
  await installService({ ...f, approved: true });
  const unit = readFileSync(f.paths.serviceFile, 'utf8');
  assert.ok(unit.includes('Environment="PAJ_RUNTIME_DIR='));
  assert.ok(unit.includes('paj \\"registry\\" $ 100%%"'));
  assert.deepEqual(f.calls, [['daemon-reload']]);
  const withoutOverride = renderUnit({ nodePath: '/node', cliPath: '/cli', env: {} });
  assert.ok(!withoutOverride.includes('PAJ_RUNTIME_DIR='));
});

test('setup rejects relative or control-character Paj runtime directories before writing', async t => {
  const f = fixture(t);
  for (const value of ['', 'relative', '/runtime\nnew', '/runtime\rnew', '/runtime\tnew',
    '/runtime\0new', '/runtime\x7fnew', '/runtime\x85new']) {
    await assert.rejects(installService({ ...f, approved: true,
      env: { ...f.env, PAJ_RUNTIME_DIR: value } }), /PAJ_RUNTIME_DIR/);
    assert.equal(existsSync(f.paths.configFile), false);
    assert.equal(existsSync(f.paths.serviceFile), false);
    assert.deepEqual(f.calls, []);
  }
});

test('ensureService never installs and only starts already-configured installed unit', async t => {
  const f = fixture(t);
  assert.equal(await ensureService(f), false);
  assert.deepEqual(f.calls, []);
  await installService({ ...f, approved: true });
  f.calls.length = 0;
  assert.equal(await ensureService(f), true);
  assert.deepEqual(f.calls, [['start', 'paj-rc.service']]);
  rmSync(f.paths.serviceFile);
  f.calls.length = 0;
  assert.equal(await ensureService(f), false);
  assert.deepEqual(f.calls, []);
});

test('autostart awaits asynchronous user-manager completion without blocking the event loop', async t => {
  const f = fixture(t);
  await installService({ ...f, approved: true });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let completed = false;
  const startup = ensureService({ ...f, execute: async () => pending }).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await startup;
  assert.equal(completed, true);
  await assert.rejects(ensureService({ ...f, execute: async () => { throw new Error('manager failed'); } }), /manager failed/);
});

test('status and uninstall use injected user-service executor, preserving config', async t => {
  const f = fixture(t);
  assert.deepEqual(serviceStatus(f), { configured: false, installed: false, active: false });
  await installService({ ...f, approved: true });
  assert.deepEqual(serviceStatus(f), { configured: true, installed: true, active: true });
  assert.throws(() => uninstallService(f), /approval/);
  f.calls.length = 0;
  assert.deepEqual(uninstallService({ ...f, approved: true }), { configRetained: true });
  assert.deepEqual(f.calls, [['disable', '--now', 'paj-rc.service'], ['daemon-reload']]);
  assert.equal(existsSync(f.paths.serviceFile), false);
  assert.ok(loadConfig(f.paths));
});

test('executable resolution supports absolute and PATH paths with spaces', t => {
  const f = fixture(t);
  assert.equal(resolveExecutable('paj executable', { PATH: f.root }), f.pajCommand);
  assert.throws(() => resolveExecutable('missing', { PATH: f.root }), /not found/);
});

test('managed service status and on-demand start work before config; setup and uninstall do not touch the unit', async t => {
  const f = fixture(t);
  const target = join(f.root, 'declarative.service');
  mkdirSync(dirname(f.paths.serviceFile), { recursive: true });
  writeFileSync(target, 'managed unit');
  const empty = join(f.root, 'empty.service');
  writeFileSync(empty, '');
  for (const link of [target, join(f.root, 'missing'), '/dev/null', empty, f.root]) {
    const installed = link === target;
    symlinkSync(link, f.paths.serviceFile);
    f.calls.length = 0;
    assert.deepEqual(serviceStatus(f), { configured: false, installed, active: installed, managed: true });
    assert.equal(await ensureService(f), installed);
    await assert.rejects(main(['setup', '--yes'], f), /externally managed/);
    await assert.rejects(main(['uninstall', '--yes'], f), /externally managed/);
    assert.deepEqual(f.calls, installed ? [['is-active', 'paj-rc.service'], ['start', 'paj-rc.service']] : []);
    assert.equal(readlinkSync(f.paths.serviceFile), link);
    assert.equal(existsSync(f.paths.configFile), false);
    assert.equal(readFileSync(target, 'utf8'), 'managed unit');
    rmSync(f.paths.serviceFile);
  }
});

test('standalone uninstall leaves a declarative replacement intact', async t => {
  const f = fixture(t);
  await installService({ ...f, approved: true });
  const target = join(f.root, 'declarative.service');
  writeFileSync(target, 'replacement');
  assert.throws(() => uninstallService({ ...f, approved: true, execute(args) {
    assert.deepEqual(args, ['disable', '--now', 'paj-rc.service']);
    rmSync(f.paths.serviceFile);
    symlinkSync(target, f.paths.serviceFile);
  } }), /externally managed/);
  assert.equal(readlinkSync(f.paths.serviceFile), target);
  assert.equal(readFileSync(f.paths.serviceFile, 'utf8'), 'replacement');
});

function daemonOptions(t, f, daemonFactory) {
  const previous = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
  t.after(() => {
    for (const [signal, listeners] of previous) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener)) process.removeListener(signal, listener);
      }
    }
  });
  return { ...f, daemonFactory };
}

function stubDaemon(t, f, check) {
  return daemonOptions(t, f, async config => { check(config); return { close() {} }; });
}

test('managed serve initializes only private defaults, and explicit Paj takes precedence without rewriting state', async t => {
  const f = fixture(t);
  const argv = ['serve', '--paj', f.pajCommand];
  const seen = [];
  const opts = stubDaemon(t, f, config => seen.push(config));
  await main(argv, opts);
  const fresh = loadConfig(f.paths);
  assert.equal(fresh.pajCommand, undefined);
  assert.deepEqual(fresh.allowedOrigins, ['http://127.0.0.1:43187', 'http://localhost:43187']);
  assert.equal(fresh.idleTimeoutMs, 30000);
  assert.equal(statSync(f.paths.configDir).mode & 0o777, 0o700);
  assert.equal(statSync(f.paths.configFile).mode & 0o777, 0o600);
  assert.deepEqual(seen[0], { ...fresh, pajCommand: f.pajCommand });
  await assert.rejects(main(['serve'], opts), /absolute executable path/);
  const custom = { ...fresh, port: 44433, idleTimeoutMs: 24242,
    allowedOrigins: ['https://private.example'], pajCommand: '/obsolete/paj' };
  saveConfig(custom, f.paths);
  const browserFile = join(f.paths.configDir, 'browser-sessions.json');
  writeFileSync(browserFile, '{"fixture":"browser state"}', { mode: 0o600 });
  const configBefore = readFileSync(f.paths.configFile);
  const browserBefore = readFileSync(browserFile);
  await main(argv, opts);
  assert.deepEqual(seen[1], { ...custom, pajCommand: f.pajCommand });
  assert.deepEqual(readFileSync(f.paths.configFile), configBefore);
  assert.deepEqual(readFileSync(browserFile), browserBefore);
  assert.equal(existsSync(f.paths.serviceFile), false);
  assert.deepEqual(f.calls, []);
});

test('standalone browser pairing survives a managed start without widening access', async t => {
  const f = fixture(t);
  await installService({ ...f, approved: true });
  const pinnedPaj = join(f.root, 'pinned-paj');
  writeFileSync(pinnedPaj, '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
  const original = readFileSync(f.paths.configFile);
  const config = loadConfig(f.paths);
  const opts = daemonOptions(t, f, async (effective, options) => {
    const daemon = await startDaemon({ ...effective, port: 0 }, options);
    t.after(() => daemon.close());
    return daemon;
  });
  const standalone = await main(['serve'], opts);
  const reply = await fetch(`${standalone.address}/api/login`, { method: 'POST',
    headers: { Origin: standalone.address, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: config.pairingKey }) });
  assert.equal(reply.status, 200);
  const cookie = reply.headers.get('set-cookie').split(';')[0];
  await standalone.close();
  const managed = await main(['serve', '--paj', pinnedPaj], opts);
  assert.match(managed.address, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(readFileSync(f.paths.configFile), original);
  const sessions = `${managed.address}/api/sessions`;
  assert.equal((await fetch(sessions)).status, 401);
  assert.equal((await fetch(sessions, { headers: { Cookie: cookie, Origin: 'https://unapproved.example' } })).status, 403);
  assert.equal((await fetch(sessions, { headers: { Cookie: cookie, Origin: managed.address } })).status, 200);
});

test('invalid overrides and insecure or malformed managed config fail without writes or fallback', async t => {
  const f = fixture(t);
  const nonexec = join(f.root, 'nonexec');
  writeFileSync(nonexec, 'fixture', { mode: 0o600 });
  const opts = stubDaemon(t, f, () => assert.fail('should not reach daemon'));
  const overrides = ['paj', '.', f.root, nonexec, join(f.root, 'missing'), '/bad\npath'];
  for (const value of overrides) await assert.rejects(main(['serve', '--paj', value], opts));
  await assert.rejects(main(['serve', '--paj'], opts), /Missing value/);
  await assert.rejects(main(['serve', '--paj', f.pajCommand, '--paj', f.pajCommand], opts), /duplicate/);
  assert.equal(existsSync(f.paths.configFile), false);
  await installService({ ...f, approved: true });
  const original = readFileSync(f.paths.configFile);
  await assert.rejects(main(['serve', '--paj', 'paj'], opts));
  assert.deepEqual(readFileSync(f.paths.configFile), original);
  chmodSync(f.paths.configFile, 0o644);
  await assert.rejects(main(['serve', '--paj', f.pajCommand], opts), /owner-private/);
  assert.deepEqual(readFileSync(f.paths.configFile), original);
  chmodSync(f.paths.configFile, 0o600);
  writeFileSync(f.paths.configFile, '{');
  await assert.rejects(main(['serve', '--paj', f.pajCommand], opts), SyntaxError);
  assert.equal(readFileSync(f.paths.configFile, 'utf8'), '{');
});

test('CLI serve closes cleanly on idle without exiting the host process', async t => {
  const f = fixture(t);
  await installService({ ...f, approved: true });
  const previous = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
  t.after(() => {
    for (const [signal, listeners] of previous) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener)) process.removeListener(signal, listener);
      }
    }
  });
  let options;
  let closes = 0;
  const daemon = { close: async () => { closes++; } };
  const result = await main(['serve'], { ...f, daemonFactory: async (config, supplied) => {
    assert.equal(config.port, 43187);
    options = supplied;
    return daemon;
  } });
  assert.equal(result, daemon);
  assert.equal(options.paths, f.paths);
  await options.onIdle();
  assert.equal(closes, 1);
});

test('CLI hides secrets except key and rotation restarts only active services', async t => {
  const f = fixture(t);
  await installService({ ...f, approved: true });
  const output = [];
  const opts = { ...f, output: value => output.push(value) };
  const key = loadConfig(f.paths).pairingKey;
  await main(['settings'], opts);
  await main(['status'], opts);
  assert.ok(output.every(value => !value.includes(key)));
  await main(['key'], opts);
  assert.equal(output.at(-1), key);
  await main(['rotate'], opts);
  const nextKey = loadConfig(f.paths).pairingKey;
  assert.notEqual(nextKey, key);
  assert.ok(!output.at(-1).includes(nextKey));
  assert.deepEqual(f.calls.at(-1), ['try-restart', 'paj-rc.service']);
  await main(['settings', '--port', '43200', '--idle-timeout-ms', '0'], opts);
  assert.equal(loadConfig(f.paths).port, 43200);
  assert.equal(loadConfig(f.paths).idleTimeoutMs, 0);
  assert.ok(loadConfig(f.paths).allowedOrigins.includes('http://localhost:43200'));
  await main(['origin', 'add', 'https://phone.tail.ts.net'], opts);
  assert.ok(loadConfig(f.paths).allowedOrigins.includes('https://phone.tail.ts.net'));
  await main(['origin', 'remove', 'https://phone.tail.ts.net'], opts);
  assert.ok(!loadConfig(f.paths).allowedOrigins.includes('https://phone.tail.ts.net'));
  await assert.rejects(main(['settings', '--port', 'garbage'], opts), /integer/);
});
