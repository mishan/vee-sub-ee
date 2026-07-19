// Unit tests for the DOM-free flight core (engine/core.js), checked against the
// normative rules in engine/ENGINE_SPEC.md. Run with `npm test` (node --test).
//
// Entity behavior is tested through the Ship/Projectile methods; the pure
// helpers (norm, bearing, …) stay function tests; and a final group asserts the
// legacy free-function wrappers still delegate to the methods identically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as EV from '../engine/core.js';
import { Ship, Projectile } from '../engine/core.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
// Shuttlecraft, the spec's worked example: Speed 275, Accel 435, Maneuver 4.
const SHUTTLE = { Speed: 275, Accel: 435, Maneuver: 4 };

test('ship stat conversions (spec table)', () => {
  close(EV.maxSpeedOf(SHUTTLE), 2.75); // Speed / 100 px/frame
  close(EV.accelOf(SHUTTLE), 435 / 9000); // Accel / 9000 px/frame²
  assert.equal(EV.turnOf(SHUTTLE), 4); // Maneuver deg/frame
  assert.equal(EV.FPS, 60); // 60 Hz tick rate (2× the old 30 Hz) for real-time pace
});

test('angle helpers', () => {
  close(EV.rad(180), Math.PI);
  assert.equal(EV.norm(-90), 270);
  assert.equal(EV.norm(370), 10);
  assert.equal(EV.norm(0), 0);
  // heading 0 points up (−y), degrees clockwise (spec: coordinate system)
  assert.equal(EV.bearing(0, -1), 0); // up
  assert.equal(EV.bearing(1, 0), 90); // right (+x)
  assert.equal(EV.bearing(0, 1), 180); // down (+y)
  assert.equal(EV.bearing(-1, 0), 270); // left
});

test('frameIndex picks the nearest sprite frame, wrapping', () => {
  assert.equal(EV.frameIndex(0, 36), 0);
  assert.equal(EV.frameIndex(10, 36), 1); // exactly on frame 1 (360/36 = 10°)
  assert.equal(EV.frameIndex(4, 36), 0); // rounds down to nearer frame 0
  assert.equal(EV.frameIndex(6, 36), 1); // rounds up to nearer frame 1
  assert.equal(EV.frameIndex(-10, 36), 35); // negative wraps
});

test('new Ship normalizes heading and derives stats', () => {
  const s = new Ship(SHUTTLE, 5, 7, -90);
  assert.equal(s.heading, 270);
  assert.deepEqual([s.x, s.y, s.vx, s.vy], [5, 7, 0, 0]);
  close(s.maxSpeed, 2.75);
  assert.equal(s.turn, 4);
});

test('Ship.thrust pushes along heading and clamps to maxSpeed', () => {
  // heading 0 (up) → velocity gains −y; accel = 1 for these stats
  const s = new Ship({ Speed: 200, Accel: 9000, Maneuver: 4 }, 0, 0, 0);
  s.thrust();
  close(s.vx, 0);
  close(s.vy, -1);
  for (let i = 0; i < 20; i++) s.thrust(); // way past max
  close(Math.hypot(s.vx, s.vy), 2); // clamped to maxSpeed = 200/100
  assert.equal(s.thrusting, true);
});

test('Ship.afterburn drives past maxSpeed toward the boosted cap', () => {
  const s = new Ship({ Speed: 200, Accel: 9000, Maneuver: 4 }, 0, 0, 0); // accel 1, maxSpeed 2
  s.afterburn();
  assert.equal(s.thrusting, true);
  for (let i = 0; i < 50; i++) s.afterburn(); // heading 0 (up) → velocity gains −y
  close(Math.hypot(s.vx, s.vy), 4); // cap = AFTERBURNER_SPEED(2) × maxSpeed(2)
  assert.ok(Math.hypot(s.vx, s.vy) > s.maxSpeed); // above normal cruise
});

test('Ship.stepPlayer: afterburn supersedes normal thrust', () => {
  const s = new Ship({ Speed: 200, Accel: 9000, Maneuver: 4 }, 0, 0, 0);
  for (let i = 0; i < 50; i++) s.stepPlayer({ thrust: true, afterburn: true });
  close(Math.hypot(s.vx, s.vy), 4); // boosted cap, not the plain maxSpeed of 2
});

test('Ship.steerToward clamps to turn rate and reports alignment', () => {
  const s = new Ship(SHUTTLE, 0, 0, 0); // turn = 4
  assert.equal(s.steerToward(90), false); // 90° away → not aligned
  assert.equal(s.heading, 4); // moved one turn-step
  const t = new Ship(SHUTTLE, 0, 0, 0);
  assert.equal(t.steerToward(3), true); // within 1.5·turn = 6°
  assert.equal(t.heading, 3);
});

