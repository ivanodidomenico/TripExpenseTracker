import { APP_VERSION } from './version.js';

const CACHE = `tripx-v${APP_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './version.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Tesseract.js CDN assets to cache for offline OCR
const TESSERACT_ASSETS = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(ASSETS);
      for (const url of TESSERACT_ASSETS) {
        try { await c.add(url); } catch { /* non-fatal: will work online */ }
      }
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
  self.clients.matchAll().then(clients => {
    clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: APP_VERSION }));
  });
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // For local assets: network-first, fallback to cache
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // For Tesseract CDN assets (worker, wasm, lang data): cache-first, then network
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('tessdata')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // For external API requests (e.g., Frankfurter): network-first with timeout
  e.respondWith(
    Promise.race([
      fetch(e.request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Network timeout')), 10000)
      )
    ]).catch(() =>
      caches.match(e.request).then(cached =>
        cached || new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )
  );
});