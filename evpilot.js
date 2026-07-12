/*
 * evpilot.js — Node CLI for original EV Classic pilot files.
 *
 * All decoding lives in the shared, environment-agnostic pilot-codec.js (also
 * used by the in-browser importer, engine/shell/ui/pilot-import.js) so the two
 * can't drift. This file is just the CLI plus a thin Node file/path wrapper.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const codec = require('./pilot-codec.js');
const { simpleCrypt, KEY_CLASSIC, KEY_NOVA } = codec;

const bytesOf = (file) => fs.readFileSync(file); // a Node Buffer is a Uint8Array
const nameOf = (file) => path.basename(file);

// Node file wrappers around the shared codec.
function readPilotSummary(file) {
  return codec.readSummary(bytesOf(file), nameOf(file));
}
function toVeSave(file, DATA) {
  return codec.toSave(bytesOf(file), nameOf(file), DATA);
}

module.exports = { ...codec, readPilotSummary, toVeSave };

/* ------------------------------------------------------------------ */
/* CLI:
 *   node evpilot.js selftest
 *       — round-trip the codec and print the keystream head.
 *   node evpilot.js summary <pilot-file>
 *       — decode the mapped fields as JSON.
 *   node evpilot.js inspect <pilot-file> [keyHex] [dumpBytes]
 *       — list resources, then decrypt each and show a hex/ASCII dump
 *         (keyHex defaults to the Classic key; dumpBytes defaults to 512).
 *   node evpilot.js import <pilot-file> [out.json]
 *       — convert the pilot into a Vₑ save (writes out.json, or prints it).
 *         Load it into the browser with:
 *           localStorage.setItem('ve_pilot', <contents>)  then reload flight.html */
const USAGE =
  'usage: node evpilot.js selftest | summary <pilot-file> | inspect <pilot-file> [keyHex] [dumpBytes] | import <pilot-file> [out.json]';
if (require.main === module) {
  const cmd = process.argv[2];

  if (cmd === 'selftest') {
    // Round-trip: crypt(crypt(x)) === x for any key (symmetric XOR).
    let ok = true;
    for (const key of [KEY_CLASSIC, KEY_NOVA, 0x00000000, 0xffffffff]) {
      for (const len of [0, 1, 3, 4, 7, 16, 37, 256]) {
        const orig = new Uint8Array(len);
        for (let i = 0; i < len; i++) orig[i] = (i * 37 + 11) & 0xff;
        const a = orig.slice();
        simpleCrypt(a, key);
        simpleCrypt(a, key);
        if (a.some((v, i) => v !== orig[i])) {
          ok = false;
          console.error(`FAIL key=${key.toString(16)} len=${len}`);
        }
      }
    }
    // Encrypting a zero buffer yields the raw keystream — a quick sanity peek.
    const ks = simpleCrypt(new Uint8Array(8), KEY_CLASSIC);
    console.log('keystream[0..7] =', [...ks].map((b) => b.toString(16).padStart(2, '0')).join(' '));
    console.log(ok ? 'selftest: all round-trips passed ✓' : 'selftest: FAILED');
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'summary') {
    const file = process.argv[3];
    if (!file) {
      console.error('usage: node evpilot.js summary <pilot-file>');
      process.exit(1);
    }
    console.log(JSON.stringify(readPilotSummary(file), null, 2));
    process.exit(0);
  }

  if (cmd === 'import') {
    const file = process.argv[3];
    if (!file) {
      console.error('usage: node evpilot.js import <pilot-file> [out.json]');
      process.exit(1);
    }
    const DATA = require('./evdata.json'); // game DB: resolve spöb → system
    const save = JSON.stringify(toVeSave(file, DATA));
    const out = process.argv[4];
    if (out) {
      fs.writeFileSync(out, save);
      console.error(`wrote ${out} — load it with: localStorage.setItem('ve_pilot', <contents>)`);
    } else {
      console.log(save);
    }
    process.exit(0);
  }

  if (cmd === 'inspect') {
    const file = process.argv[3];
    if (!file) {
      console.error('usage: node evpilot.js inspect <pilot-file> [keyHex] [dumpBytes]');
      process.exit(1);
    }
    const key = process.argv[4] ? parseInt(process.argv[4], 16) : KEY_CLASSIC;
    const dumpBytes = process.argv[5] ? parseInt(process.argv[5], 10) : 512;
    const types = codec.parseTypes(codec.unwrapFork(bytesOf(file)));
    console.log('resource types found:');
    for (const t of types)
      console.log(`  '${t.typeName}'  ids: ${t.resources.map((r) => r.id).join(', ')}`);
    const dump = (label, data) => {
      const b = new Uint8Array(data);
      simpleCrypt(b, key);
      console.log(`\n=== ${label} (${b.length} bytes, decrypted key 0x${key.toString(16)}) ===`);
      for (let o = 0; o < Math.min(b.length, dumpBytes); o += 16) {
        const row = b.subarray(o, o + 16);
        const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ');
        const asc = [...row]
          .map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.'))
          .join('');
        console.log(o.toString(16).padStart(4, '0'), hex.padEnd(48), asc);
      }
    };
    for (const t of types)
      for (const r of t.resources)
        dump(`'${t.typeName}' ${r.id}${r.name ? ` "${r.name}"` : ''}`, r.data);
    process.exit(0);
  }

  // Unknown or missing subcommand: show usage and fail, like the other CLIs.
  console.error(USAGE);
  process.exit(1);
}