test('Ship.retrograde faces opposite the velocity vector', () => {
  const s = new Ship(SHUTTLE, 0, 0, 0);
  s.vx = 1;
  s.vy = 0; // moving right → retrograde = left (270)
  assert.equal(s.retrograde(), 270);
  s.vx = 0;
  s.vy = -1; // moving up → retrograde = down (180)
  assert.equal(s.retrograde(), 180);
});

test('Ship.integrate advances position by velocity (no drag)', () => {
  const s = new Ship(SHUTTLE, 10, 20, 0);
  s.vx = 3;
  s.vy = -4;
  s.integrate();
  assert.deepEqual([s.x, s.y], [13, 16]);
});

test('Ship.canLand: near a spob and slow enough', () => {
  const spob = { x: 0, y: 0 };
  const s = new Ship(SHUTTLE, 30, 0, 0); // dist 30 < 120
  s.vx = 0;
  s.vy = 0.5; // speed 0.5 ≤ 0.9
  assert.equal(s.canLand(spob), true);
  s.vy = 1.5; // too fast
  assert.equal(s.canLand(spob), false);
  const far = new Ship(SHUTTLE, 150, 0, 0); // dist 150 ≥ 120
  assert.equal(far.canLand(spob), false);
});

test('Ship.placeAtTakeoff parks the ship stationary above the spob', () => {
  const s = new Ship(SHUTTLE, 0, 0, 123);
  s.vx = 5;
  s.vy = 5;
  s.placeAtTakeoff({ x: 100, y: 200 });
  assert.deepEqual([s.x, s.y, s.heading, s.vx, s.vy], [100, 160, 0, 0, 0]);
});

test('warp cinematic lasts the length of the Warp Up sound (~8.3s)', () => {
  // The frame counts themselves are an implementation detail; what must hold is
  // that warmup + streak run for the Warp Up sound's duration *at the current
  // tick rate*. If FPS changes, the frame counts have to track it — this catches
  // that, where asserting the literal frame numbers would not.
  const warpSeconds = (EV.JUMP_WARMUP_FRAMES + EV.JUMP_STREAK_FRAMES) / EV.FPS;
  close(warpSeconds, 8.3, 0.1);
  // the streak is the brief visual tail after the longer spin-up
  assert.ok(EV.JUMP_STREAK_FRAMES < EV.JUMP_WARMUP_FRAMES);
});

test('Ship.thrust honors a custom speed cap (the jump run raises it)', () => {
  const s = new Ship({ Speed: 200, Accel: 9000, Maneuver: 4 }, 0, 0, 0); // accel 1, maxSpeed 2
  for (let i = 0; i < 20; i++) s.thrust(5); // cap above maxSpeed
  close(Math.hypot(s.vx, s.vy), 5); // clamps to the given cap, not maxSpeed
});

test('Ship.stepJumpEngage turns onto the bearing, then burns toward the cap', () => {
  const s = new Ship(SHUTTLE, 0, 0, 90); // 90° off the bearing (0)
  assert.equal(s.stepJumpEngage(0, 100), false); // still turning → not ready
  let ready = false;
  for (let i = 0; i < 400 && !ready; i++) ready = s.stepJumpEngage(0, 100);
  assert.equal(ready, true); // aligned within a turn-step
  for (let i = 0; i < 400; i++) s.stepJumpEngage(0, 100);
  assert.ok(Math.hypot(s.vx, s.vy) > s.maxSpeed); // a high cap accelerates past cruise
});

test('Ship.stepJumpBrake kills momentum and reports when stopped', () => {
  const s = new Ship({ Speed: 200, Accel: 9000, Maneuver: 180 }, 0, 0, 0); // turns instantly
  s.vx = 3; // moving, above the ~stopped threshold (accel = 1)
  s.vy = 0;
  let stopped = false;
  for (let i = 0; i < 50 && !stopped; i++) stopped = s.stepJumpBrake();
  assert.equal(stopped, true);
  assert.ok(Math.hypot(s.vx, s.vy) <= s.accel);
});

test('Ship.placeAtArrival positions on the inbound bearing at ARRIVE_DIST', () => {
  const s = new Ship(SHUTTLE, 0, 0, 0);
  s.placeAtArrival(0); // bearing 0
  close(s.x, 0);
  close(s.y, 700);
  assert.equal(s.heading, 0);
  close(s.vx, 0);
  close(s.vy, -s.maxSpeed); // heading toward centre
});

