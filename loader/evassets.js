#!/usr/bin/env node
/*
 * evassets.js — build the entire evassets/ tree from the EV resource forks using
 * the loader's own pure-JS decoders — no resource_dasm, no ImageMagick, just Node.
 *
 * This is the dependency-free counterpart to evconvert.sh + evsprites.sh +
 * evatlas.js (the resource_dasm/ImageMagick "golden" pipeline): it decodes every
 * PICT to a PNG and every snd to a WAV, composites each spïn's sprite+mask into a
 * transparent sheet, and emits the same manifest.json — so a dev with only the
 * .sit (see `make unsit`) and Node can produce a working evassets/. The decoders
 * (evpict/evsnd/evsprite) are the ones loader/verify.js checks byte-exact against
 * the native tools, so the pixels/samples match; only the PNG/WAV *containers* are
 * encoded here (standard, lossless).
 *
 * Usage:
 *   node loader/evassets.js <EV_data dir> [evassets dir]
 * Layout produced (matching the native pipeline):
 *   evassets/graphics/PICT_<id>.png   (EV Graphics)
 *   evassets/titles/PICT_<id>.png     (EV Titles)
 *   evassets/sounds/snd_<id>.wav      (EV Sounds)
 *   evassets/music/snd_<id>.wav       (EV Music)
 *   evassets/sprites/spin_<id>.png    (composited spïn sheets)
 *   evassets/manifest.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadFork, parseFork, findType, decodeRecord } = require('../evrsrc.js');
const { decodePict } = require('./evpict.js');
const { decodeSnd } = require('./evsnd.js');
const { compositeSprite } = require('./evsprite.js');

/* ---- CRC-32 (PNG) ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---- PNG encoder: 8-bit RGBA (color type 6), one filter-0 scanline per row ---- */
function encodePng(width, height, rgba) {
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- WAV encoder from a decodeSnd() result (PCM, uncompressed) ---- */
function encodeWav(dec) {
  const channels = dec.channels || 1;
  const bits = dec.bits || 8;
  const data = dec.pcm8
    ? Buffer.from(dec.pcm8.buffer, dec.pcm8.byteOffset, dec.pcm8.byteLength)
    : Buffer.from(dec.pcm16.buffer, dec.pcm16.byteOffset, dec.pcm16.byteLength);
  const blockAlign = (channels * bits) >> 3;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(dec.sampleRate, 24);
  h.writeUInt32LE(dec.sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// A resource name is only safe to embed in an output filename if it can't
// introduce a path separator (which would traverse out of outDir or spawn a
// subdirectory) or a NUL. Real EV names are plain ("Game Panel"); this guards
// against a crafted/odd fork writing outside the asset tree.
const nameSafeForFile = (name) => !/[/\\\0]/.test(name);

/* Decode every PICT in a fork to graphics/titles PNGs; return {dims, fails}. */
function convertPicts(pictById, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const dims = new Map();
  const fails = [];
  for (const [id, r] of pictById) {
    try {
      const img = decodePict(r.data());
      const png = encodePng(img.width, img.height, img.rgba);
      // The engine looks assets up by ID (PICT_<id>.png), but a few are requested
      // by their named filename too (e.g. the sidebar "PICT_128_Game Panel.png").
      // resource_dasm emits PICT_<id>_<name>.png and evconvert.sh adds the
      // suffix-free alias; write both so either lookup resolves.
      fs.writeFileSync(path.join(outDir, `PICT_${id}.png`), png);
      if (r.name) {
        if (nameSafeForFile(r.name))
          fs.writeFileSync(path.join(outDir, `PICT_${id}_${r.name}.png`), png);
        else
          fails.push(
            `PICT ${id}: unsafe resource name ${JSON.stringify(r.name)} — named alias skipped`,
          );
      }
      dims.set(id, { w: img.width, h: img.height });
    } catch (e) {
      fails.push(`PICT ${id}${r.name ? ` (${r.name})` : ''}: ${e.message}`);
    }
  }
  return { dims, fails };
}

/* Decode every snd in a fork to WAVs. */
function convertSnds(fork, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const snd = findType(parseFork(Buffer.from(fork)), 'snd ');
  let ok = 0;
  const fails = [];
  if (snd)
    for (const r of snd.resources) {
      // decodeSnd (and the DataView reads under it) can throw on malformed or
      // truncated resource bytes; catch per-snd so one bad resource can't abort
      // the whole asset build — record it and carry on, like convertPicts.
      try {
        const dec = decodeSnd(r.data());
        if (dec.error || (!dec.pcm8 && !dec.pcm16)) {
          fails.push(`snd ${r.id}${r.name ? ` (${r.name})` : ''}: ${dec.error || 'no PCM'}`);
          continue;
        }
        fs.writeFileSync(path.join(outDir, `snd_${r.id}.wav`), encodeWav(dec));
        ok++;
      } catch (e) {
        fails.push(`snd ${r.id}${r.name ? ` (${r.name})` : ''}: ${e.message}`);
      }
    }
  return { ok, fails };
}

/* Read a PICT fork into a Map id→resource (for on-demand decode + compositing). */
function pictMap(fork) {
  const t = findType(parseFork(Buffer.from(fork)), 'PICT');
  const m = new Map();
  if (t) for (const r of t.resources) m.set(r.id, r);
  return m;
}

function main() {
  const [dataDir, assetDir = 'evassets'] = process.argv.slice(2);
  if (!dataDir) {
    console.error('usage: node loader/evassets.js <EV_data dir> [evassets dir]');
    process.exit(2);
  }
  const fork = (name) => loadFork(path.join(dataDir, name)).fork;
  const gfxFork = fork('EV Graphics.rsrc');

  // 1) PICTs → graphics/ + titles/
  const gfxPicts = pictMap(gfxFork);
  const g = convertPicts(gfxPicts, path.join(assetDir, 'graphics'));
  const t = convertPicts(pictMap(fork('EV Titles.rsrc')), path.join(assetDir, 'titles'));
  console.log(`graphics: ${gfxPicts.size - g.fails.length}/${gfxPicts.size} PICTs → PNG`);
  console.log(`titles:   ${t.dims.size} PICTs → PNG`);

  // 2) snd → sounds/ + music/
  const s = convertSnds(fork('EV Sounds.rsrc'), path.join(assetDir, 'sounds'));
  const mu = convertSnds(fork('EV Music.rsrc'), path.join(assetDir, 'music'));
  console.log(`sounds:   ${s.ok} snds → WAV`);
  console.log(`music:    ${mu.ok} snds → WAV`);

  // 3) spïn → composited sprites/ + manifest.json
  const spinSchema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'spin.json'), 'utf8'),
  );
  const spins = findType(parseFork(Buffer.from(gfxFork)), 'spin');
  const spriteDir = path.join(assetDir, 'sprites');
  fs.mkdirSync(spriteDir, { recursive: true });
  const manifest = {
    source: 'EV Graphics.rsrc',
    generated: new Date().toISOString(),
    spins: {},
    problems: [...g.fails, ...t.fails, ...s.fails, ...mu.fails],
  };
  let composited = 0;
  if (spins)
    for (const r of spins.resources) {
      const rec = decodeRecord(r.data(), spinSchema);
      const has = (id) => g.dims.has(id);
      const entry = {
        name: r.name,
        sprites: has(rec.SpritesID)
          ? path.posix.join('graphics', `PICT_${rec.SpritesID}.png`)
          : null,
        masks: has(rec.MasksID) ? path.posix.join('graphics', `PICT_${rec.MasksID}.png`) : null,
        frameW: rec.xSize,
        frameH: rec.ySize,
        xTiles: rec.xTiles,
        yTiles: rec.yTiles,
        frames: rec.xTiles * rec.yTiles,
      };
      // dimension check + composite (matches evatlas.js problems + evsprites.sh)
      for (const key of ['sprites', 'masks']) {
        const id = key === 'sprites' ? rec.SpritesID : rec.MasksID;
        if (!entry[key]) {
          manifest.problems.push(`spïn ${r.id} (${r.name}): missing PICT ${id}`);
          continue;
        }
        const { w, h } = g.dims.get(id);
        if (w !== rec.xSize * rec.xTiles || h !== rec.ySize * rec.yTiles)
          manifest.problems.push(
            `spïn ${r.id} (${r.name}) ${key}: PICT ${id} is ${w}x${h}, ` +
              `expected ${rec.xSize * rec.xTiles}x${rec.ySize * rec.yTiles}`,
          );
      }
      if (entry.sprites) {
        const sprite = decodePict(gfxPicts.get(rec.SpritesID).data());
        const mask = entry.masks ? decodePict(gfxPicts.get(rec.MasksID).data()) : null;
        const comp = compositeSprite(sprite, mask);
        fs.writeFileSync(
          path.join(spriteDir, `spin_${r.id}.png`),
          encodePng(comp.width, comp.height, comp.rgba),
        );
        composited++;
      }
      manifest.spins[r.id] = entry;
    }

  // non-sprite asset lists, for completeness (matches evatlas.js)
  for (const sub of ['titles', 'sounds', 'music']) {
    const d = path.join(assetDir, sub);
    if (fs.existsSync(d))
      manifest[sub] = fs
        .readdirSync(d)
        .sort()
        .map((f) => path.posix.join(sub, f));
  }
  fs.writeFileSync(path.join(assetDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(
    `sprites:  ${composited} composited; manifest: ${Object.keys(manifest.spins).length} spïns, ` +
      `${manifest.problems.length} problems`,
  );
  for (const p of manifest.problems.slice(0, 20)) console.log('  ⚠ ' + p);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}

module.exports = { encodePng, encodeWav, crc32 };
