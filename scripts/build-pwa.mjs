import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = new URL('../dist/', import.meta.url);
const entries = await readdir(output, { recursive: true });
const files = entries
  .filter((entry) => /\.(?:html|mjs|js|css|svg|png|webmanifest)$/.test(entry))
  .map((entry) => entry.replaceAll('\\', '/'))
  .sort();
const digest = createHash('sha256');
for (const file of files) {
  digest.update(file);
  digest.update(await readFile(new URL(file, output)));
}
const version = digest.digest('hex').slice(0, 16);
const assets = files.map((file) => `./${file}`);
const worker = `const CACHE_NAME = 'seed-gallery-shell-${version}';
const SHELL = ${JSON.stringify(assets)};
const SCOPE = new URL(self.registration.scope);
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, SCOPE).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('seed-gallery-shell-') && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data !== 'SKIP_WAITING') return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length > 1) {
      event.source?.postMessage('UPDATE_OTHER_TABS');
      return;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(new URL('./index.html', SCOPE))) || Response.error();
    }));
    return;
  }
  if (!SHELL_URLS.has(url.href)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) =>
    (await cache.match(request)) || fetch(request)
  ));
});
`;
await writeFile(join(fileURLToPath(output), 'sw.js'), worker);