test('Ship.takeDamage: shields absorb, then armor, then disable/destroy', () => {
  const withState = (o) => Object.assign(new Ship(SHUTTLE, 0, 0, 0), o);
  // shields up: dmg = MassDmg/4 + EnergyDmg
  const a = withState({ shields: 10, armor: 30, armorMax: 30 });
  assert.equal(a.takeDamage({ MassDmg: 0, EnergyDmg: 8 }), 'shielded');
  assert.equal(a.shields, 2);
  // shields down: dmg = MassDmg + EnergyDmg/4; disabled at ≤ 1/3 armorMax
  const b = withState({ shields: 0, armor: 30, armorMax: 30 });
  assert.equal(b.takeDamage({ MassDmg: 8, EnergyDmg: 0 }), 'hit'); // 30 → 22
  assert.equal(b.takeDamage({ MassDmg: 14, EnergyDmg: 0 }), 'disabled'); // 22 → 8 ≤ 10
  const c = withState({ shields: 0, armor: 5, armorMax: 30 });
  assert.equal(c.takeDamage({ MassDmg: 10, EnergyDmg: 0 }), 'destroyed');
  // every hit does at least 1
  const d = withState({ shields: 5, armor: 5, armorMax: 30 });
  assert.equal(d.takeDamage({ MassDmg: 0, EnergyDmg: 0 }), 'shielded');
  assert.equal(d.shields, 4);
});

test('Ship.regenShields regenerates 1% of max every ShieldRe frames', () => {
  const st = Object.assign(new Ship(SHUTTLE, 0, 0, 0), { shields: 0 });
  st.regenShields(100, 2); // frame 1: counter only
  assert.equal(st.shields, 0);
  st.regenShields(100, 2); // frame 2: +1% of 100
  assert.equal(st.shields, 1);
  const full = Object.assign(new Ship(SHUTTLE, 0, 0, 0), { shields: 100 });
  full.regenShields(100, 2);
  assert.equal(full.shields, 100); // capped
});

test('new Projectile: beams inherit shooter heading, guided/unguided get muzzle speed', () => {
  const shooter = { x: 0, y: 0, vx: 0, vy: 0, heading: 0 };
  const beam = new Projectile({ Guidance: 5, Speed: 1000, Count: 3 }, shooter, 90);
  assert.equal(beam.heading, 0); // freefall (beam) ignores aim, uses shooter heading
  const gun = new Projectile({ Guidance: 0, Speed: 500, Count: 60 }, shooter, 90);
  assert.equal(gun.heading, 90);
  close(gun.vx, 5);
  close(gun.vy, 0); // Speed/100 muzzle velocity along aim (90° = +x)
  assert.equal(gun.life, 60);
});

test('Projectile.step: homing turns toward target and expires with life', () => {
  const shot = new Projectile(
    { Guidance: 1, Speed: 500, Count: 2 },
    { x: 0, y: 0, vx: 0, vy: 0 },
    0,
  );
  const alive = shot.step({ x: 100, y: 0 }); // target to the right (bearing 90)
  assert.equal(alive, true);
  assert.equal(shot.heading, EV.HOMING_TURN); // turned by HOMING_TURN toward 90
  assert.equal(shot.life, 1);
  assert.equal(shot.step(null), false); // life hits 0
});

test('Ship.stepWarship reports distance/alignment and thrusts in the bands', () => {
  const s = new Ship(SHUTTLE, 0, 0, 90); // already facing the target at +x
  const r = s.stepWarship(300, 0); // 300px away, aligned, dist > 260 → thrust
  close(r.dist, 300);
  assert.equal(r.aligned, true);
  assert.equal(s.thrusting, true);

  // In the dead band (120–260) an aligned warship coasts instead of burning.
  const mid = new Ship(SHUTTLE, 0, 0, 90);
  mid.stepWarship(200, 0);
  assert.equal(mid.thrusting, false);
  // ...but closes when very near (<120), even already on top of the target.
  const near = new Ship(SHUTTLE, 0, 0, 90);
  near.stepWarship(50, 0);
  assert.equal(near.thrusting, true);
});

test('Ship.stepFlee turns tail to the threat and burns once aligned', () => {
  // threat at +x (bearing 90) → flee heading is 270; start already facing 270.
  const s = new Ship(SHUTTLE, 0, 0, 270);
  s.stepFlee(100, 0);
  assert.equal(s.heading, 270); // already aligned away from the threat
  assert.equal(s.thrusting, true);
});

