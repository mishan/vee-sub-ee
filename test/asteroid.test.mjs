// Unit tests for the asteroid model + weapon-blocking geometry (engine/core.js),
// against the "Asteroids" section of engine/ENGINE_SPEC.md. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as EV from '../engine/core.js';

test('makeAsteroid sets a size-appropriate collision radius', () => {
  assert.equal(EV.makeAsteroid(0, 0, 0, 0, 0, 0, 1).r, EV.ASTEROID_RADII[0]);
  assert.equal(EV.makeAsteroid(0, 0, 0, 0, 2, 0, 1).r, EV.ASTEROID_RADII[2]);
});

test('stepAsteroid drifts, spins, and wraps toroidally within ±BOUND', () => {
  const B = EV.ASTEROID_BOUND;
  const a = EV.makeAsteroid(B - 1, 0, 2, 0, 1, 5, 7);
  EV.stepAsteroid(a); // x: B-1 → B+1 → wraps to -(B-1)
  assert.equal(a.x, B - 1 - 2 * B + 2, `wrapped: ${a.x}`);
  assert.ok(a.x < 0, 'wrapped to the far side');
  assert.equal(a.rot, 5, 'spun by spin per frame');
});

test('rayHitsAsteroids returns the nearest entry distance, or Infinity', () => {
  const rocks = [EV.makeAsteroid(100, 0, 0, 0, 1, 0, 1)]; // r=18 at x=100
  // ray straight along +x from origin enters the disc at 100 - r
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 500, rocks), 100 - EV.ASTEROID_RADII[1]);
  // too short to reach it
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 50, rocks), Infinity);
  // aimed away misses entirely
  assert.equal(EV.rayHitsAsteroids(0, 0, -1, 0, 500, rocks), Infinity);
  // a ray whose perpendicular offset exceeds the radius misses
  assert.equal(EV.rayHitsAsteroids(0, 100, 1, 0, 500, rocks), Infinity);
});

test('rayHitsAsteroids: nearest of several, and origin-inside blocks at 0', () => {
  const rocks = [
    EV.makeAsteroid(300, 0, 0, 0, 2, 0, 1),
    EV.makeAsteroid(150, 0, 0, 0, 0, 0, 2), // closer
  ];
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 500, rocks), 150 - EV.ASTEROID_RADII[0]);
  // origin inside a rock → blocked immediately (distance 0)
  assert.equal(EV.rayHitsAsteroids(150, 0, 1, 0, 500, rocks), 0);
});

test('shotHitsAsteroid sweeps the segment so a fast shot cannot tunnel', () => {
  const rocks = [EV.makeAsteroid(0, 0, 0, 0, 1, 0, 1)]; // r=18 at origin
  // a fast shot whose end-point (x=-30) is past the rock, but whose swept segment
  // (prev x=50 → cur x=-30) crossed it — the point test alone would miss this.
  assert.equal(shotAt(-30, 0, -80, 0, rocks), true, 'segment x=50→-30 crosses origin rock');
  // a shot well clear of the rock this frame (segment x=300→380)
  assert.equal(shotAt(300, 0, 80, 0, rocks), false);
  // a resting shot sitting inside a rock (mine) is blocked by the point test
  assert.equal(shotAt(5, 0, 0, 0, rocks), true);
  assert.equal(shotAt(300, 0, 0, 0, rocks), false);
});

// helper: a shot at (x,y) that moved by (vx,vy) this frame
function shotAt(x, y, vx, vy, rocks) {
  return EV.shotHitsAsteroid({ x, y, vx, vy }, rocks);
}
