import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuth } from '../src/auth.js';

const request = token => ({ headers: { cookie: `paj_rc_session=${token}` } });
const tokenOf = login => login.cookie.split(';')[0].slice('paj_rc_session='.length);

test('noncanonical bearer values cannot bypass logout revocation', () => {
  const key = randomBytes(32).toString('base64url');
  const auth = createAuth(key);
  const token = tokenOf(auth.login(key, false));
  const session = auth.read(request(token));
  auth.logout(session, false);
  for (const value of [token, `${token}.`, `${token}..suffix`, `${token} `]) {
    assert.equal(auth.read(request(value)), null);
  }
});

test('browser login survives restart but logout stays revoked and rotation invalidates saved sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paj-rc-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  const key = randomBytes(32).toString('base64url');
  const first = createAuth(key, { file });
  const token = tokenOf(first.login(key, true));
  assert.equal((await stat(file)).mode & 0o077, 0);
  const restarted = createAuth(key, { file });
  const session = restarted.read(request(token));
  assert.ok(session);
  restarted.logout(session, true);
  assert.equal(createAuth(key, { file }).read(request(token)), null);
  const active = tokenOf(restarted.login(key, true));
  const rotated = createAuth(randomBytes(32).toString('base64url'), { file });
  assert.equal(rotated.read(request(active)), null);
});
