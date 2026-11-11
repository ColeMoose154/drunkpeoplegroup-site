// Offline support for the Android app (registered only there, see src/lib/offline.js).
// The app's own files are built into the app, so this only keeps copies of what comes
// from the internet:
//  - drinks, guides, your profile and other saved data: fresh from the server when
//    online, the last copy when offline
//  - pictures added after this version (the rest are built into the app): kept after the
//    first time they're shown, or pre-loaded on Wi-Fi
const DATA = 'dpg-data-v2';
const MEDIA = 'dpg-media-v2';
const MAX_MEDIA = 1500;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dpg-') && k !== DATA && k !== MEDIA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'warm' && Array.isArray(msg.urls)) event.waitUntil(warm(msg.urls));
  if (msg.type === 'signed-out') event.waitUntil(caches.delete(DATA));
});

const isMedia = (url) =>
  (url.pathname.includes('/storage/v1/object/public/')) ||
  (url.pathname.endsWith('/functions/v1/api/FindNearbyBars') && url.searchParams.has('photo'));
const isData = (url) =>
  url.hostname.endsWith('.supabase.co') &&
  (url.pathname.startsWith('/rest/v1/') || url.pathname === '/auth/v1/user');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) return; // built into the app
  // Only pictures shown on screen; the app's own fetch() calls (e.g. sharing a picture) go straight through.
  if (isMedia(url) && req.destination === 'image') event.respondWith(mediaFirst(req));
  else if (isData(url)) event.respondWith(networkFirst(req));
});

async function mediaFirst(req) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(DATA);
  try {
    const res = await withTimeout(fetch(req), 8000);
    if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req.url, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function warm(urls) {
  const cache = await caches.open(MEDIA);
  const todo = [];
  for (const u of new Set(urls)) {
    if (typeof u === 'string' && /^https:\/\//.test(u) && !(await cache.match(u))) todo.push(u);
  }
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map((u) =>
      fetch(u, { mode: 'cors' }).catch(() => fetch(u, { mode: 'no-cors' }))
        .then((res) => (res.ok || res.type === 'opaque' ? cache.put(u, res) : null))
        .catch(() => {})));
  }
  await trim();
}

async function trim() {
  const cache = await caches.open(MEDIA);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_MEDIA; i += 1) await cache.delete(keys[i]);
}
