import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

test('package entry points use compiled Node and browser JavaScript', async () => {
  const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(metadata.bin['paj-rc'], 'dist/src/cli.js');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(metadata.bin['paj-rc'], root)), '--help'],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: paj-rc COMMAND/);
  for (const name of await readdir(new URL('browser/', root))) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    const compiled = await readFile(new URL(`dist/public/${name.replace(/\.ts$/, '.js')}`, root), 'utf8');
    assert.ok(compiled.length > 0, name);
    const checked = spawnSync(process.execPath, ['--check', '--input-type=module'],
      { input: compiled, encoding: 'utf8' });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
  }
});
