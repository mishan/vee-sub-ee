import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priceAt,
  techAvailable,
  isMapOutfit,
  tradeInValue,
  refuelCost,
} from '../engine/shell/trade-rules.js';

// The commodity tables the shell threads into priceAt (community multipliers
// per CLAUDE.md's "Known approximations": Low 0.80 / Med 1.00 / High 1.25).
const tables = {
  commodities: ['Food', 'Industrial', 'Medical', 'Luxury', 'Metal', 'Equipment'],
  priceMult: { Low: 0.8, Med: 1.0, High: 1.25 },
  basePrices: [100, 200, 300, 400, 500, 600],
};

test('priceAt: base price scaled by the spöb price level, rounded', () => {
  const spob = { $sem: { prices: { Food: 'Low', Industrial: 'High' } } };
  assert.equal(priceAt(spob, 0, tables), 80); // 100 * 0.80
  assert.equal(priceAt(spob, 1, tables), 250); // 200 * 1.25
});

test('priceAt: null when the spöb has no price semantics or no level for the good', () => {
  assert.equal(priceAt({ $sem: null }, 0, tables), null); // no $sem at all
  assert.equal(priceAt({ $sem: { prices: {} } }, 2, tables), null); // good not listed
  // an unknown level name (not in priceMult) also yields null, not a NaN price
  assert.equal(priceAt({ $sem: { prices: { Medical: 'Bogus' } } }, 2, tables), null);
});

test('priceAt: rounds to the nearest credit', () => {
  const spob = { $sem: { prices: { Medical: 'Low' } } };
  assert.equal(priceAt(spob, 2, tables), 240); // 300 * 0.80 = 240 exactly
  const odd = { ...tables, basePrices: [0, 0, 333, 0, 0, 0] };
  assert.equal(priceAt(spob, 2, odd), Math.round(333 * 0.8)); // 266.4 → 266
});

test('techAvailable: at-or-below spöb tech, or an exact SpecialTech match', () => {
  const p = { TechLevel: 3, SpecialTech1: 50, SpecialTech2: -1, SpecialTech3: -1 };
  assert.equal(techAvailable(3, p), true); // equal to tech level
  assert.equal(techAvailable(1, p), true); // below
  assert.equal(techAvailable(4, p), false); // above, no special match
  assert.equal(techAvailable(50, p), true); // above, but a SpecialTech match
});

test('isMapOutfit: only true for a modType "map" outfit', () => {
  assert.equal(isMapOutfit({ $sem: { modType: 'map' } }), true);
  assert.equal(isMapOutfit({ $sem: { modType: 'weapon' } }), false);
  assert.equal(isMapOutfit({}), false);
  assert.equal(isMapOutfit(null), false);
});

test('tradeInValue: 25% of hull cost plus installed outfits, rounded', () => {
  // hull 100000; outfits: 2×10000 + 1×5000 = 25000; total 125000; 25% = 31250
  const entries = [
    ['150', 2],
    ['151', 1],
  ];
  const costOf = (oid) => ({ 150: 10000, 151: 5000 })[oid] || 0;
  assert.equal(tradeInValue(100000, entries, costOf), 31250);
});

test('tradeInValue: unknown outfit ids contribute nothing; empty inventory = 25% of hull', () => {
  assert.equal(
    tradeInValue(40000, [], () => 0),
    10000,
  );
  const entries = [['999', 3]]; // id not in the cost table
  assert.equal(
    tradeInValue(40000, entries, () => 0),
    10000,
  );
});

test('refuelCost: unit price times the missing fuel, zero when full', () => {
  assert.equal(refuelCost(30, 100, 2), 140); // (100-30) * 2
  assert.equal(refuelCost(100, 100, 2), 0); // already full
});
