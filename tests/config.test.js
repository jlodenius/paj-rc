import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultOrigins, getPaths, loadConfig, saveConfig, validateOrigin } from '../src/config.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'paj-rc-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return getPaths({ HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: root });
}

function config() {
  return { version: 1, port: 43187, idleTimeoutMs: 30000, allowedOrigins: defaultOrigins(43187),
    pairingKey: 'A'.repeat(43), pajCommand: '/usr/bin/paj' };
}

test('paths support XDG and HOME-only environments', () => {
  assert.deepEqual(getPaths({ HOME: '/home/test', XDG_CONFIG_HOME: '/config', XDG_RUNTIME_DIR: '/run/test' }), {
    configDir: '/config/paj-rc', configFile: '/config/paj-rc/config.json',
    runtimeDir: '/run/test/paj-rc', socketPath: '/run/test/paj-rc/daemon.sock',
    serviceFile: '/config/systemd/user/paj-rc.service',
  });
  const fallback = getPaths({ HOME: '/home/test' });
  assert.equal(fallback.configDir, '/home/test/.config/paj-rc');
  assert.match(fallback.runtimeDir, /paj-rc-\d+$/);
  assert.throws(() => getPaths({ HOME: 'relative' }), /absolute/);
  assert.deepEqual(defaultOrigins(80), ['http://127.0.0.1', 'http://localhost']);
});

test('missing config is null; save is synchronous, roundtrips and private', t => {
  const paths = fixture(t);
  assert.equal(loadConfig(paths), null);
  assert.deepEqual(saveConfig(config(), paths), config());
  assert.deepEqual(loadConfig(paths), config());
  assert.equal(statSync(paths.configDir).mode & 0o777, 0o700);
  assert.equal(statSync(paths.configFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(paths.configFile)).version, 1);
  saveConfig({ ...config(), port: 12345 }, paths);
  assert.equal(loadConfig(paths).port, 12345);
});

test('idle timeout accepts timer boundaries and rejects overflow on load', t => {
  const paths = fixture(t);
  for (const idleTimeoutMs of [0, 2147483647]) {
    saveConfig({ ...config(), idleTimeoutMs }, paths);
    assert.equal(loadConfig(paths).idleTimeoutMs, idleTimeoutMs);
  }
  writeFileSync(paths.configFile, JSON.stringify({ ...config(), idleTimeoutMs: 2147483648 }));
  assert.throws(() => loadConfig(paths), /2147483647/);
});

test('insecure, malformed and symlink configurations fail closed', t => {
  const paths = fixture(t);
  saveConfig(config(), paths);
  chmodSync(paths.configFile, 0o644);
  assert.throws(() => loadConfig(paths), /owner-private/);
  chmodSync(paths.configFile, 0o600);
  writeFileSync(paths.configFile, '{');
  assert.throws(() => loadConfig(paths), SyntaxError);
  rmSync(paths.configFile);
  const target = join(paths.configDir, 'target');
  writeFileSync(target, JSON.stringify(config()), { mode: 0o600 });
  symlinkSync(target, paths.configFile);
  assert.throws(() => loadConfig(paths), /owner-private/);
});

test('strict exact origins reject wildcard, credentials, paths and remote HTTP', () => {
  for (const origin of ['http://localhost:43187', 'http://127.0.0.1:43187', 'http://[::1]:123', 'https://my.tail.ts.net']) {
    assert.equal(validateOrigin(origin), origin);
  }
  for (const origin of ['*', 'https://*.example.com', 'http://example.com', 'https://example.com/',
    'https://example.com/path', 'https://user@example.com', 'https://example.com?x',
    'https://example.com#x', 'https://EXAMPLE.com', 'file:///tmp']) {
    assert.throws(() => validateOrigin(origin));
  }
});

test('invalid configuration cannot overwrite existing config', t => {
  const paths = fixture(t);
  saveConfig(config(), paths);
  for (const patch of [{ version: 2 }, { port: 0 }, { port: 65536 }, { port: 1.2 },
    { idleTimeoutMs: -1 }, { idleTimeoutMs: Infinity }, { idleTimeoutMs: 1.5 },
    { idleTimeoutMs: 2147483648 }, { allowedOrigins: [] },
    { pairingKey: 'secret' }, { pajCommand: 'paj' }]) {
    assert.throws(() => saveConfig({ ...config(), ...patch }, paths));
    assert.deepEqual(loadConfig(paths), config());
  }
});
