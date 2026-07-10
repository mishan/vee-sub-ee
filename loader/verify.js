#!/usr/bin/env node
/*
 * verify.js — check the pure-JS PICT/snd decoders against the resource_dasm +
 * ImageMagick reference output in evassets/ (the golden pipeline).
 *
 *   node loader/verify.js
 *
 * Needs the local, gitignored EV_data/*.rsrc and evassets/ present, plus
 * ImageMagick's `convert` on PATH (only to read the reference PNGs as RGBA).
 * The decoders themselves have no dependencies and run in the browser.
 */
'use strict';
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const { loadFork, parseFork, decodeRecord } = require('../evrsrc.js');
const { decodePict } = require('./evpict.js');
const { decodeSnd } = require('./evsnd.js');
const { compositeSprite } = require('./evsprite.js');
const { parseSit, extractFork } = require('./evsit.js');

const ROOT = path.join(__dirname, '..');
const D = f => path.join(ROOT, 'EV_data', f);
const A = (...s) => path.join(ROOT, 'evassets', ...s);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');
// Read a reference PNG as raw RGBA via ImageMagick, straight from stdout — no
// shell, no temp files (execFileSync passes args directly).
const refRGBA = f => new Uint8Array(cp.execFileSync('convert', [f, '-depth', '8', 'RGBA:-'], { maxBuffer: 1 << 28 }));

function pictResources(file) {
  const t = parseFork(loadFork(D(file)).fork);
  const p = t.find(x => x.typeName === 'PICT');
  return p ? p.resources : [];
}
function refPng(id) {
  for (const dir of ['graphics', 'titles']) {
    if (!fs.existsSync(A(dir))) continue;
    const hit = fs.readdirSync(A(dir)).find(f => f === `PICT_${id}.png` || f.startsWith(`PICT_${id}_`));
    if (hit) return A(dir, hit);
  }
  return null;
}
function readWav(p) {
  const b = new Uint8Array(fs.readFileSync(p)), dv = new DataView(b.buffer);
  let i = 12, fmt = {}, data = null;
  while (i + 8 <= b.length) {
    const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]), sz = dv.getUint32(i + 4, true), body = i + 8;
    if (id === 'fmt ') fmt = { ch: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    if (id === 'data') data = b.slice(body, body + sz);
    i = body + sz + (sz & 1);
  }
  return { ...fmt, data };
}

function checkPict() {
  let exact = 0, tested = 0, direct = 0, mismatch = 0, unhandled = 0, err = 0;
  for (const file of ['EV Titles.rsrc', 'EV Graphics.rsrc']) {
    if (!fs.existsSync(D(file))) continue;
    for (const r of pictResources(file)) {
      let img; try { img = decodePict(r.data()); } catch { err++; continue; }
      if (img.unhandled) { unhandled++; continue; } // decoder hit an opcode it doesn't model
      const rp = refPng(r.id); if (!rp) continue;
      tested++;
      if (img.depth >= 16) direct++;                // rendered via DirectBits (16/32-bit)
      const ref = refRGBA(rp);
      let ok = ref.length === img.rgba.length;
      for (let i = 0; ok && i < img.rgba.length; i += 4)
        if (img.rgba[i] !== ref[i] || img.rgba[i + 1] !== ref[i + 1] || img.rgba[i + 2] !== ref[i + 2]) ok = false;
      ok ? exact++ : mismatch++;
    }
  }
  console.log(`PICT: ${exact}/${tested} pixel-exact (${pct(exact, tested)})  ` +
    `[direct-color: ${direct}, mismatch: ${mismatch}, unhandled: ${unhandled}, err: ${err}]`);
}

function checkSnd() {
  if (!fs.existsSync(D('EV Sounds.rsrc')) || !fs.existsSync(A('sounds'))) return;
  const t = parseFork(loadFork(D('EV Sounds.rsrc')).fork);
  const snds = t.find(x => x.typeName === 'snd '); if (!snds) return;
  let exact = 0, tested = 0;
  for (const r of snds.resources) {
    const hit = fs.readdirSync(A('sounds')).find(f => f === `snd_${r.id}.wav` || f.startsWith(`snd_${r.id}_`));
    if (!hit) continue;
    const wav = readWav(A('sounds', hit)), dec = decodeSnd(r.data());
    if (dec.error) continue;
    tested++;
    const ok = dec.sampleRate === wav.rate && dec.pcm8 && wav.bits === 8 &&
      dec.pcm8.length === wav.data.length && dec.pcm8.every((v, i) => v === wav.data[i]);
    if (ok) exact++;
  }
  console.log(`snd : ${exact}/${tested} byte-exact (${pct(exact, tested)})`);
}

function checkSprites() {
  if (!fs.existsSync(D('EV Graphics.rsrc')) || !fs.existsSync(A('sprites'))) return;
  const schemaPath = path.join(ROOT, 'schemas', 'spin.json');
  if (!fs.existsSync(schemaPath)) return;
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const t = parseFork(loadFork(D('EV Graphics.rsrc')).fork);
  const spins = t.find(x => x.typeName === 'spïn'); if (!spins) return;
  const picts = {}; for (const r of t.find(x => x.typeName === 'PICT').resources) picts[r.id] = r;
  let exact = 0, near = 0, tested = 0;
  for (const r of spins.resources) {
    const rec = decodeRecord(r.data(), schema), sp = picts[rec.SpritesID];
    const refp = A('sprites', `spin_${r.id}.png`);
    if (!sp || !fs.existsSync(refp)) continue;
    const comp = compositeSprite(decodePict(sp.data()), picts[rec.MasksID] ? decodePict(picts[rec.MasksID].data()) : null);
    tested++;
    const ref = refRGBA(refp);
    let ok = ref.length === comp.rgba.length, m = 0, tot = comp.width * comp.height;
    for (let i = 0; ok && i < comp.rgba.length; i++) if (comp.rgba[i] !== ref[i]) ok = false;
    for (let i = 0; i < tot; i++) { const o = i * 4; if (comp.rgba[o] === ref[o] && comp.rgba[o + 1] === ref[o + 1] && comp.rgba[o + 2] === ref[o + 2] && comp.rgba[o + 3] === ref[o + 3]) m++; }
    if (ok) exact++; else if (100 * m / tot >= 99) near++;
  }
  console.log(`sprite: ${exact}/${tested} byte-exact (${pct(exact, tested)}), ${exact + near}/${tested} ≥99% [edge alpha]`);
}

function checkSit() {
  const sitPath = path.join(ROOT, 'EV_data', 'Escape-Velocity_Mac_EN_RIP.sit');
  if (!fs.existsSync(sitPath)) return;
  const sit = new Uint8Array(fs.readFileSync(sitPath));
  const entries = parseSit(sit);
  const want = { 'EV Data': 'EV Data.rsrc', 'EV Graphics': 'EV Graphics.rsrc', 'EV Sounds': 'EV Sounds.rsrc', 'EV Titles': 'EV Titles.rsrc', 'EV Music': 'EV Music.rsrc' };
  let exact = 0, tested = 0;
  for (const e of entries) {
    if (!e.isResource || !want[e.name] || !fs.existsSync(D(want[e.name]))) continue;
    tested++;
    const out = extractFork(sit, e), fork = loadFork(D(want[e.name])).fork;
    let ok = out.length === fork.length;
    for (let i = 0; ok && i < out.length; i++) if (out[i] !== fork[i]) ok = false;
    if (ok) exact++;
  }
  console.log(`.sit : ${exact}/${tested} forks decompress byte-exact (${pct(exact, tested)})`);
}

checkPict();
checkSnd();
checkSprites();
checkSit();
