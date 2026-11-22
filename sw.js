// Offline support: always try the network first so a new version is used as soon as it's deployed
// (never a mix of old and new files), and fall back to the cache when offline.
const CACHE = 'pictris-v19';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/main.js', 'src/game.js', 'src/renderer.js', 'src/photos.js', 'src/gphotos.js', 'src/album.js', 'src/audio.js', 'src/faces.js'];

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
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) c.put(key, r.clone());
      return r;
    } catch {
      return (await c.match(key)) || Response.error();
    }
  }));
});
