// Service worker: membuat aplikasi bisa dibuka cepat, juga saat sinyal jelek.
// Naikkan angka VERSION setiap kali kamu mengubah file aplikasi, supaya HP mengambil versi baru.
const VERSION = 'v1';
const CACHE = `cashflow-${VERSION}`;
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'firebase-config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const firebaseLib = url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  // Data Firestore dan login tidak lewat sini; hanya berkas aplikasi dan pustaka Firebase.
  if (!sameOrigin && !firebaseLib) return;

  // Ambil dari cache dulu, sambil memperbarui di belakang layar.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
