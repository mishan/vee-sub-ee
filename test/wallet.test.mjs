// Unit tests for the Wallet state class (engine/shell/wallet.js).
// Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from '../engine/shell/wallet.js';

test('canAfford reports whether a cost fits the balance', () => {
  const w = new Wallet(100);
  assert.equal(w.credits, 100);
  assert.ok(w.canAfford(100)); // exact balance is affordable
  assert.ok(w.canAfford(0));
  assert.ok(!w.canAfford(101));
});

test('earn and spend move the balance', () => {
  const w = new Wallet(100);
  w.earn(50);
  assert.equal(w.credits, 150);
  w.spend(120);
  assert.equal(w.credits, 30);
  assert.ok(w.canAfford(30));
  assert.ok(!w.canAfford(31));
});

test('spend enforces the affordability invariant', () => {
  const w = new Wallet(100);
  w.spend(100); // exact-balance spend is allowed → 0
  assert.equal(w.credits, 0);
  const v = new Wallet(50);
  assert.throws(() => v.spend(51), RangeError); // overdraw throws
  assert.equal(v.credits, 50); // ...and leaves the balance untouched
});

test('a fresh Wallet defaults to 0 credits', () => {
  assert.equal(new Wallet().credits, 0);
});
