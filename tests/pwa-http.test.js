import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startDaemon } from '../src/daemon.js';

async function setup(t, options = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'rc-pwa-'));
  const config = { port: 0, idleTimeoutMs: 10000, allowedOrigins: [],
    pairingKey: randomBytes(32).toString('base64url') };
  const daemon = await startDaemon(config, { paths: { runtimeDir, socketPath: join(runtimeDir, 'rc.sock') },
    listSessions: async () => [], ...options });
  t.after(async () => { await daemon.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  return { config, daemon, get: path => fetch(`${daemon.address}${path}`, { headers: { Origin: daemon.address } }) };
}

test('installable app exposes a scoped manifest, worker, PNG icons, and steering default', async t => {
  const { get } = await setup(t);
  const page = await get('/');
  const html = await page.text();
  assert.match(html, /rel="manifest"[^>]+href="\/manifest.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /<option\b[^>]*value="steer"[^>]*selected/);
  const response = await get('/manifest.webmanifest');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await response.json();
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(value => value.sizes === `${size}x${size}`);
    assert.ok(icon);
    const image = await get(icon.src);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await image.arrayBuffer());
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const apple = await get('/icons/apple-touch-icon.png');
  const png = Buffer.from(await apple.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 180);
  for (const font of ['fira-code-latin', 'space-grotesk-latin']) {
    const response = await get(`/fonts/${font}.woff2`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'font/woff2');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
  }
  for (const font of ['firacode', 'spacegrotesk']) {
    const response = await get(`/fonts/${font}-OFL.txt`);
    assert.match(await response.text(), /SIL OPEN FONT LICENSE/);
  }
  for (const path of ['/images.js', '/image-limits.js']) {
    const script = await get(path);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(script.headers.get('set-cookie'), null);
  }
  const markdown = await get('/markdown.js');
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get('content-type'), /javascript/);
  assert.equal(markdown.headers.get('set-cookie'), null);
  const worker = await get('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
  assert.equal(worker.headers.get('set-cookie'), null);
  const csp = worker.headers.get('content-security-policy');
  assert.match(csp, /font-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /img-src 'self' blob:/);
  assert.equal((await get('/icons/../../src/auth.js')).status, 401);
});

test('remembered browser event stream stays open without a server-side expiry', async t => {
  const { daemon, config } = await setup(t, { keepaliveIntervalMs: 10 });
  const login = await fetch(`${daemon.address}/api/login`, { method: 'POST',
    headers: { Origin: daemon.address, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: config.pairingKey }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${daemon.address}/api/events`, { signal: controller.signal,
    headers: { Origin: daemon.address, Cookie: cookie } });
  const reader = events.body.getReader();
  await reader.read();
  const next = await reader.read();
  assert.equal(next.done, false);
  assert.match(new TextDecoder().decode(next.value), /heartbeat/);
});
