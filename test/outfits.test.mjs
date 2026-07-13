// Unit tests for the Outfits inventory state class (engine/shell/outfits.js).
// Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outfits } from '../engine/shell/outfits.js';

test('constructor seeds from a saved map and sanitizes junk', () => {
  const o = new Outfits({ 128: 2, 130: 1.9, 135: -3, 140: 0, bogus: 'x' });
  assert.equal(o.count(128), 2);
  assert.equal(o.count(130), 1, 'fractional floors');
  assert.equal(o.count(135), 0, 'negative dropped');
  assert.equal(o.count(140), 0, 'zero dropped');
  assert.equal(o.count('bogus'), 0, 'non-number dropped');
  assert.deepEqual(o.ids(), ['128', '130']);
});

test('add adds/removes, clamps at 0, and prunes an outfit at zero', () => {
  const o = new Outfits();
  assert.equal(o.add(128, 3), 3);
  assert.equal(o.count(128), 3);
  assert.equal(o.has(128), true);
  assert.equal(o.add(128, -1), 2);
  // overselling clamps to 0 and deletes the entry
  assert.equal(o.add(128, -100), 0);
  assert.equal(o.has(128), false);
  assert.deepEqual(o.ids(), [], 'pruned, not left at 0');
  // junk qty is a no-op
  assert.equal(o.add(130, NaN), 0);
  assert.equal(o.add(130, Infinity), 0);
  assert.equal(o.count(130), 0);
});

test('number and string ids address the same entry', () => {
  const o = new Outfits();
  o.add(165, 1);
  assert.equal(o.count('165'), 1, 'string id reads the numeric one');
  assert.equal(o.add('165', 1), 2);
  assert.equal(o.count(165), 2);
});

test('prototype-chain ids cannot poison the inventory', () => {
  const o = new Outfits();
  assert.equal(o.add('toString', 1), 1);
  assert.equal(o.count('toString'), 1, 'treated as a normal (own) key');
  assert.equal(o.has('constructor'), false);
  assert.deepEqual(o.entries(), [['toString', 1]]);
});

test('entries/clear/toJSON round-trip through the constructor', () => {
  const a = new Outfits({ 128: 2, 165: 1 });
  assert.deepEqual(a.entries().sort(), [
    ['128', 2],
    ['165', 1],
  ]);
  const b = new Outfits(a.toJSON());
  assert.deepEqual(b.toJSON(), a.toJSON());
  a.clear();
  assert.deepEqual(a.ids(), []);
  assert.deepEqual(a.toJSON(), {});
  assert.deepEqual(b.toJSON(), { 128: 2, 165: 1 }, 'clear did not touch the copy');
});
