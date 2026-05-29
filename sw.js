// ═══════════════════════════════════════════════════════════
// Health Command Center – Service Worker
// Shell-Caching mit Pass-Through für externe APIs.
//
// ⚠️ CACHE-VERSIONIERUNG: bei jedem Code-Deploy hochzählen,
//    sonst ziehen installierte PWAs die alte Version!
//    'hcc-v1' → 'hcc-v2' → 'hcc-v3' …
// ═══════════════════════════════════════════════════════════

const CACHE = 'hcc-v36';

// Lokale Shell-Assets, die vorab gecacht werden
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-32.png',
  './icons/icon-120.png',
  './icons/icon-152.png',
  './icons/icon-167.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-1024.png'
];

// Hosts, die NICHT gecacht werden (Auth, Sheets-API, Apps-Script-Refresh)
const PASS_THROUGH_HOSTS = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'sheets.googleapis.com',
  'script.google.com',
  'script.googleusercontent.com'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Auth + externe APIs immer durchreichen (Network-First, kein Cache)
  if (PASS_THROUGH_HOSTS.some(host => url.hostname.includes(host))) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Shell: Cache-First mit Fallback auf Network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Nur GETs mit Status 200 cachen, und nur same-origin Requests
        if (res && res.status === 200 && e.request.method === 'GET' && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
