#!/usr/bin/env node
/*
 * evexport.js — Decode an entire EV data file into one JSON bundle.
 *
 * Uses the TMPL-generated schemas in schemas/ (see tmpl2schema.js). Every
 * record type with a schema is decoded in full; STR# lists are decoded too.
 * The result is the engine-agnostic "game database" — resources reference
 * each other by resource ID, so the ID graph survives intact.
 *
 * Usage:
 *   node evexport.js "EV_data/EV Data.rsrc" -o evdata.json
 *   node evexport.js "EV_data/EV Data.rsrc" --map galaxy.html
 *   Add --semantic to annotate every record with a `$sem` object (decoded
 *   flag bits, enums, resolved cross-references — see semantics.js).
 *
 * --map injects the JSON into galaxy_viewer.html's __EVDATA__ placeholder,
 * producing a self-contained interactive galaxy map (local build artifact;
 * contains copyrighted game data — don't redistribute).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadFork, parseFork, mergeTypes, decodeRecord, decodeStrList } = require('./evrsrc.js');

function loadSchemas(dir) {
  const byTypeName = new Map(); // MacRoman type name -> {alias, schema}
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const schema = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    byTypeName.set(schema.name, { alias: path.basename(f, '.json'), schema });
  }
  return byTypeName;
}

function exportAll(file, schemaDir, pluginFiles = []) {
  const baseTypes = parseFork(loadFork(file).fork);
  // Plugins override/add resources by (type, ID), applied in load order (base
  // first). Merges game records + STR#; plugin graphics/sounds are handled by
  // the asset pipeline (not this record export).
  const types = pluginFiles.length
    ? mergeTypes(baseTypes, ...pluginFiles.map(f => parseFork(loadFork(f).fork)))
    : baseTypes;
  const schemas = loadSchemas(schemaDir);
  const out = {
    source: path.basename(file),
    generated: new Date().toISOString(),
    types: {},
    strings: {},
  };
  const warnings = [];

  for (const t of types) {
    if (t.typeHex === '53545223') { // STR#
      for (const r of t.resources)
        out.strings[r.id] = { name: r.name, list: decodeStrList(r.data()) };
      continue;
    }
    const s = schemas.get(t.typeName);
    if (!s) continue; // PICT, snd, TMPL, vers... — not record data
    const records = {};
    for (const r of t.resources) {
      const rec = decodeRecord(r.data(), s.schema);
      if (rec.__schemaBytes !== rec.__recordBytes)
        warnings.push(`${t.typeName} ${r.id}: schema ${rec.__schemaBytes}B vs record ${rec.__recordBytes}B`);
      delete rec.__schemaBytes; delete rec.__recordBytes;
      records[r.id] = { name: r.name, ...rec };
    }
    out.types[s.alias] = records;
  }
  return { out, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : null; };
  // Repeatable: --plugin A.rsrc --plugin B.rsrc (in load order; later wins).
  const opts = (flag) => { const v = []; let i; while ((i = args.indexOf(flag)) >= 0) v.push(args.splice(i, 2)[1]); return v; };
  const pluginFiles = opts('--plugin');
  const outPath = opt('-o');
  const mapPath = opt('--map');
  const flightPath = opt('--flight');
  const appPath = opt('--app'); // EV application rsrc, for name suggestions (STR# 128)
  const assetDir = opt('--assets') || path.join(__dirname, 'evassets');
  const schemaDir = opt('--schemas') || path.join(__dirname, 'schemas');
  const semanticIdx = args.indexOf('--semantic');
  const semantic = (semanticIdx >= 0 && !!args.splice(semanticIdx, 1)) || !!flightPath;
  const file = args[0];
  if (!file || (!outPath && !mapPath && !flightPath)) {
    console.error('usage: evexport.js <datafile> [--plugin file]… [-o evdata.json] [--map galaxy.html] [--flight flight.html]');
    process.exit(1);
  }

  const { out, warnings } = exportAll(file, schemaDir, pluginFiles);
  if (pluginFiles.length) console.error(`merged ${pluginFiles.length} plugin(s): ${pluginFiles.map(f => path.basename(f)).join(', ')}`);
  if (semantic) require('./semantics.js').decorate(out);
  for (const w of warnings) console.error('⚠ ' + w);
  const counts = Object.entries(out.types)
    .map(([k, v]) => `${k}:${Object.keys(v).length}`).join(' ');
  console.error(`decoded ${counts} STR#:${Object.keys(out.strings).length}`);

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
    console.error(`wrote ${outPath}`);
  }
  if (mapPath) {
    const tpl = fs.readFileSync(path.join(__dirname, 'galaxy_viewer.html'), 'utf8');
    if (!tpl.includes('/*__EVDATA__*/null')) throw new Error('viewer template missing __EVDATA__ placeholder');
    fs.writeFileSync(mapPath, tpl.replace('/*__EVDATA__*/null', JSON.stringify(out)));
    console.error(`wrote ${mapPath}`);
  }
  if (flightPath) {
    // The flight demo needs the sprite manifest too (evatlas.js). It loads
    // sprite PNGs relative to itself, so it must live next to evassets/.
    const manifest = fs.readFileSync(path.join(assetDir, 'manifest.json'), 'utf8');
    const engine = fs.readFileSync(path.join(__dirname, 'engine', 'core.js'), 'utf8');
    const tpl = fs.readFileSync(path.join(__dirname, 'flight_template.html'), 'utf8');
    if (!tpl.includes('/*__EVDATA__*/null')) throw new Error('flight template missing __EVDATA__ placeholder');
    // Name suggestions (STR# 128 "Default Names") live in the EV application's
    // resource fork, not the game data. If the app rsrc is supplied, split the
    // list in half — pilot names, then ship names — and inject it. Otherwise
    // leave null; the template falls back to generic defaults (data-free).
    let names = 'null';
    if (appPath) {
      try {
        const { loadFork, parseFork, decodeStrList } = require('./evrsrc.js');
        const t = parseFork(loadFork(appPath).fork).find(x => x.typeName === 'STR#');
        const r = t && t.resources.find(x => x.id === 128);
        const list = r ? decodeStrList(r.data()) : [];
        if (list.length >= 2) {
          const h = Math.ceil(list.length / 2);
          names = JSON.stringify({ pilots: list.slice(0, h), ships: list.slice(h) });
        }
      } catch (e) { console.error('⚠ name suggestions: ' + e.message); }
    }
    fs.writeFileSync(flightPath, tpl
      .replace('/*__ENGINE__*/', () => engine)
      .replace('/*__EVDATA__*/null', JSON.stringify(out))
      .replace('/*__MANIFEST__*/null', manifest.trim())
      .replace('/*__NAMES__*/null', () => names));
    console.error(`wrote ${flightPath}`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('error:', e.message); process.exit(1); }
}

module.exports = { exportAll };
