import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
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

test('trusted browser pairing has no server expiry and uses a long-lived renewable cookie', t => {
  const key = randomBytes(32).toString('base64url');
  const auth = createAuth(key);
  const login = auth.login(key, true);
  const token = tokenOf(login);
  assert.match(login.cookie, /Max-Age=34560000/);
  const future = Date.now() + 500 * 24 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => future);
  const session = auth.read(request(token));
  assert.ok(session);
  assert.equal(session.expires, null);
  assert.equal(tokenOf({ cookie: auth.refresh(session, true) }), token);
  assert.match(auth.refresh(session, true), /; Secure/);
  auth.logout(session, true);
  assert.equal(auth.read(request(token)), null);
});

test('legacy unexpired pairing migrates without a new key; expired credentials stay expired', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paj-rc-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  const key = randomBytes(32).toString('base64url');
  const live = randomBytes(32).toString('base64url');
  const expired = randomBytes(32).toString('base64url');
  const sha = value => createHash('sha256').update(value).digest('hex');
  await writeFile(file, JSON.stringify({ version: 1, keyId: sha(key), sessions: [
    { hash: sha(live), expires: Date.now() + 60000, csrfToken: randomBytes(32).toString('base64url') },
    { hash: sha(expired), expires: Date.now() - 60000, csrfToken: randomBytes(32).toString('base64url') },
  ] }), { mode: 0o600 });
  const migrated = createAuth(key, { file });
  assert.equal(migrated.read(request(live))?.expires, null);
  assert.equal(migrated.read(request(expired)), null);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.sessions.length, 1);
  assert.equal(createAuth(key, { file }).read(request(live))?.expires, null);
});
