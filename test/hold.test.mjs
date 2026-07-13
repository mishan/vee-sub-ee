// Unit tests for the Hold cargo-hold state class (engine/shell/hold.js).
// Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hold } from '../engine/shell/hold.js';

const KEYS = ['food', 'industrial', 'medical', 'luxury', 'metal', 'equipment'];

test('constructor seeds from a saved-cargo map and sanitizes junk', () => {
  const h = new Hold(KEYS, { food: 3, industrial: 2.9, medical: -5, bogus: 9 });
  assert.equal(h.get('food'), 3);
  assert.equal(h.get('industrial'), 2, 'fractional tons floor');
  assert.equal(h.get('medical'), 0, 'negative → 0');
  assert.equal(h.get('luxury'), 0, 'unset → 0');
  assert.equal(h.get('bogus'), 0, 'unknown commodity is not held');
  assert.equal(h.used(), 5);
});

test('adjust adds/removes and clamps at 0, returning the real delta', () => {
  const h = new Hold(KEYS);
  assert.equal(h.adjust('metal', 10), 10);
  assert.equal(h.get('metal'), 10);
  assert.equal(h.adjust('metal', -3), -3);
  assert.equal(h.get('metal'), 7);
  // overselling clamps and reports the amount actually removed
  assert.equal(h.adjust('metal', -100), -7);
  assert.equal(h.get('metal'), 0);
  assert.equal(h.used(), 0);
  // junk / unknown key are no-ops
  assert.equal(h.adjust('metal', NaN), 0);
  assert.equal(h.adjust('nope', 5), 0);
});

test('clampTo dumps overflow down to capacity and reports tons dumped', () => {
  const h = new Hold(KEYS, { food: 6, metal: 6 }); // 12 tons
  assert.equal(h.clampTo(20), 0, 'under capacity → nothing dumped');
  assert.equal(h.clampTo(5), 7, '12 → 5 dumps 7');
  assert.equal(h.used(), 5);
  assert.equal(h.clampTo(0), 5, 'clamp to 0 empties the hold');
  assert.equal(h.used(), 0);
});

test('toJSON round-trips through the constructor', () => {
  const a = new Hold(KEYS, { food: 4, equipment: 1 });
  const b = new Hold(KEYS, a.toJSON());
  assert.deepEqual(b.toJSON(), a.toJSON());
  assert.equal(b.used(), 5);
});
