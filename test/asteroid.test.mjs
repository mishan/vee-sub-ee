// Unit tests for the asteroid model + weapon-blocking geometry (engine/core.js),
// against the "Asteroids" section of engine/ENGINE_SPEC.md. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as EV from '../engine/core.js';

test('makeAsteroid sets a size-appropriate collision radius (small/big)', () => {
  assert.equal(EV.makeAsteroid(0, 0, 0, 0, 0, 0).r, EV.ASTEROID_RADII[0]);
  assert.equal(EV.makeAsteroid(0, 0, 0, 0, 1, 0).r, EV.ASTEROID_RADII[1]);
});

test('stepAsteroid drifts, spins, and wraps within ±BOUND of the origin', () => {
  const B = EV.ASTEROID_BOUND;
  const a = EV.makeAsteroid(B - 1, 0, 2, 0, 1, 5);
  EV.stepAsteroid(a); // x: B-1 → B+1 → wraps to -(B-1)
  assert.equal(a.x, -(B - 1), `wrapped: ${a.x}`);
  assert.equal(a.rot, 5, 'spun by spin per frame');
});

test('stepAsteroid wraps around the player so the field follows them', () => {
  const B = EV.ASTEROID_BOUND;
  const px = 1000;
  const a = EV.makeAsteroid(px + B + 10, 0, 0, 0, 0, 0); // just past the far edge
  EV.stepAsteroid(a, px, 0);
  assert.ok(Math.abs(a.x - px) <= B, `re-centred near the player: ${a.x}`);
  assert.ok(a.x < px, 'wrapped to the near side of the player');
});

test('rayHitsAsteroids returns the nearest entry distance, or Infinity', () => {
  const rocks = [EV.makeAsteroid(100, 0, 0, 0, 1, 0)]; // r=14 at x=100
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 500, rocks), 100 - EV.ASTEROID_RADII[1]);
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 50, rocks), Infinity, 'too short to reach it');
  assert.equal(EV.rayHitsAsteroids(0, 0, -1, 0, 500, rocks), Infinity, 'aimed away');
  assert.equal(EV.rayHitsAsteroids(0, 100, 1, 0, 500, rocks), Infinity, 'perpendicular miss');
});

test('rayHitsAsteroids: nearest of several, and origin-inside blocks at 0', () => {
  const rocks = [
    EV.makeAsteroid(300, 0, 0, 0, 1, 0),
    EV.makeAsteroid(150, 0, 0, 0, 0, 0), // closer
  ];
  assert.equal(EV.rayHitsAsteroids(0, 0, 1, 0, 500, rocks), 150 - EV.ASTEROID_RADII[0]);
  assert.equal(EV.rayHitsAsteroids(150, 0, 1, 0, 500, rocks), 0, 'origin inside → blocked at 0');
});

test('shotHitsAsteroid sweeps the segment so a fast shot cannot tunnel', () => {
  const rocks = [EV.makeAsteroid(0, 0, 0, 0, 1, 0)]; // r=14 at origin
  // end-point (x=-30) is past the rock, but the swept segment (prev x=50 → -30)
  // crossed it — the point test alone would miss this.
  assert.equal(shotAt(-30, 0, -80, 0, rocks), true, 'segment x=50→-30 crosses origin rock');
  assert.equal(shotAt(300, 0, 80, 0, rocks), false, 'clear this frame (x=220→300)');
  // a resting shot (mine) inside a rock is caught by the point test
  assert.equal(shotAt(5, 0, 0, 0, rocks), true);
  assert.equal(shotAt(300, 0, 0, 0, rocks), false);
});

// helper: a shot at (x,y) that moved by (vx,vy) this frame
function shotAt(x, y, vx, vy, rocks) {
  return EV.shotHitsAsteroid({ x, y, vx, vy }, rocks);
}
