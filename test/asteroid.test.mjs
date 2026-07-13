// Unit tests for the asteroid model + weapon-blocking geometry (engine/core.js),
// against the "Asteroids" section of engine/ENGINE_SPEC.md. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as EV from '../engine/core.js';

test('new Asteroid sets a size-appropriate collision radius (small/big)', () => {
  assert.equal(new EV.Asteroid(0, 0, 0, 0, 0, 0).r, EV.ASTEROID_RADII[0]);
  assert.equal(new EV.Asteroid(0, 0, 0, 0, 1, 0).r, EV.ASTEROID_RADII[1]);
});

test('Asteroid.step drifts, spins, and wraps within ±BOUND of the origin', () => {
  const B = EV.ASTEROID_BOUND;
  const a = new EV.Asteroid(B - 1, 0, 2, 0, 1, 5);
  a.step(); // x: B-1 → B+1 → wraps to -(B-1)
  assert.equal(a.x, -(B - 1), `wrapped: ${a.x}`);
  assert.equal(a.rot, 5, 'spun by spin per frame');
});

test('Asteroid.step wraps around the player so the field follows them', () => {
  const B = EV.ASTEROID_BOUND;
  const px = 2000; // far from the origin, to tell player-wrap from origin-wrap
  // A rock sitting exactly on the player stays put when wrapped around the player;
  // wrapping around the origin (the bug) would jump it to ~-600.
  const a = new EV.Asteroid(px, 0, 0, 0, 0, 0);
  a.step(px, 0);
  assert.equal(a.x, px, 'stayed on the player, not wrapped to the origin');
  // and one just past the far edge re-enters near the player
  const b = new EV.Asteroid(px + B + 10, 0, 0, 0, 0, 0);
  b.step(px, 0);
  assert.ok(Math.abs(b.x - px) <= B && b.x < px, `re-centred near the player: ${b.x}`);
});

test('rayHitsAsteroids returns the nearest entry distance, or Infinity', () => {
  const rocks = [new EV.Asteroid(100, 0, 0, 0, 1, 0)]; // r=14 at x=100
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 500, rocks), 100 - EV.ASTEROID_RADII[1]);
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 50, rocks), Infinity, 'too short to reach it');
  assert.equal(EV.rayHitsAsteroids(0, 0, -1, 0, 500, rocks), Infinity, 'aimed away');
  assert.equal(EV.rayHitsAsteroids(0, 100, 1, 0, 500, rocks), Infinity, 'perpendicular miss');
});

test('rayHitsAsteroids: nearest of several, and origin-inside blocks at 0', () => {
  const rocks = [
    new EV.Asteroid(300, 0, 0, 0, 1, 0),
    new EV.Asteroid(150, 0, 0, 0, 0, 0), // closer
  ];
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 500, rocks), 150 - EV.ASTEROID_RADII[0]);
  assert.equal(EV.rayHitsAsteroids(150, 0, 1, 0, 500, rocks), 0, 'origin inside → blocked at 0');
});

test('shotAsteroidImpact returns the swept-segment entry point (no tunnelling)', () => {
  const rocks = [new EV.Asteroid(0, 0, 0, 0, 1, 0)]; // r=14 at origin
  // end-point (x=-30) is past the rock, but the swept segment (prev x=50 → -30)
  // crossed it — a point test alone would miss this. Impact is at the near edge.
  const pt = shotAt(-30, 0, -80, 0, rocks);
  assert.ok(pt, 'segment x=50→-30 crosses origin rock');
  assert.deepEqual(
    pt,
    { x: EV.ASTEROID_RADII[1], y: 0 },
    'impact at the rock edge, not the shot end',
  );
  assert.equal(shotAt(300, 0, 80, 0, rocks), null, 'clear this frame (x=220→300)');
  // a resting shot (mine) inside a rock reports its own position as the impact
  assert.deepEqual(shotAt(5, 0, 0, 0, rocks), { x: 5, y: 0 });
  assert.equal(shotAt(300, 0, 0, 0, rocks), null);
});

// helper: a shot at (x,y) that moved by (vx,vy) this frame
function shotAt(x, y, vx, vy, rocks) {
  return EV.shotAsteroidImpact({ x, y, vx, vy }, rocks);
}
