/*
 * launch.js — turn the decoded forks into a playable engine: build the game
 * DATA + MANIFEST, render every asset to a PNG/WAV in Cache Storage, assemble
 * flight.html, and register the service worker that serves it all. The loader
 * page then navigates to game/flight.html. Browser-only (Cache API + canvas).
 */
'use strict';
(function () {
  const SCHEMA_NAMES = ['desc', 'weap', 'ship', 'govt', 'outf', 'pers', 'oops', 'misn',
    'syst', 'spob', 'dude', 'nebu', 'junk', 'flet', 'spin', 'spit', 'dsig'];

  // First-run caching: a completed build stays in Cache Storage, so a return
  // visit can play instantly without re-importing the .sit.
  const BUILT_MARKER = '_built.json';
  const gameBase = () => new URL('game/', location.href).href;

  // Every file the cached build derives from, so a change to any one invalidates
  // a returning visitor's cache. tpl+core assemble flight.html; DATA is a
  // function of evrsrc/semantics/nodeshim + the schemas; the assets are produced
  // by the decoders (which import evsit for decompression). Fetched once so
  // flight.html and its recorded hash come from the *same* strings (no mid-build
  // server change slips through). The extra parallel fetches come from HTTP cache.
  const ENGINE_FILES = ['../flight_template.html', '../engine/core.js',
    '../evrsrc.js', '../semantics.js', 'nodeshim.js',
    'evsit.js', 'evpict.js', 'evsnd.js', 'evsprite.js', 'evbuild.js',
    ...SCHEMA_NAMES.map(n => '../schemas/' + n + '.json')];
  async function fetchEngineSources() {
    // The flight shell is split into engine/shell/*.js, concatenated (in
    // order.json order) into flight.html's script. Fetch those too, in order.
    const order = await fetch('../engine/shell/order.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' for shell order.json'); return r.json(); });
    const paths = [...ENGINE_FILES, ...order.map(f => '../engine/shell/' + f)];
    const texts = await Promise.all(paths.map(f => fetch(f).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + f); return r.text(); })));
    return {
      tpl: texts[0], core: texts[1],
      rest: texts.slice(2, ENGINE_FILES.length),   // evrsrc/semantics/nodeshim/decoders/schemas (hashed)
      shell: texts.slice(ENGINE_FILES.length),      // shell modules, in load order
    };
  }
  const toHex = digest => [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  // SHA-256 of the concatenated sources — the build's identity in the marker.
  async function sourcesHash(src) {
    const bytes = new TextEncoder().encode([src.tpl, src.core, ...src.rest, ...src.shell].join('\u0000'));
    return toHex(await crypto.subtle.digest('SHA-256', bytes));
  }
  // SHA-256 of the plugin forks, length-prefixed so order and boundaries matter
  // (plugin order is override precedence). '' when there are no plugins.
  async function pluginsHash(forks) {
    if (!forks.length) return '';
    let n = 0; for (const f of forks) n += 4 + f.length;
    const buf = new Uint8Array(n), dv = new DataView(buf.buffer); let o = 0;
    for (const f of forks) { dv.setUint32(o, f.length); o += 4; buf.set(f, o); o += f.length; }
    return toHex(await crypto.subtle.digest('SHA-256', buf));
  }

  // Register the game SW and resolve once it's activated. We can't await
  // navigator.serviceWorker.ready: that waits for a worker controlling THIS
  // page, but the loader lives outside the SW scope (game/), so `ready` would
  // never resolve here. Track the returned registration's own worker instead.
  async function registerSW() {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: 'game/' });
    const w = reg.installing || reg.waiting || reg.active;
    if (!w || w.state === 'activated') return reg;
    await new Promise((resolve) => {
      const onchange = () => { if (w.state === 'activated') { w.removeEventListener('statechange', onchange); resolve(); } };
      w.addEventListener('statechange', onchange);
      onchange();                       // in case it activated before the listener attached
    });
    return reg;
  }

  function rgbaToPng(img) {
    return new Promise((res, rej) => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      if (!ctx) { rej(new Error('2D canvas context unavailable')); return; }
      ctx.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
      // toBlob yields null if encoding fails; reject so the failure surfaces
      // instead of caching a Response(null) that looks like a valid PNG.
      c.toBlob(b => b ? res(b) : rej(new Error('PNG encoding failed (' + img.width + '×' + img.height + ')')), 'image/png');
    });
  }
  const pngResp = blob => new Response(blob, { headers: { 'content-type': 'image/png' } });
  // decodeSnd yields 8-bit unsigned (pcm8) or 16-bit signed (pcm16) PCM, mono or
  // multi-channel — emit a matching WAV header + body for whichever it is.
  function wavResp(dec) {
    const ch = dec.channels || 1;
    let bits, data;
    if (dec.pcm16) {                              // 16-bit signed, written little-endian
      bits = 16; const src = dec.pcm16; data = new Uint8Array(src.length * 2);
      const dvd = new DataView(data.buffer); for (let i = 0; i < src.length; i++) dvd.setInt16(i * 2, src[i], true);
    } else {                                      // 8-bit unsigned
      bits = 8; data = dec.pcm8 || new Uint8Array(0);
    }
    const n = data.length, blockAlign = ch * (bits >> 3), byteRate = dec.sampleRate * blockAlign;
    const buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    let p = 0; const s = t => { for (const c of t) v.setUint8(p++, c.charCodeAt(0)); };
    const u32 = x => { v.setUint32(p, x, true); p += 4; }, u16 = x => { v.setUint16(p, x, true); p += 2; };
    s('RIFF'); u32(36 + n); s('WAVE'); s('fmt '); u32(16); u16(1); u16(ch); u32(dec.sampleRate); u32(byteRate); u16(blockAlign); u16(bits); s('data'); u32(n);
    new Uint8Array(buf, 44).set(data);
    return new Response(buf, { headers: { 'content-type': 'audio/wav' } });
  }

  // Render `jobs` ({url,img}) to PNG and cache them, with a bounded amount of
  // concurrency so the browser encodes many at once (much faster than serial).
  async function renderAll(cache, jobs, log) {
    let done = 0;
    const CONC = 24;
    for (let i = 0; i < jobs.length; i += CONC) {
      await Promise.all(jobs.slice(i, i + CONC).map(async j => {
        const resp = pngResp(await rgbaToPng(j.img));
        for (const u of j.urls) await cache.put(u, resp.clone());
      }));
      done += Math.min(CONC, jobs.length - i);
      if (log) log('  …' + done + '/' + jobs.length + ' images');
    }
  }

  async function produceAssets(cache, base, forks, spinSchema, log, opts = {}, pluginForks = []) {
    const jobs = [];
    // Count skips per category. Individual bad resources are tolerated, but a
    // whole category failing (e.g. a decoder regression breaking every PICT)
    // should be visible rather than silently "building fine".
    const skip = { pict: 0, sprite: 0, snd: 0 }, tried = { pict: 0, sprite: 0, snd: 0 };
    // Merge base + plugin graphics/titles/sounds by (type, ID); plugin sprites,
    // shop art, and sounds fold in here (see EVBUILD.routeAssets).
    const routed = EVBUILD.routeAssets(forks['EV Graphics'], forks['EV Titles'], forks['EV Sounds'], pluginForks);
    for (const [types, dir] of [[routed.graphics, 'graphics'], [routed.titles, 'titles']]) {
      // findType returns undefined for an absent type; degrade to no jobs rather
      // than a TypeError. (The drop-time preview already rejects an archive
      // missing EV Graphics' PICT/spin with a clear message before we get here.)
      const pictType = EVRSRC.findType(types, 'PICT');
      const picts = pictType ? pictType.resources : [];
      // `fast` skips the individual graphics PICTs (shipyard/comm/outfit detail,
      // shown only when landed/hailing) — sprites and titles still render.
      if (!(opts.fast && dir === 'graphics')) for (const r of picts) {
        tried.pict++;
        let img; try { img = decodePict(r.data()); } catch { skip.pict++; continue; }
        if (!img.rgba) { skip.pict++; continue; }
        const urls = [base + 'evassets/' + dir + '/PICT_' + r.id + '.png'];
        // Named alias (e.g. "PICT_128_Game Panel.png"): encode the name so the
        // URL is valid, and matches how the browser normalizes the engine's raw
        // request URL (spaces → %20). encodeURIComponent covers spaces/#/%//.
        if (r.name) urls.push(base + 'evassets/' + dir + '/PICT_' + r.id + '_' + encodeURIComponent(r.name) + '.png');
        jobs.push({ urls, img });
      }
      if (dir === 'graphics') {
        const pmap = {}; for (const r of picts) pmap[r.id] = r;
        const spinType = EVRSRC.findType(types, 'spin');
        for (const sr of (spinType ? spinType.resources : [])) {
          tried.sprite++;
          let rec; try { rec = EVRSRC.decodeRecord(sr.data(), spinSchema); } catch { skip.sprite++; continue; }
          const sp = pmap[rec.SpritesID], mk = pmap[rec.MasksID]; if (!sp) { skip.sprite++; continue; }
          let comp; try { comp = compositeSprite(decodePict(sp.data()), mk ? decodePict(mk.data()) : null); } catch { skip.sprite++; continue; }
          jobs.push({ urls: [base + 'evassets/sprites/spin_' + sr.id + '.png'], img: comp });
        }
      }
    }
    await renderAll(cache, jobs, log);
    // Decode one snd, returning valid PCM or null — like the PICT path, a bad
    // resource (decodeSnd {error}, e.g. compressed, or a throw on corrupt data)
    // is skipped rather than caching a bogus WAV or aborting the whole build.
    const decodePcm = data => { try { const d = decodeSnd(data); return (d && d.sampleRate && (d.pcm8 || d.pcm16)) ? d : null; } catch { return null; } };
    // sounds are cheap (no canvas); routed.sounds already folds in plugin snd.
    // snd 30000 is the title music (a different asset path, below), not an
    // effect — skip it here so it isn't also written under sounds/.
    const sndType = EVRSRC.findType(routed.sounds, 'snd ');
    for (const r of (sndType ? sndType.resources : [])) { if (r.id === 30000) continue; tried.snd++; const d = decodePcm(r.data()); if (d) await cache.put(base + 'evassets/sounds/snd_' + r.id + '.wav', wavResp(d)); else skip.snd++; }
    // Music (snd 30000 → evassets/music/snd_30000.wav, per flight_template.html):
    // prefer a plugin-provided/merged snd 30000, falling back to the base EV
    // Music fork when no plugin overrides it.
    let music = sndType && sndType.resources.find(r => r.id === 30000);
    if (!music && forks['EV Music']) {
      const mus = EVRSRC.parseFork(Buffer.from(forks['EV Music'])), sm = EVRSRC.findType(mus, 'snd ');
      music = sm && sm.resources.find(r => r.id === 30000);
    }
    if (music) { const d = decodePcm(music.data()); if (d) await cache.put(base + 'evassets/music/snd_30000.wav', wavResp(d)); }
    // One summary line, and a loud warning if a whole category was attempted but
    // entirely failed — the signature of a decoder regression, not stray data.
    if (log) {
      log('  assets: ' + (tried.pict - skip.pict) + '/' + tried.pict + ' pictures, ' +
        (tried.sprite - skip.sprite) + '/' + tried.sprite + ' sprites, ' +
        (tried.snd - skip.snd) + '/' + tried.snd + ' sounds');
      for (const k of ['pict', 'sprite', 'snd'])
        if (tried[k] > 0 && skip[k] === tried[k]) log('  ⚠ every ' + k + ' failed to decode — likely a regression', 'err');
    }
  }

  // Assemble flight.html from already-fetched sources (see fetchEngineSources),
  // so the engine we cache is exactly the one we hash for the marker.
  function assembleFlight(src, DATA, MANIFEST) {
    // Fail loudly if the template lost a placeholder (a .replace of a missing
    // marker is a silent no-op → a subtly broken flight.html); evexport --flight
    // guards the same way.
    for (const ph of ['/*__ENGINE__*/', '/*__SHELL__*/', '/*__EVDATA__*/null', '/*__MANIFEST__*/null', '/*__NAMES__*/null'])
      if (!src.tpl.includes(ph)) throw new Error('flight template missing placeholder ' + ph);
    // DATA/MANIFEST hold strings from the untrusted archive and are injected
    // into a <script> as JS literals. Escape the sequences that would break out
    // of the script element or of a JS string: '<' (so "</script>" can't close
    // the tag) and the U+2028/U+2029 line terminators.
    const inject = obj => JSON.stringify(obj)
      .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return src.tpl
      .replace('/*__ENGINE__*/', () => src.core)
      .replace('/*__SHELL__*/', () => src.shell.join('\n'))   // concatenated shell modules
      .replace('/*__EVDATA__*/null', () => inject(DATA))
      .replace('/*__MANIFEST__*/null', () => inject(MANIFEST))
      .replace('/*__NAMES__*/null', () => 'null');
  }

  /* Build everything and stage it in Cache Storage + register the SW.
   * Returns the URL to navigate to. */
  async function buildAndCache(forks, spinSchema, plugins = [], log = () => {}, opts = {}) {
    // plugins: array of raw resource-fork bytes, in load order. Their records
    // override/add game data by (type, ID); their graphics/sounds fold into the
    // asset render. An empty list leaves the build byte-for-byte as before.
    const pluginForks = plugins;
    // Ask the browser to keep this origin's storage under pressure — the whole
    // first-run cache lives here, so persistence cuts "it forgot my game".
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch {} }
    const schemasByType = {};
    // Every schema is required for correct DATA generation — fail fast (naming
    // the culprits) instead of silently building a partial game database.
    const failed = [];
    await Promise.all(SCHEMA_NAMES.map(async n => {
      try {
        const r = await fetch('../schemas/' + n + '.json');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const s = await r.json();
        schemasByType[s.name] = { alias: n, schema: s };
      } catch (e) { failed.push(n + ' (' + e.message + ')'); }
    }));
    if (failed.length) throw new Error('Could not load game schemas: ' + failed.join(', '));
    log('Building game database…');
    const DATA = EVBUILD.buildData(forks['EV Data'], schemasByType, pluginForks);
    const MANIFEST = EVBUILD.buildManifest(forks['EV Graphics'], spinSchema, pluginForks);
    // Fetch the engine sources once; flight.html and the marker hash both derive
    // from these exact strings (no mid-build server-change window).
    const src = await fetchEngineSources();
    const cache = await caches.open('ve-game');
    const base = gameBase();
    // Invalidate any previous completion marker up front: if this (re)build is
    // interrupted, no stale marker survives to make a partial cache look done.
    await cache.delete(base + BUILT_MARKER);
    // Stage the engine + service worker first (fast) so the game is launchable
    // promptly; the assets stream into the cache right after.
    log('Assembling the engine…');
    await cache.put(base + 'flight.html', new Response(assembleFlight(src, DATA, MANIFEST), { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    log('Starting the service worker…');
    await registerSW();
    if (!opts.skipAssets) {
      log('Rendering assets…');
      await produceAssets(cache, base, forks, spinSchema, log, opts, pluginForks);
    }
    // Completion marker, written last so its presence guarantees a full build
    // is cached. Only a complete build qualifies for the instant-replay path —
    // `fast` (skips graphics PICTs) and `skipAssets` builds don't get a marker.
    if (!opts.skipAssets && !opts.fast) {
      // Record the plugin identity too (count + content hash), so the cached
      // build's provenance is explicit — a return visit knows it was built with
      // plug-ins rather than silently replaying them (see checkBuilt/resume).
      await cache.put(base + BUILT_MARKER, new Response(
        JSON.stringify({ h: await sourcesHash(src), built: Date.now(),
          plugins: pluginForks.length, ph: await pluginsHash(pluginForks) }),
        { headers: { 'content-type': 'application/json' } }));
    }
    log('Ready.');
    return 'game/flight.html';
  }

  /* Is a complete, current build already cached from a previous visit?
   * Returns the marker ({h, built}) if so, else null — never throws. */
  async function checkBuilt() {
    if (typeof caches === 'undefined') return null;   // needs a secure context
    try {
      const cache = await caches.open('ve-game');
      const base = gameBase();
      const mr = await cache.match(base + BUILT_MARKER);
      if (!mr) return null;
      const m = await mr.json();
      if (!m || !m.h) return null;
      // The engine itself must still be cached.
      if (!(await cache.match(base + 'flight.html'))) return null;
      // Compare against the current sources. If they can't be fetched (offline —
      // the whole point of the cache), trust the marker; only a successful but
      // *different* hash invalidates.
      let h; try { h = await sourcesHash(await fetchEngineSources()); } catch { return m; }
      return m.h === h ? m : null;
    } catch { return null; }
  }

  /* Play an already-cached build: (re)register the SW to serve the game subtree
   * and return the URL to navigate to. No .sit needed. */
  async function launchExisting(log = () => {}) {
    log('Starting the service worker…');
    await registerSW();
    return 'game/flight.html';
  }

  self.VELAUNCH = { buildAndCache, produceAssets, assembleFlight, checkBuilt, launchExisting };
})();
