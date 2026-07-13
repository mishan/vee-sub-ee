import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearest, aiEnemies, combatTarget } from '../engine/shell/ai-targeting.js';

// A govt-relations interface (see aiEnemies): 128 & 129 are allies; 128 & 130
// are enemies; 140 is xenophobic (attacks strangers). Ally/enemy are symmetric.
const rel = {
  allies: (g) => ({ 128: [129], 129: [128] })[g] || [],
  enemies: (g) => ({ 128: [130], 130: [128] })[g] || [],
  flags: (g) => (g === 140 ? ['xenophobic'] : []),
};

// Build a candidate ship with the default (targetable) flags, overridable.
const ship = (o) => ({
  deathT: -1,
  disabled: false,
  playerEscort: false,
  misnId: null,
  isPers: false,
  hostile: false,
  govt: 130,
  ...o,
});

test('nearest: closest eligible candidate, skipping self and the ineligible', () => {
  const self = { x: 0, y: 0 };
  const a = { x: 300, y: 0, ok: true };
  const b = { x: 100, y: 0, ok: true }; // closer
  const c = { x: 10, y: 0, ok: false }; // closest but ineligible
  assert.equal(
    nearest(self, [a, b, c], (o) => o.ok),
    b,
  );
  assert.equal(
    nearest(self, [self, c], (o) => o.ok ?? true),
    null,
  ); // none eligible
});

test('aiEnemies: same govt / civilians never; allies never; enemies always; xeno attacks strangers', () => {
  assert.equal(aiEnemies(128, 128, rel), false); // same govt
  assert.equal(aiEnemies(50, 130, rel), false); // same govt civilian (<128)
  assert.equal(aiEnemies(130, 50, rel), false); // other govt civilian (<128)
  assert.equal(aiEnemies(128, 129, rel), false); // allies
  assert.equal(aiEnemies(128, 130, rel), true); // enemies
  assert.equal(aiEnemies(130, 128, rel), true); // enemies, other direction
  assert.equal(aiEnemies(140, 200, rel), true); // xenophobic vs a stranger
  assert.equal(aiEnemies(131, 132, rel), false); // neither related nor xeno
});

const ctx = (o) => ({ player: null, foe: null, hunts: false, rel, engageRange: 1600, ...o });

test('combatTarget: the player, only when hostile-to-self and targetable', () => {
  const self = { x: 0, y: 0, govt: 128, hostile: true };
  const player = { x: 100, y: 0 };
  assert.equal(combatTarget(self, [], ctx({ player })), player);
  assert.equal(combatTarget(self, [], ctx({ player: null })), null); // not targetable
  assert.equal(combatTarget({ ...self, hostile: false }, [], ctx({ player })), null); // not hostile
});

test('combatTarget: a foe is fought at any range, even beyond engageRange', () => {
  const self = { x: 0, y: 0, govt: 128, hostile: false };
  const foe = ship({ x: 5000, y: 0, govt: 128 }); // same govt, far — only "foe" makes it eligible
  assert.equal(combatTarget(self, [foe], ctx({ foe })), foe);
});

test('combatTarget: an ambient hunter chases a govt-enemy only within engageRange', () => {
  const self = { x: 0, y: 0, govt: 128, hostile: false };
  const near = ship({ x: 1000, y: 0, govt: 130 });
  const far = ship({ x: 2000, y: 0, govt: 130 });
  assert.equal(combatTarget(self, [near], ctx({ hunts: true })), near); // 1000 ≤ 1600
  assert.equal(combatTarget(self, [far], ctx({ hunts: true })), null); // 2000 > 1600
  assert.equal(combatTarget(self, [near], ctx({ hunts: false })), null); // non-hunter ignores govt-enemies
});

test('combatTarget: never ambient-targets the dead, disabled, escorts, mission or pers ships', () => {
  const self = { x: 0, y: 0, govt: 128, hostile: false };
  const at = (o) => ship({ x: 100, y: 0, govt: 130, ...o });
  for (const bad of [
    at({ deathT: 0 }),
    at({ disabled: true }),
    at({ playerEscort: true }),
    at({ misnId: 5 }),
    at({ isPers: true }),
  ])
    assert.equal(combatTarget(self, [bad], ctx({ hunts: true })), null);
});

test('combatTarget: picks the nearest eligible; a tie keeps the player', () => {
  const self = { x: 0, y: 0, govt: 128, hostile: true };
  const near = ship({ x: 100, y: 0, govt: 130 });
  const far = ship({ x: 500, y: 0, govt: 130 });
  assert.equal(combatTarget(self, [far, near], ctx({ hunts: true })), near);
  // player and a govt-enemy exactly as close → the player wins (ships need to be
  // strictly closer to displace it).
  const player = { x: 100, y: 0 };
  assert.equal(combatTarget(self, [near], ctx({ player, hunts: true })), player);
});
