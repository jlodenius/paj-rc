import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('Pi discovers rc through a Home Manager-style package directory link',
  { skip: !process.env.PAJ_RC_PI_BIN, timeout: 30000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'rc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'a');
  const extensions = join(agent, 'extensions');
  mkdirSync(extensions, { recursive: true });
  const config = join(root, 'c');
  const runtime = join(root, 'r');
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  symlinkSync(process.env.PAJ_RC_EXTENSION_SOURCE || packageRoot, join(extensions, 'paj-rc'));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: config,
    XDG_RUNTIME_DIR: runtime, PAJ_RUNTIME_DIR: join(root, 'p') };
  const result = spawnSync(process.env.PAJ_RC_PI_BIN, ['--mode', 'rpc', '--no-session'], {
    input: JSON.stringify({ id: 'discovery', type: 'get_commands' }) + '\n',
    encoding: 'utf8', cwd: root, env, timeout: 25000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const records = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const response = records.find(record => record.id === 'discovery');
  assert.equal(response?.success, true);
  assert.ok(response.data.commands.some(command => command.name === 'rc'),
    'The rc command must register when Pi autoloads the managed package link');
});
