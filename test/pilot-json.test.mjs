// Unit tests for parsePilotJSON — the native Vₑ JSON save importer
// (engine/shell/ui/pilot-import.js). Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeJSON, parsePilotJSON } from '../engine/shell/ui/pilot-import.js';

const enc = (s) => new TextEncoder().encode(s);
const withBom = (s) => Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(s)]);

test('looksLikeJSON sniffs a Vₑ save vs a binary pilot fork by its bytes', () => {
  assert.equal(looksLikeJSON(enc('{"ship":128}')), true);
  assert.equal(looksLikeJSON(enc('\n\t  {"ship":128}')), true, 'leading whitespace');
  assert.equal(looksLikeJSON(withBom('{"ship":128}')), true, 'UTF-8 BOM');
  assert.equal(looksLikeJSON(withBom('  {"x":1}')), true, 'BOM + whitespace');
  // binary pilot-fork magic (AppleDouble) and other non-JSON starts
  assert.equal(looksLikeJSON(Uint8Array.from([0x00, 0x05, 0x16, 0x07])), false);
  assert.equal(looksLikeJSON(enc('[1,2,3]')), false, 'JSON array is not a save');
  assert.equal(looksLikeJSON(new Uint8Array(0)), false, 'empty');
});

test('accepts a well-formed v2 save and returns the parsed object', () => {
  const save = { v: 2, name: 'Ripley', ship: 130, credits: 5000, cargo: { food: 3 } };
  const out = parsePilotJSON(JSON.stringify(save, null, 2));
  assert.deepEqual(out, save);
});

test('accepts a v1 save (migrated on load)', () => {
  const out = parsePilotJSON(JSON.stringify({ v: 1, name: 'Old', ship: 128 }));
  assert.equal(out.ship, 128);
});

test('rejects text that is not JSON', () => {
  assert.throws(() => parsePilotJSON('not json {'), /valid JSON/);
});

test('rejects JSON that is not a Vₑ save', () => {
  assert.throws(() => parsePilotJSON('[1,2,3]'), /Vₑ save/); // array
  assert.throws(() => parsePilotJSON('42'), /Vₑ save/); // scalar
  assert.throws(() => parsePilotJSON('null'), /Vₑ save/);
  assert.throws(() => parsePilotJSON('{"name":"x"}'), /Vₑ save/); // no ship / version
  assert.throws(() => parsePilotJSON('{"ship":128}'), /Vₑ save/); // no version
  assert.throws(() => parsePilotJSON('{"ship":"128","v":2}'), /Vₑ save/); // ship not int
});
