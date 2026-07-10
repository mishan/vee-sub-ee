/*
 * evbuild.js — build the engine's DATA (evdata.json) and MANIFEST in the
 * browser, mirroring evexport.js + evatlas.js. Runs in Node too (for
 * verification): deps resolve from globals in the browser, require() in Node.
 */
'use strict';
(function () {
  const EV = (typeof EVRSRC !== 'undefined') ? EVRSRC : require('../evrsrc.js');
  const SEM = (typeof SEMANTICS !== 'undefined') ? SEMANTICS : require('../semantics.js');
  const B = (typeof Buffer !== 'undefined') ? Buffer : require('buffer').Buffer;

  /* Build the full game database from the EV Data resource fork.
   * schemasByType: { <MacRoman type name>: { alias, schema } }. */
  function buildData(dataFork, schemasByType) {
    const types = EV.parseFork(B.from(dataFork));
    const out = { source: 'EV Data', generated: new Date().toISOString(), types: {}, strings: {} };
    for (const t of types) {
      if (t.typeHex === '53545223') { // STR#
        for (const r of t.resources) out.strings[r.id] = { name: r.name, list: EV.decodeStrList(r.data()) };
        continue;
      }
      const s = schemasByType[t.typeName];
      if (!s) continue;
      const records = {};
      for (const r of t.resources) {
        const rec = EV.decodeRecord(r.data(), s.schema);
        delete rec.__schemaBytes; delete rec.__recordBytes;
        records[r.id] = { name: r.name, ...rec };
      }
      out.types[s.alias] = records;
    }
    SEM.decorate(out);
    return out;
  }

  /* Build the sprite manifest from the EV Graphics spïn resources. */
  function buildManifest(gfxFork, spinSchema) {
    const types = EV.parseFork(B.from(gfxFork));
    const spins = EV.findType(types, 'spin');
    const manifest = { spins: {} };
    if (spins) for (const r of spins.resources) {
      const s = EV.decodeRecord(r.data(), spinSchema);
      manifest.spins[r.id] = {
        name: r.name || '', frameW: s.xSize, frameH: s.ySize,
        xTiles: s.xTiles, yTiles: s.yTiles, frames: s.xTiles * s.yTiles,
      };
    }
    return manifest;
  }

  const API = { buildData, buildManifest };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof self !== 'undefined') self.EVBUILD = API;
})();
