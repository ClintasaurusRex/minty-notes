/* Minty Notes service worker. Generated at build time; do not edit dist/sw.js. */
const VERSION = '__VERSION__'
const ASSETS = __ASSETS__
const CACHE = `minty-notes-app-${VERSION}`
const INDEX = new URL('./index.html', self.registration.scope).href

self.addEventListener('install', (event) => {
  // Cache every app file. If any request fails, installation fails and the
  // previous version (if any) keeps serving, so a partial cache is never used.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(new URL(url, self.registration.scope), { cache: 'reload' })))),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith('minty-notes-app-') && k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    // App shell: cached index first so the app opens offline.
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(INDEX, { ignoreVary: true })).then((hit) => hit || fetch(request)))
    return
  }
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(request, { ignoreSearch: true, ignoreVary: true })).then((hit) => hit || fetch(request)))
})
