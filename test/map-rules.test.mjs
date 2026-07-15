import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibleSystems } from '../engine/shell/map-rules.js';

// A tiny galaxy: 128 — 129 — 130 (a chain), plus 200 off on its own.
const systs = {
  128: { Con1: 129 },
  129: { Con1: 128, Con2: 130 },
  130: { Con1: 129 },
  200: {}, // isolated, no links
};
const sorted = (set) => [...set].sort((a, b) => a - b);

test('computeVisibleSystems: explored systems and their direct neighbours', () => {
  const vis = computeVisibleSystems(systs, new Set([128]), new Set());
  assert.deepEqual(sorted(vis), [128, 129]); // 128 + its neighbour 129
  assert.ok(!vis.has(130)); // two hops out → still fogged
  assert.ok(!vis.has(200)); // isolated, unrelated → fogged
});

test('computeVisibleSystems: a mission destination is always shown, even unexplored and non-adjacent', () => {
  const vis = computeVisibleSystems(systs, new Set([128]), new Set([200, 130]));
  assert.ok(vis.has(200)); // deep-fog isolated destination → a guide node
  assert.ok(vis.has(130)); // two hops out but a destination → shown
  assert.ok(vis.has(129)); // ordinary neighbour, still there
});

test('computeVisibleSystems: a mission destination naming a missing system is ignored', () => {
  const vis = computeVisibleSystems(systs, new Set([128]), new Set([999]));
  assert.ok(!vis.has(999));
});

test('computeVisibleSystems: Con entries below 128 are not neighbours', () => {
  const s = { 128: { Con1: 0, Con2: 129 }, 129: { Con1: 128 } };
  const vis = computeVisibleSystems(s, new Set([128]), new Set());
  assert.deepEqual(sorted(vis), [128, 129]); // Con1 = 0 is "no link", skipped
});
