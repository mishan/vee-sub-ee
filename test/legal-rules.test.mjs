import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relation, spreadGovtDelta } from '../engine/shell/legal-rules.js';

// govt-relations interface: 128 & 129 are allies; 128 & 130 are enemies; 140 is
// xenophobic. Ally/enemy are symmetric.
const rel = {
  allies: (g) => ({ 128: [129], 129: [128] })[g] || [],
  enemies: (g) => ({ 128: [130], 130: [128] })[g] || [],
  flags: (g) => (g === 140 ? ['xenophobic'] : []),
};

test('relation: own/allied +1, enemy −1, xenophobic −1 to strangers, neutral 0', () => {
  assert.equal(relation(128, 128, rel), 1); // the govt's own system
  assert.equal(relation(129, 128, rel), 1); // ally of the govt
  assert.equal(relation(128, 129, rel), 1); // ...other direction
  assert.equal(relation(130, 128, rel), -1); // enemy of the govt
  assert.equal(relation(128, 130, rel), -1); // ...other direction
  assert.equal(relation(200, 140, rel), -1); // a xenophobic govt: everyone's an enemy
  assert.equal(relation(131, 132, rel), 0); // unrelated govts
});

// Drive spreadGovtDelta with plain data; record the (system, amount) bumps the
// way the real wrapper does (skipping zero changes).
function run(govt, delta, { here, hereGovt, systems, prob = 0.25, frac = 0.4, rng }) {
  const bumps = [];
  spreadGovtDelta(govt, delta, {
    here,
    hereGovt,
    rel,
    prob,
    frac,
    rng,
    forEachSystem: (fn) => systems.forEach((s) => fn(s.id, s.govt)),
    bump: (sys, d) => {
      if (d) bumps.push([sys, d]);
    },
  });
  return bumps;
}

const HOME = { here: 500, hereGovt: 128 };
const SYSTEMS = [
  { id: 501, govt: 129 }, // ally of 128
  { id: 502, govt: 130 }, // enemy of 128
  { id: 503, govt: 131 }, // unrelated
  { id: 500, govt: 128 }, // the home system itself — must be skipped in the spread
];

test('spreadGovtDelta: no-op for a civilian govt or a zero delta', () => {
  assert.deepEqual(run(50, -100, { ...HOME, systems: SYSTEMS, rng: () => 0 }), []);
  assert.deepEqual(run(128, 0, { ...HOME, systems: SYSTEMS, rng: () => 0 }), []);
});

test('spreadGovtDelta: the current system always takes the full signed hit', () => {
  // A crime (−100) against govt 128, at home (own system) → full −100, no spread
  // when the scatter is everyone-missed.
  assert.deepEqual(run(128, -100, { ...HOME, systems: [], rng: () => 1 }), [[500, -100]]);
});

test('spreadGovtDelta: a tiny change that rounds to zero scatter stays local', () => {
  // round(-1 * 0.4) = 0 → the spread loop is skipped entirely.
  assert.deepEqual(run(128, -1, { ...HOME, systems: SYSTEMS, rng: () => 0 }), [[500, -1]]);
});

test('spreadGovtDelta: caught related systems take reduced, relation-signed scatter', () => {
  // scatter = round(-100 * 0.4) = -40. Ally moves with the govt (−40); the enemy
  // system flips (+40); the unrelated one and the home-in-list are skipped.
  assert.deepEqual(run(128, -100, { ...HOME, systems: SYSTEMS, rng: () => 0 }), [
    [500, -100], // home, full
    [501, -40], // ally: same sign
    [502, 40], // enemy: flipped
  ]);
});

test('spreadGovtDelta: the scatter is probabilistic — nobody caught when rng ≥ prob', () => {
  assert.deepEqual(run(128, -100, { ...HOME, systems: SYSTEMS, rng: () => 1 }), [[500, -100]]);
  // and a good deed (+200) spreads with the opposite signs
  assert.deepEqual(run(128, 200, { ...HOME, systems: SYSTEMS, rng: () => 0 }), [
    [500, 200], // home
    [501, 80], // ally: +round(200*0.4)
    [502, -80], // enemy: flipped
  ]);
});
