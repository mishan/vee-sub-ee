#!/usr/bin/env node
/*
 * evatlas.js — Join spïn records to converted sprite-sheet PNGs and emit an
 * engine-ready asset manifest.
 *
 * Inputs:  a graphics file with spïn resources (EV Graphics.rsrc), plus an
 *          evassets/ tree produced by the resource_dasm conversion step
 *          (see README "Graphics pipeline").
 * Output:  evassets/manifest.json — for every spïn: sprite/mask PNG paths,
 *          frame size, tile grid, frame count; verified against the PNGs'
 *          actual IHDR dimensions.
 *
 * Usage:
 *   node evatlas.js "EV_data/EV Graphics.rsrc" evassets/
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadFork, parseFork, findType, decodeRecord } = require('./evrsrc.js');

function pngSize(file) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function indexPngs(dir) {
  const byPictId = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = /^PICT_(-?\d+)(?:_.*)?\.png$/.exec(f);
    if (m) byPictId.set(+m[1], f);
  }
  return byPictId;
}

function main() {
  const [file, assetDir = 'evassets'] = process.argv.slice(2);
  if (!file) {
    console.error('usage: evatlas.js <graphics file> [evassets dir]');
    process.exit(1);
  }

  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas', 'spin.json'), 'utf8'));
  const types = parseFork(loadFork(file).fork);
  const spins = findType(types, 'spin');
  if (!spins) throw new Error(`${file}: no spïn resources`);

  const gdir = path.join(assetDir, 'graphics');
  const pngs = indexPngs(gdir);
  const manifest = {
    source: path.basename(file),
    generated: new Date().toISOString(),
    spins: {},
    problems: [],
  };

  for (const r of spins.resources) {
    const s = decodeRecord(r.data(), schema);
    const entry = {
      name: r.name,
      sprites: pngs.get(s.SpritesID) ? path.posix.join('graphics', pngs.get(s.SpritesID)) : null,
      masks: pngs.get(s.MasksID) ? path.posix.join('graphics', pngs.get(s.MasksID)) : null,
      frameW: s.xSize,
      frameH: s.ySize,
      xTiles: s.xTiles,
      yTiles: s.yTiles,
      frames: s.xTiles * s.yTiles,
    };
    for (const key of ['sprites', 'masks']) {
      const id = key === 'sprites' ? s.SpritesID : s.MasksID;
      if (!entry[key]) {
        manifest.problems.push(`spïn ${r.id} (${r.name}): missing PICT ${id}`);
        continue;
      }
      const { w, h } = pngSize(path.join(assetDir, entry[key]));
      if (w !== s.xSize * s.xTiles || h !== s.ySize * s.yTiles)
        manifest.problems.push(
          `spïn ${r.id} (${r.name}) ${key}: PICT ${id} is ${w}x${h}, ` +
            `expected ${s.xSize * s.xTiles}x${s.ySize * s.yTiles}`,
        );
    }
    manifest.spins[r.id] = entry;
  }

  // Non-sprite assets, for completeness.
  for (const sub of ['titles', 'sounds', 'music']) {
    const d = path.join(assetDir, sub);
    if (fs.existsSync(d))
      manifest[sub] = fs
        .readdirSync(d)
        .sort()
        .map((f) => path.posix.join(sub, f));
  }

  const dest = path.join(assetDir, 'manifest.json');
  fs.writeFileSync(dest, JSON.stringify(manifest, null, 1));
  const n = Object.keys(manifest.spins).length;
  console.log(`wrote ${dest}: ${n} spïns, ${manifest.problems.length} problems`);
  for (const p of manifest.problems) console.log('  ⚠ ' + p);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}
