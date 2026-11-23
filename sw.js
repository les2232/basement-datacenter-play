'use strict';

// GitHub Pages sites share an origin. Only clean up caches belonging to this scope.
const scope = self.registration.scope;
const cachePrefix = 'basement-datacenter:' + scope + ':';
const cacheName = cachePrefix + '3e03dc9';
const shell = [
  'index.html', 'game.js', 'economy.js', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon.png',
].map(path => new URL(path, scope).href);
const shellUrls = new Set(shell);
const indexUrl = new URL('index.html', scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(shell.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, key) {
  let response;
  try {
    response = await fetch(request, { cache: 'no-cache' });
  } catch {
    // Offline navigation and requests for the app shell use the last good response.
  }
  if (response && response.ok) {
    try {
      const cache = await caches.open(cacheName);
      await cache.put(key, response.clone());
    } catch { /* A full cache must not block the network response. */ }
    return response;
  }
  return await caches.match(key, { cacheName }) || response || Response.error();
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  const key = url.href === scope ? indexUrl : url.href;
  if (shellUrls.has(key)) event.respondWith(networkFirst(event.request, key));
});
