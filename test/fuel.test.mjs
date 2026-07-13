// Unit tests for the Fuel state class (engine/shell/fuel.js).
// Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fuel } from '../engine/shell/fuel.js';

// Shuttlecraft: 400-unit tank, 100 per jump → 4 jumps.
const shuttle = () => new Fuel(400, 100);

test('a fresh tank starts full', () => {
  const f = shuttle();
  assert.equal(f.value, 400);
  assert.equal(f.jumps, 4);
  assert.equal(f.fraction, 1);
  assert.equal(f.full(), true);
});

test('jumps report whole hyperjumps affordable', () => {
  const f = new Fuel(250, 100);
  assert.equal(f.jumps, 2, '250 / 100 → 2 whole jumps');
});

test('canJump / spendJump spend one jump and clamp at empty', () => {
  const f = shuttle();
  assert.equal(f.canJump(), true);
  f.spendJump();
  assert.equal(f.value, 300);
  assert.equal(f.jumps, 3);
  f.spendJump();
  f.spendJump();
  f.spendJump(); // 4 total → empty
  assert.equal(f.value, 0);
  assert.equal(f.canJump(), false);
  f.spendJump(); // no-op past empty (never negative)
  assert.equal(f.value, 0);
});

test('refill tops the tank back to max', () => {
  const f = shuttle();
  f.spendJump();
  f.spendJump();
  assert.equal(f.value, 200);
  f.refill();
  assert.equal(f.value, 400);
  assert.equal(f.full(), true);
});

test('setMax resizes the tank and clamps a now-overfull level', () => {
  const f = shuttle(); // 400/400
  f.setMax(600); // bigger tank, level unchanged (not auto-refilled)
  assert.equal(f.max, 600);
  assert.equal(f.value, 400);
  assert.equal(f.full(), false);
  f.setMax(300); // smaller tank than the current level → clamp down
  assert.equal(f.max, 300);
  assert.equal(f.value, 300);
});

test('fraction stays within 0..1 and guards a zero-size tank', () => {
  const f = new Fuel(400, 100);
  f.spendJump(); // 300/400
  assert.equal(f.fraction, 0.75);
  const empty = new Fuel(0, 100);
  assert.equal(empty.fraction, 0);
});
