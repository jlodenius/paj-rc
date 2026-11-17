const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE_PREFIX = 'paj-remote-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v8`;
const SHELL_PATHS = new Set([
  '/',
  '/app.js',
  '/state.js',
  '/paths.js',
  '/session-info.js',
  '/submissions.js',
  '/text.js',
  '/commands.js',
  '/markdown.js',
  '/images.js',
  '/image-limits.js',
  '/fonts/fira-code-latin.woff2',
  '/fonts/space-grotesk-latin.woff2',
  '/fonts/firacode-OFL.txt',
  '/fonts/spacegrotesk-OFL.txt',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
]);

function publicRequest(url: URL) {
  return new Request(url, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
}

function cacheable(response: Response) {
  return response.ok && !response.redirected &&
    (response.type === 'basic' || response.type === 'default');
}

worker.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all([...SHELL_PATHS].map(async path => {
      const request = publicRequest(new URL(path, worker.location.origin));
      const response = await fetch(request);
      if (!cacheable(response)) throw new Error('Public shell unavailable');
      await cache.put(request.url, response);
    }));
    await worker.skipWaiting();
  })());
});

worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await worker.clients.claim();
  })());
});

worker.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || url.search || url.hash || url.username || url.password ||
      !SHELL_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    let response;
    try {
      response = await fetch(publicRequest(url));
    } catch (error) {
      const cached = await (await caches.open(CACHE_NAME)).match(url.href);
      if (cached) return cached;
      throw error;
    }
    if (response.status >= 500) {
      const cached = await (await caches.open(CACHE_NAME)).match(url.href);
      if (cached) return cached;
    }
    if (cacheable(response)) {
      try {
        await (await caches.open(CACHE_NAME)).put(url.href, response.clone());
      } catch {}
    }
    return response;
  })());
});
