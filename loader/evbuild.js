/*
 * evbuild.js — build the engine's DATA (evdata.json) and MANIFEST in the
 * browser, mirroring evexport.js + evatlas.js. Runs in Node too (for
 * verification): deps resolve from globals in the browser, require() in Node.
 */
'use strict';
(function () {
  const EV = typeof EVRSRC !== 'undefined' ? EVRSRC : require('../evrsrc.js');
  const SEM = typeof SEMANTICS !== 'undefined' ? SEMANTICS : require('../semantics.js');
  const B = typeof Buffer !== 'undefined' ? Buffer : require('buffer').Buffer;

  /* Build the full game database from the EV Data resource fork.
   * schemasByType: { <MacRoman type name>: { alias, schema } }.
   * pluginForks: optional resource forks whose records override/add by
   * (type, ID) in load order (base first) — EV's plugin rule. */
  function buildData(dataFork, schemasByType, pluginForks = []) {
    const base = EV.parseFork(B.from(dataFork));
    const types = pluginForks.length
      ? EV.mergeTypes(base, ...pluginForks.map((f) => EV.parseFork(B.from(f))))
      : base;
    const out = {
      source: 'EV Data.rsrc',
      generated: new Date().toISOString(),
      types: {},
      strings: {},
    };
    for (const t of types) {
      if (t.typeHex === '53545223') {
        // STR#
        for (const r of t.resources)
          out.strings[r.id] = { name: r.name, list: EV.decodeStrList(r.data()) };
        continue;
      }
      const s = schemasByType[t.typeName];
      if (!s) continue;
      const records = {};
      for (const r of t.resources) {
        const rec = EV.decodeRecord(r.data(), s.schema);
        delete rec.__schemaBytes;
        delete rec.__recordBytes;
        records[r.id] = { name: r.name, ...rec };
      }
      out.types[s.alias] = records;
    }
    SEM.decorate(out);
    return out;
  }

  /* Build the sprite manifest from the EV Graphics spïn resources.
   * Plugin spïn resources override/add by ID (so new ships get manifest entries). */
  function buildManifest(gfxFork, spinSchema, pluginForks = []) {
    const base = EV.parseFork(B.from(gfxFork));
    const types = pluginForks.length
      ? EV.mergeTypes(base, ...pluginForks.map((f) => EV.parseFork(B.from(f))))
      : base;
    const spins = EV.findType(types, 'spin');
    const manifest = { spins: {} };
    if (spins)
      for (const r of spins.resources) {
        const s = EV.decodeRecord(r.data(), spinSchema);
        manifest.spins[r.id] = {
          name: r.name || '',
          frameW: s.xSize,
          frameH: s.ySize,
          xTiles: s.xTiles,
          yTiles: s.yTiles,
          frames: s.xTiles * s.yTiles,
        };
      }
    return manifest;
  }

  /* Route the base graphics/titles/sounds forks plus any plugin forks into
   * three merged type-arrays, applying plugin overrides/additions by (type, ID):
   *   - snd  → sounds
   *   - spïn → graphics (sprites always render from the graphics set)
   *   - PICT → titles if that ID exists in base Titles (so a plugin can retheme
   *            the panel/menu art), else graphics (new sprite / shop / detail art)
   * Data records + STR# are handled separately by buildData. Pure (no DOM), so
   * it's Node-testable. */
  function routeAssets(graphicsFork, titlesFork, soundsFork, pluginForks = []) {
    const g = EV.parseFork(B.from(graphicsFork));
    const t = EV.parseFork(B.from(titlesFork));
    const s = soundsFork ? EV.parseFork(B.from(soundsFork)) : [];
    const plugins = pluginForks.map((f) => EV.parseFork(B.from(f)));
    const titlePict = EV.findType(t, 'PICT');
    const titleIds = new Set(titlePict ? titlePict.resources.map((r) => r.id) : []);
    // keep only the resources of a parsed plugin that match a predicate, preserving type shape
    const pick = (types, fn) => {
      const out = [];
      for (const ty of types) {
        const kept = ty.resources.filter((r) => fn(ty.typeName, r));
        if (kept.length)
          out.push({
            typeBytes: ty.typeBytes,
            typeName: ty.typeName,
            typeHex: ty.typeHex,
            resources: kept,
          });
      }
      return out;
    };
    const gExtra = [],
      tExtra = [],
      sExtra = [];
    for (const p of plugins) {
      gExtra.push(pick(p, (tn, r) => tn === 'spïn' || (tn === 'PICT' && !titleIds.has(r.id))));
      tExtra.push(pick(p, (tn, r) => tn === 'PICT' && titleIds.has(r.id)));
      sExtra.push(pick(p, (tn) => tn === 'snd '));
    }
    return {
      graphics: EV.mergeTypes(g, ...gExtra),
      titles: EV.mergeTypes(t, ...tExtra),
      sounds: EV.mergeTypes(s, ...sExtra),
    };
  }

  const API = { buildData, buildManifest, routeAssets };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof self !== 'undefined') self.EVBUILD = API;
})();
