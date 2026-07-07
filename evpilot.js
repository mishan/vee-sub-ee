/*
 * evpilot.js — original EV pilot-file support (WORK IN PROGRESS).
 *
 * Classic EV / Override stores the player in an encrypted resource inside a
 * Mac resource fork. The data is scrambled with Andrew Welch's SimpleCrypt
 * (symmetric XOR stream). This module provides the codec and an inspection
 * CLI; the exact pilot struct layout is reverse-engineered from a real sample
 * (drop one in EV_data/Pilots/ — see README/`inspect` output) before the
 * import/export mapping is written.
 *
 * SimpleCrypt (from the EV Nova _DoEncryption disassembly; the routine is the
 * same across the EV family, only the seed key differs):
 *   - process the buffer as big-endian 32-bit words
 *   - XOR each word with byteswap(key)
 *   - advance:  key = (key - 0x21524111) ^ 0xdeadbeef   (mod 2^32)
 *   - trailing <4 bytes: XOR with the leading bytes of byteswap(key)
 * XOR is symmetric, so the same call encrypts and decrypts.
 *
 * Seed keys:  EV Classic/Override = 0xABCD1234,  EV Nova = 0xB36A210F.
 */
'use strict';

const KEY_CLASSIC = 0xABCD1234;
const KEY_NOVA = 0xB36A210F;

const u32 = x => x >>> 0;

/* In-place symmetric SimpleCrypt over a Buffer/Uint8Array. Each 4-byte word is
 * XOR'd with the running key's big-endian bytes (verified against a real
 * pilot: the disassembly's byteswap + little-endian word access nets out to a
 * plain big-endian-byte XOR), then the key advances. */
function simpleCrypt(buf, key = KEY_CLASSIC) {
  let k = u32(key);
  const words = buf.length >>> 2;
  for (let i = 0; i < words; i++) {
    const off = i * 4;
    buf[off]     ^= (k >>> 24) & 0xff;
    buf[off + 1] ^= (k >>> 16) & 0xff;
    buf[off + 2] ^= (k >>> 8) & 0xff;
    buf[off + 3] ^= k & 0xff;
    k = u32(u32(k - 0x21524111) ^ 0xdeadbeef);
  }
  const rem = buf.length - words * 4;
  for (let j = 0; j < rem; j++) buf[words * 4 + j] ^= (k >>> (24 - 8 * j)) & 0xff;
  return buf;
}

/* ------------------------------------------------------------------ */
/* Pilot struct — reverse-engineered from real samples (three pilots
 * cross-checked against the original game's in-emulator readout). The pilot
 * lives in two MpïL resources: 128 "Pilot Data" (the struct below) and 129,
 * whose *resource name is the ship's name*. The pilot's own name is the file
 * name. Confirmed fields in decrypted MpïL 128 so far:
 *
 *   0x0000  i16  docked spöb  (stored −128; gives current location + system)
 *   0x0002  i16  ship type    (stored −128)
 *   0x0014  i16  date: month
 *   0x0016  i16  date: day
 *   0x0018  i16  date: year
 *   0x11ba  u32  credits
 *
 * Still mapping: legal record (per-govt array), combat rating / kills, cargo,
 * outfits, mission bits, the per-system status array at ~0x1a. */
const MP128 = {
  spob:    { off: 0x0000, u32: false, add: 128 },
  ship:    { off: 0x0002, u32: false, add: 128 },
  month:   { off: 0x0014, u32: false },
  day:     { off: 0x0016, u32: false },
  year:    { off: 0x0018, u32: false },
  credits: { off: 0x11ba, u32: true },
};

