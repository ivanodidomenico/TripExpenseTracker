const CACHE = 'tripx-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
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
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(ASSETS);
      // Cache Tesseract core; lang data is fetched on first OCR use and cached below
      for (const url of TESSERACT_ASSETS) {
        try { await c.add(url); } catch { /* non-fatal: will work online */ }
      }
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k)))))
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // For local assets: cache-first
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
    return;
  }

  // For Tesseract CDN assets (worker, wasm, lang data): cache-first, then network
  // This ensures offline OCR works once the model has been downloaded at least once.
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
});