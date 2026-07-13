// Tests for the original-EV pilot codec (pilot-codec.js): import (toSave),
// export (fromSave), and the low-level fork writer / base64 helpers.
//
// Deliberately data-free (like the rest of the suite): rather than lean on a real
// Ambrosia pilot, we synthesize a pilot with fromSave and read it back with a
// minimal fake game DB. That still exercises the whole encode→decode path and,
// crucially, the byte-faithful re-export of an "imported" pilot.
//
// Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import codec from '../pilot-codec.js';

// Smallest game DB toSave touches: the docked spöb's system, escort/ship names,
// an (empty) mission table and the cargo-name list.
const DATA = {
  types: {
    spob: { 128: { System: 130 } },
    ship: { 128: { name: 'Shuttle' }, 200: { name: 'Kestrel' } },
    misn: {},
  },
  strings: { 4000: { list: ['Food', 'Industrial'] } },
};

// A representative save with something set in every mapped field.
function sampleSave() {
  return {
    v: 2,
    syst: 130,
    spob: 128,
    ship: 128,
    credits: 123456,
    cargo: { food: 3, industrial: 0, medical: 2, luxury: 0, metal: 0, equipment: 1 },
    outfits: { 130: 3, 156: 1, 169: 1 },
    explored: [128, 130, 131],
    bits: [],
    day: 0,
    born: new Date(1177 - 250, 2, 15).getTime(),
    rep: { 128: -40, 140: 12 },
    kills: 27,
    missions: [],
    dominated: [],
    name: 'Testpilot',
    shipName: 'Serenity',
    strict: false,
    escorts: [{ id: 1, shipId: 200, name: 'Kestrel' }],
    persDone: [],
    persGrudge: [],
  };
}

// Project onto the fields the codec actually maps (dropping origin + the fields
// import can't recover and always fills empty). explored is a set, so its order
// is irrelevant — import lists the current system first.
function mapped(s) {
  return {
    v: s.v,
    syst: s.syst,
    spob: s.spob,
    ship: s.ship,
    credits: s.credits,
    cargo: s.cargo,
    outfits: s.outfits,
    explored: [...s.explored].sort((a, b) => a - b),
    born: s.born,
    rep: s.rep,
    kills: s.kills,
    shipName: s.shipName,
    strict: s.strict,
    escorts: s.escorts,
  };
}

test('base64 round-trips arbitrary bytes', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 1000]) {
    const a = new Uint8Array(len);
    for (let i = 0; i < len; i++) a[i] = (i * 37 + 11) & 0xff;
    const back = codec.b64decode(codec.b64encode(a));
    assert.equal(back.length, len, `length for len=${len}`);
    assert.ok(
      a.every((v, i) => v === back[i]),
      `bytes for len=${len}`,
    );
  }
});

test('buildFork produces a fork parseTypes reads back', () => {
  const r128 = new Uint8Array(10).fill(0xaa);
  const r129 = new Uint8Array(6).fill(0xbb);
  const fork = codec.buildFork([
    { id: 128, name: 'Pilot Data', data: r128 },
    { id: 129, name: 'Serenity', data: r129 },
  ]);
  const types = codec.parseTypes(fork);
  assert.equal(types.length, 1);
  const mp = types[0];
  assert.deepEqual(
    [...mp.typeName].map((c) => c.charCodeAt(0)),
    [0x4d, 0x70, 0x95, 0x4c],
  ); // MpïL
  const byId = Object.fromEntries(mp.resources.map((r) => [r.id, r]));
  assert.equal(byId[128].name, 'Pilot Data');
  assert.equal(byId[129].name, 'Serenity');
  assert.ok(byId[128].data.every((v) => v === 0xaa));
  assert.ok(byId[129].data.every((v) => v === 0xbb));
});

test('export → import preserves every mapped field', () => {
  const save = sampleSave();
  const file = codec.fromSave(save, DATA); // synth path (no origin)
  const back = codec.toSave(file, 'Testpilot.rsrc', DATA);
  assert.deepEqual(mapped(back), mapped(save));
  assert.equal(back.shipName, 'Serenity');
});

test('an exported file is a valid AppleDouble EV pilot', () => {
  const file = codec.fromSave(sampleSave(), DATA);
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  assert.equal(dv.getUint32(0), 0x00051607, 'AppleDouble magic');
  const { d, shipName } = codec.parsePilot(file); // decrypts MpïL 128, reads 129 name
  assert.equal(shipName, 'Serenity');
  assert.equal(d.getUint32(0x11ba), 123456, 'credits decode'); // CREDITS offset
});

test('re-exporting an imported pilot is byte-identical (template path)', () => {
  // Treat a synthesized file as if it were the "original": import it (which
  // stashes it as origin), then export again. The template path must reproduce
  // the source byte-for-byte, since nothing changed.
  const original = codec.fromSave(sampleSave(), DATA);
  const save = codec.toSave(original, 'Testpilot.rsrc', DATA);
  assert.ok(save.origin, 'import stashes the source file');
  const reexported = codec.fromSave(save, DATA);
  assert.equal(reexported.length, original.length);
  assert.ok(
    original.every((v, i) => v === reexported[i]),
    'byte-identical re-export',
  );
});

test('edits to a save propagate through export', () => {
  const original = codec.fromSave(sampleSave(), DATA);
  const save = codec.toSave(original, 'Testpilot.rsrc', DATA);
  save.credits = 999999;
  save.kills = 42;
  save.outfits = { ...save.outfits, 156: 5 };
  const back = codec.toSave(codec.fromSave(save, DATA), 'Testpilot.rsrc', DATA);
  assert.equal(back.credits, 999999);
  assert.equal(back.kills, 42);
  assert.equal(back.outfits[156], 5);
});