/* Decode the confirmed summary fields of a pilot file (resource fork). */
function readPilotSummary(file) {
  const path = require('path');
  const { loadFork, parseFork } = require('./evrsrc.js');
  const types = parseFork(loadFork(file).fork);
  const t = types.find(x => /p.L$/i.test(x.typeName));
  if (!t) throw new Error('no NpïL/MpïL pilot resource in ' + file);
  const r128 = t.resources.find(r => r.id === 128);
  const r129 = t.resources.find(r => r.id === 129);
  if (!r128) throw new Error('no pilot-data (id 128) resource');
  const b = Buffer.from(r128.data()); simpleCrypt(b);
  const g = f => (f.u32 ? b.readUInt32BE(f.off) : b.readInt16BE(f.off)) + (f.add || 0);
  return {
    pilotName: path.basename(file).replace(/^\._/, '').replace(/\.rsrc$/i, ''),
    shipName: r129 ? r129.name : null,
    dockedSpob: g(MP128.spob),
    shipType: g(MP128.ship),
    date: { year: g(MP128.year), month: g(MP128.month), day: g(MP128.day) },
    credits: g(MP128.credits),
  };
}

module.exports = { simpleCrypt, readPilotSummary, MP128, KEY_CLASSIC, KEY_NOVA };

/* ------------------------------------------------------------------ */
/* CLI: node evpilot.js selftest
 *      node evpilot.js inspect <pilot-resource-fork-file> [key-hex]
 *   Lists resources, then decrypts likely pilot resources and shows a
 *   hex/ASCII dump so we can map the struct against a known pilot. */
if (require.main === module) {
  const cmd = process.argv[2];

  if (cmd === 'selftest') {
    // Round-trip: crypt(crypt(x)) === x for any key (symmetric XOR).
    let ok = true;
    for (const key of [KEY_CLASSIC, KEY_NOVA, 0x00000000, 0xffffffff]) {
      for (const len of [0, 1, 3, 4, 7, 16, 37, 256]) {
        const orig = Buffer.alloc(len);
        for (let i = 0; i < len; i++) orig[i] = (i * 37 + 11) & 0xff;
        const a = Buffer.from(orig);
        simpleCrypt(a, key); simpleCrypt(a, key);
        if (!a.equals(orig)) { ok = false; console.error(`FAIL key=${key.toString(16)} len=${len}`); }
      }
    }
    // Encrypting a zero buffer yields the raw keystream — a quick sanity peek.
    const ks = simpleCrypt(Buffer.alloc(8), KEY_CLASSIC);
    console.log('keystream[0..7] =', [...ks].map(b => b.toString(16).padStart(2, '0')).join(' '));
    console.log(ok ? 'selftest: all round-trips passed ✓' : 'selftest: FAILED');
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'summary') {
    const file = process.argv[3];
    if (!file) { console.error('usage: node evpilot.js summary <pilot-resource-fork-file>'); process.exit(1); }
    console.log(JSON.stringify(readPilotSummary(file), null, 2));
    process.exit(0);
  }

  if (cmd === 'inspect') {
    const fs = require('fs');
    const path = process.argv[3];
    if (!path) { console.error('usage: node evpilot.js inspect <resource-fork-file> [keyHex]'); process.exit(1); }
    const key = process.argv[4] ? parseInt(process.argv[4], 16) : KEY_CLASSIC;
    const { loadFork, parseFork } = require('./evrsrc.js');
    const { fork } = loadFork(path);                    // handles MacBinary/AppleDouble/raw
    const types = parseFork(fork);
    console.log('resource types found:');
    for (const t of types)
      console.log(`  '${t.typeName}' (0x${t.typeHex})  ids: ${t.resources.map(r => r.id).join(', ')}`);
    const dumpBytes = process.argv[5] ? parseInt(process.argv[5], 10) : 512;
    const dump = (label, buf) => {
      const b = Buffer.from(buf); simpleCrypt(b, key);
      console.log(`\n=== ${label} (${b.length} bytes, decrypted key 0x${key.toString(16)}) ===`);
      for (let o = 0; o < Math.min(b.length, dumpBytes); o += 16) {
        const row = b.slice(o, o + 16);
        const hex = [...row].map(x => x.toString(16).padStart(2, '0')).join(' ');
        const asc = [...row].map(x => (x >= 32 && x < 127) ? String.fromCharCode(x) : '.').join('');
        console.log(o.toString(16).padStart(4, '0'), hex.padEnd(48), asc);
      }
    };
    // Dump every resource type (pilot files are small — a handful of resources).
    for (const t of types)
      for (const r of t.resources) dump(`'${t.typeName}' ${r.id}${r.name ? ` "${r.name}"` : ''}`, r.data());
  }
}
