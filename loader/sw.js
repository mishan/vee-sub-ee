/*
 * sw.js — the loader's PWA service worker, scoped to the whole loader/ subtree.
 * Two jobs:
 *   1) App shell — this loader page and its in-scope scripts, manifest and icons
 *      are precached so the app installs and opens offline. Navigations are
 *      network-first (an online visit always gets the freshest loader; offline
 *      falls back to the cached page); other in-scope assets are
 *      stale-while-revalidate.
 *   2) The assembled game under game/ (flight.html + evassets/*) is served from
 *      the immutable per-build 've-game' cache the loader wrote, so the
 *      unmodified engine's relative asset URLs resolve to the decoded bytes.
 *
 * The loader's decoders live at the repo root (../evrsrc.js, ../semantics.js,
 * ../schemas/*), OUTSIDE this scope, so the SW can't serve them: importing a
 * fresh .sit needs the network. Playing an already-built game offline does not —
 * that path touches only in-scope files + Cache Storage.
 */
'use strict';

const SHELL = 've-shell-v1'; // bump when the loader app shell changes
const GAME = 've-game'; // written by launch.js (the built game)
const SCOPE = new URL(self.registration.scope); // …/loader/
const GAME_PATH = new URL('game/', SCOPE).pathname; // …/loader/game/
const INDEX = new URL('./', SCOPE).href; // …/loader/

// The offline app shell — every in-scope file the loader page needs to open.
// (Root-level decoders are intentionally absent; see the header note.)
const SHELL_URLS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'nodeshim.js',
  'evsit.js',
  'evpict.js',
  'evsnd.js',
  'evsprite.js',
  'evbuild.js',
  'launch.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Add individually + tolerantly so one missing/renamed file can't wedge the
      // whole install (a fresh checkout may lag the URL list).
      await Promise.allSettled(
        SHELL_URLS.map(async (u) => {
          const url = new URL(u, SCOPE).href;
          const resp = await fetch(new Request(url, { cache: 'reload' }));
          if (resp.ok) await cache.put(url, resp);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // Drop superseded shell caches; keep the current shell + the game build.
      for (const k of await caches.keys())
        if (k.startsWith('ve-shell') && k !== SHELL) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

const fromCache = (name, req) => caches.open(name).then((c) => c.match(req));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  // Only our own scope: same origin AND under the registered scope path.
  if (u.origin !== SCOPE.origin || !u.pathname.startsWith(SCOPE.pathname)) return;

  // The assembled game build: immutable per build, served from 've-game'.
  if (u.pathname.startsWith(GAME_PATH)) {
    e.respondWith(fromCache(GAME, req).then((r) => r || fetch(req)));
    return;
  }

  // App-shell navigations: network-first, falling back to the cached loader page
  // when offline so the installed app still opens.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => fromCache(SHELL, INDEX).then((r) => r || fromCache(SHELL, req))),
    );
    return;
  }

  // Other in-scope assets: stale-while-revalidate — instant from cache, refreshed
  // in the background so an update lands on the next load.
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((resp) => {
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
