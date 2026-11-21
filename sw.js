// Offline support: cache the app shell, serve stale-while-revalidate.
const CACHE = 'pictris-v5';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/main.js', 'src/game.js', 'src/renderer.js', 'src/photos.js', 'src/gphotos.js', 'src/album.js', 'src/audio.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    // Page loads may carry ?album=…; they are all the same shell.
    const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
    const hit = await c.match(key);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
