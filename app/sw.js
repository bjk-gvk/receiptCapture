// Caches the app so it opens instantly and works without signal.
// Bump VERSION whenever any app file changes, so phones pick up the new version.
const VERSION = 'v2';
const CACHE = `receipts-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'db.js',
  'dictation.js',
  'export.js',
  'zip.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
