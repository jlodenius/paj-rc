import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const origin = 'https://remote.example';
const shell = [
  '/', '/app.js', '/state.js', '/paths.js', '/session-info.js', '/submissions.js', '/text.js',
  '/markdown.js', '/images.js', '/image-limits.js',
  '/style.css', '/manifest.webmanifest',
  '/fonts/fira-code-latin.woff2', '/fonts/space-grotesk-latin.woff2',
  '/fonts/firacode-OFL.txt', '/fonts/spacegrotesk-OFL.txt',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png',
];
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

function worker() {
  const listeners = new Map();
  const stores = new Map();
  const requests = [];
  const deleted = [];
  let network = async request => new Response(`network:${new URL(request.url).pathname}`);
  let claims = 0;
  let skips = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async put(url, response) { entries.set(String(url), response.clone()); },
        async match(url) { return entries.get(String(url))?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  vm.runInNewContext(source, {
    self: {
      location: { origin },
      async skipWaiting() { skips++; },
      clients: { async claim() { claims++; } },
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
    caches, URL, Request, Response,
    fetch: async request => { requests.push(request); return network(request); },
  });
  return {
    caches, stores, requests, deleted,
    get claims() { return claims; },
    get skips() { return skips; },
    set network(value) { network = value; },
    async lifecycle(type) {
      let pending;
      listeners.get(type)({ waitUntil(value) { pending = value; } });
      await pending;
    },
    request(path, options) {
      let response;
      const request = new Request(new URL(path, origin), options);
      listeners.get('fetch')({ request, respondWith(value) { response = value; } });
      return response;
    },
  };
}

test('worker precaches only the public shell without credentials and serves it offline', async () => {
  const w = worker();
  await w.lifecycle('install');
  assert.deepEqual(w.requests.map(request => new URL(request.url).pathname).sort(), [...shell].sort());
  for (const request of w.requests) {
    assert.equal(request.credentials, 'omit');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.redirect, 'error');
    assert.equal([...request.headers].length, 0);
  }
  assert.equal(w.skips, 1);
  assert.equal(w.stores.size, 1);
  const entries = [...w.stores.values()][0];
  assert.deepEqual([...entries.keys()].sort(),
    shell.map(path => origin + path).sort());
  w.network = async () => { throw new TypeError('offline'); };
  for (const path of shell) {
    assert.equal(await (await w.request(path)).text(), `network:${path}`);
  }
});

test('worker uses network first and updates only successful public responses', async () => {
  const w = worker();
  await w.lifecycle('install');
  w.network = async () => new Response('fresh');
  assert.equal(await (await w.request('/')).text(), 'fresh');
  w.network = async () => new Response('server error', { status: 503 });
  assert.equal(await (await w.request('/')).text(), 'fresh');
  w.network = async () => new Response('permission denied', { status: 403 });
  assert.equal((await w.request('/')).status, 403);
  w.network = async () => Response.redirect(`${origin}/api/auth`);
  assert.equal((await w.request('/')).status, 302);
  w.network = async () => { throw new TypeError('offline'); };
  assert.equal(await (await w.request('/')).text(), 'fresh');
  assert.equal(w.requests.filter(request => request.url === origin + '/').length, 6);
});

test('worker never intercepts API, history, auth, SSE, POST, or shell variants', async () => {
  const w = worker();
  const excluded = [
    ['/api/auth'], ['/api/login'], ['/api/logout'], ['/api/events'], ['/api/sessions'],
    ['/api/sessions/private/snapshot?before=secret'], ['/api/sessions/private/history'],
    ['/api/sessions/private/prompt', { method: 'POST', body: 'secret' }],
    ['/api/sessions/private/image-prompt', { method: 'POST', body: 'private-photo-bytes' }],
    ['/api/sessions/private/abort', { method: 'POST' }],
    ['/api/sessions/private/images/photo.jpg'], ['blob:https://remote.example/photo'],
    ['/', { method: 'POST', body: 'secret' }], ['/app.js', { method: 'HEAD' }],
    ['/app.js?key=secret'], ['/?session=private'], ['/#secret'],
    ['/app.js', { headers: { Authorization: 'Bearer secret' } }],
    ['https://other.example/app.js'],
    ['/history'], ['/auth'], ['/events'], ['/index.html'], ['/sw.js'], ['/icons/other.png'],
  ];
  for (const [path, options] of excluded) {
    assert.equal(w.request(path, options), undefined, path);
  }
  assert.equal(w.requests.length, 0);
  assert.equal(w.stores.size, 0);
});

test('worker activation deletes only outdated caches with its own prefix', async () => {
  const w = worker();
  await w.lifecycle('install');
  const [current] = await w.caches.keys();
  for (const name of ['paj-remote-shell-v3', 'paj-remote-shell-v2', 'paj-remote-shell-v1', 'paj-remote-shell-v0-partial', 'other-app-v1',
    'paj-remote-history-v1', 'paj-remote-shell']) await w.caches.open(name);
  await w.lifecycle('activate');
  assert.deepEqual(w.deleted.sort(), ['paj-remote-shell-v0-partial', 'paj-remote-shell-v1',
    'paj-remote-shell-v2', 'paj-remote-shell-v3']);
  assert.deepEqual((await w.caches.keys()).sort(),
    [current, 'other-app-v1', 'paj-remote-history-v1', 'paj-remote-shell'].sort());
  assert.equal(w.claims, 1);
});

test('failed shell install does not cache error pages', async () => {
  const w = worker();
  w.network = async () => new Response('auth error', { status: 401 });
  await assert.rejects(w.lifecycle('install'), /Public shell unavailable/);
  assert.equal(w.skips, 0);
  assert.equal([...w.stores.values()][0].size, 0);
});

test('registration requires a secure context and service worker support', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const registration = app.slice(app.indexOf('if (globalThis.isSecureContext'), app.indexOf('const $'));
  vm.runInNewContext(registration, {});
  let calls = 0;
  const navigator = { serviceWorker: { register(path, options) {
    calls++;
    assert.equal(path, '/sw.js');
    assert.equal(options.scope, '/');
    return Promise.reject(new Error('unavailable'));
  } } };
  vm.runInNewContext(registration, { isSecureContext: false, navigator });
  assert.equal(calls, 0);
  vm.runInNewContext(registration, { isSecureContext: true });
  vm.runInNewContext(registration, { isSecureContext: true, navigator });
  await Promise.resolve();
  assert.equal(calls, 1);
});

test('manifest and HTML expose native installation metadata and steering defaults', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.equal(manifest.name, 'paj-rc');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon.png"/);
  assert.match(html, /<select id="deliver-as"><option value="steer" selected>/);
  assert.match(html, /<option value="reject">/);
  assert.match(html, /<option value="followUp">/);
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512],
    ['apple-touch-icon.png', 180]]) {
    const png = await readFile(new URL(`../public/icons/${name}`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
