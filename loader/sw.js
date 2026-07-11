/*
 * sw.js — serve the assembled game (flight.html + evassets/*) from Cache
 * Storage, so the engine's relative asset URLs resolve to the bytes the loader
 * decoded in-browser. Scope: the loader's game/ subtree.
 */
'use strict';
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const SCOPE = new URL(self.registration.scope); // …/loader/game/
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Only our own scope: same origin AND under the registered scope path — a
  // substring test on the URL could also match a cross-origin request that
  // merely contains "/game/" and hand it a colliding cache entry.
  const u = new URL(e.request.url);
  if (u.origin !== SCOPE.origin || !u.pathname.startsWith(SCOPE.pathname)) return;
  // Match against our cache explicitly (not caches.match, which searches all
  // Cache Storage and could serve a foreign entry with the same URL).
  e.respondWith(
    caches
      .open('ve-game')
      .then((c) => c.match(e.request))
      .then((r) => r || fetch(e.request)),
  );
});