test('Ship.stepTrader: cruise → brake → landed → depart state machine', () => {
  const port = { x: 0, y: 2000 }; // far off, so it keeps cruising (dist > stopDist)
  const s = new Ship(SHUTTLE, 0, 0, 0);
  s.stepTrader(port); // first frame: undefined → cruise
  assert.equal(s.state, 'cruise');
  // Close and slow: it brakes, then touches down and holds still with a timer.
  const t = new Ship(SHUTTLE, 0, 0, 0);
  t.vx = 0;
  t.vy = 0;
  t.state = 'brake';
  t.stepTrader({ x: 0, y: 10 }); // within 80, speed ~0 → touchdown
  assert.equal(t.state, 'landed');
  assert.ok(t.landTimer > 0);
  // Landed holds position and counts down; at zero it departs (target cleared).
  const d = new Ship(SHUTTLE, 0, 0, 0);
  d.state = 'landed';
  d.landTimer = 1;
  d.vx = 5; // landing pins velocity to zero
  d.stepTrader(null);
  assert.deepEqual([d.vx, d.vy], [0, 0]);
  assert.equal(d.state, 'depart');
});

/* ---- weapon ↔ ship collision geometry ---- */

test('shotHitsShip: within the larger of the shot prox radius and the ship half', () => {
  const shot = { x: 0, y: 0, rec: { ProxRadius: 10 } };
  assert.equal(EV.shotHitsShip(shot, { x: 5, y: 0 }, 3), true); // 5 < max(10,3)
  assert.equal(EV.shotHitsShip(shot, { x: 12, y: 0 }, 3), false); // 12 ≥ 10
  assert.equal(EV.shotHitsShip(shot, { x: 8, y: 0 }, 20), true); // half dominates: 8 < 20
  assert.equal(EV.shotHitsShip(shot, { x: 10, y: 0 }, 0), false); // exactly on the radius (strict <)
});

test('inBlastRadius: ship centre within (inclusive) the blast radius of the impact', () => {
  assert.equal(EV.inBlastRadius(0, 0, { x: 20, y: 0 }, 25), true); // inside
  assert.equal(EV.inBlastRadius(0, 0, { x: 30, y: 0 }, 25), false); // outside
  assert.equal(EV.inBlastRadius(0, 0, { x: 25, y: 0 }, 25), true); // exactly on the edge (inclusive)
  assert.equal(EV.inBlastRadius(100, 100, { x: 100, y: 100 }, 5), true); // at the impact point
  assert.equal(EV.inBlastRadius(0, 0, { x: 3, y: 4 }, 5), true); // 3-4-5: distance 5 == radius
});

test('explosionScale: native for a plain hit, scaled to the blast (capped) for a big one', () => {
  assert.equal(EV.explosionScale(0, 32, 3), 1); // no blast → native
  assert.equal(EV.explosionScale(8, 32, 3), 1); // 16 px diameter < 32 sprite → native
  assert.equal(EV.explosionScale(25, 32, 3), (2 * 25) / 32); // 50/32 = 1.5625× (Heavy Rockets)
  assert.equal(EV.explosionScale(55, 32, 3), 3); // 110/32 = 3.4 → capped at 3 (Space Bomb)
  assert.equal(EV.explosionScale(100, 32, 3), 3); // capped
});

test('beamHitDist: distance along the beam to a target, or Infinity on a miss', () => {
  // beam from the origin along +x (unit dir), up to length 500
  const hit = (tx, ty, half) => EV.beamHitDist(0, 0, 1, 0, 500, { x: tx, y: ty }, half);
  assert.equal(hit(100, 0, 4), 100); // dead on the ray → t = 100
  assert.equal(hit(-50, 0, 4), Infinity); // behind the muzzle (t < 0)
  assert.equal(hit(600, 0, 4), Infinity); // past the beam's reach (t > 500)
  assert.equal(hit(100, 20, 4), Infinity); // perpendicular miss (20 ≥ 8 + 2)
  assert.equal(hit(100, 9, 4), 100); // just inside the fat beam (9 < 8 + 2)
});

test('maxWeaponRange: beams reach Speed, projectiles shotSpeed·Count, bays excluded', () => {
  const beam = { rec: { Guidance: 0, Speed: 200 } }; // beam: range = Speed
  const turret = { rec: { Guidance: 3, Speed: 150 } }; // turreted beam, same rule
  const gun = { rec: { Guidance: 1, Speed: 500, Count: 60 } }; // shotSpeed 5 · 60 = 300
  const bay = { rec: { Guidance: 99, Speed: 9999, Count: 9 } }; // fighter bay — not fire
  assert.equal(EV.maxWeaponRange({ weapons: [beam] }), 200);
  assert.equal(EV.maxWeaponRange({ weapons: [turret] }), 150);
  assert.equal(EV.maxWeaponRange({ weapons: [gun] }), 300);
  assert.equal(EV.maxWeaponRange({ weapons: [bay] }), 0); // a bay alone gives no fire range
  assert.equal(EV.maxWeaponRange({ weapons: [beam, gun, bay] }), 300); // max of the real weapons
  assert.equal(EV.maxWeaponRange({ weapons: [] }), 0);
});
