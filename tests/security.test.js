import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';
import { request as httpRequest } from 'node:http';

async function setup(t, allowedOrigins = []) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'paj-rc-security-'));
  const config = { port: 0, pairingKey: randomBytes(32).toString('base64url'),
    idleTimeoutMs: 10000, allowedOrigins };
  const daemon = await startDaemon(config, { paths: { runtimeDir, socketPath: join(runtimeDir, 'ipc.sock') },
    listSessions: async () => [] });
  t.after(async () => { await daemon.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const post = (path, data, headers = {}) => {
    const options = { method: 'POST', headers: {
      Origin: daemon.address, 'Content-Type': 'application/json', ...headers } };
    if (!headers.Host) return fetch(`${daemon.address}${path}`, { ...options, body: JSON.stringify(data) });
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${daemon.address}${path}`, options, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode, headers: response.headers })));
      });
      request.on('error', reject);
      request.end(JSON.stringify(data));
    });
  };
  return { daemon, config, post };
}

test('disallowed hosts/origins and missing origins cannot pair or issue controls', async t => {
  const { daemon, config, post } = await setup(t);
  const key = { key: config.pairingKey };
  assert.equal((await post('/api/login', key, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/login', key, { Host: 'evil.example' })).status, 403);
  assert.equal((await fetch(`${daemon.address}/api/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(key) })).status, 403);
  assert.equal((await post('/api/login', { key: 'wrong', 'Tailscale-User-Login': 'owner' })).status, 401);
});

test('configured HTTPS origin pairs securely without trusting proxy identity headers', async t => {
  const origin = 'https://computer.example.ts.net';
  const { config, post } = await setup(t, [origin]);
  const response = await post('/api/login', { key: config.pairingKey }, {
    Origin: origin, Host: 'computer.example.ts.net' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('pairing attempts are bounded and malformed input does not authenticate', async t => {
  const { post } = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await post('/api/login', { key: 'incorrect' })).status, 401);
  assert.equal((await post('/api/login', { key: 'incorrect' })).status, 429);
});

test('browser cookie tampering and stale logout cookies are rejected', async t => {
  const { daemon, config, post } = await setup(t);
  const response = await post('/api/login', { key: config.pairingKey });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await response.json();
  const request = value => fetch(`${daemon.address}/api/sessions`, { headers: {
    Origin: daemon.address, Cookie: value } });
  assert.equal((await request(`${cookie}tampered`)).status, 401);
  assert.equal((await post('/api/logout', {}, { Cookie: cookie, 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await post('/api/logout', {}, { Cookie: cookie, 'X-CSRF-Token': csrfToken })).status, 200);
  assert.equal((await request(cookie)).status, 401);
});
