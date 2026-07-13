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

test('new Ship normalizes heading and derives stats (== makeShip)', () => {
  const s = new Ship(SHUTTLE, 5, 7, -90);
  assert.equal(s.heading, 270);
  assert.deepEqual([s.x, s.y, s.vx, s.vy], [5, 7, 0, 0]);
  close(s.maxSpeed, 2.75);
  assert.equal(s.turn, 4);
  assert.ok(EV.makeShip(SHUTTLE, 0, 0, 0) instanceof Ship); // factory returns a Ship
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

test('Ship.stepJumpEngage becomes ready once aligned and up to speed', () => {
  const s = new Ship(SHUTTLE, 0, 0, 0);
  let ready = false;
  for (let i = 0; i < 400 && !ready; i++) ready = s.stepJumpEngage(0);
  assert.equal(ready, true);
  assert.ok(Math.hypot(s.vx, s.vy) >= 0.95 * s.maxSpeed);
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
  assert.ok(EV.makeShot({ Guidance: 0, Speed: 500, Count: 1 }, shooter, 0) instanceof Projectile);
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

test('stepWarship reports distance/alignment and thrusts in the bands', () => {
  const s = new Ship(SHUTTLE, 0, 0, 90); // already facing the target at +x
  const r = EV.stepWarship(s, 300, 0); // 300px away, aligned, dist > 260 → thrust
  close(r.dist, 300);
  assert.equal(r.aligned, true);
  assert.equal(s.thrusting, true);
});

// The shell still calls the free functions; verify they delegate identically to
// the methods (same mutation), so the compatibility layer is safe until removed.
test('legacy free-function wrappers delegate to methods', () => {
  const viaFn = new Ship(SHUTTLE, 0, 0, 0);
  const viaMethod = new Ship(SHUTTLE, 0, 0, 0);
  EV.thrust(viaFn);
  viaMethod.thrust();
  assert.deepEqual([viaFn.vx, viaFn.vy], [viaMethod.vx, viaMethod.vy]);

  assert.equal(EV.steerToward(new Ship(SHUTTLE, 0, 0, 0), 3), true);
  assert.equal(EV.retrograde(Object.assign(new Ship(SHUTTLE, 0, 0, 0), { vx: 1, vy: 0 })), 270);
  assert.equal(EV.canLand(new Ship(SHUTTLE, 10, 0, 0), { x: 0, y: 0 }), true);

  // wrappers also work on the plain state objects some call sites still pass
  const plain = { shields: 0, armor: 30, armorMax: 30 };
  assert.equal(EV.applyDamage(plain, { MassDmg: 8, EnergyDmg: 0 }), 'hit');
  assert.equal(plain.armor, 22);
  const regen = { shields: 0 };
  EV.stepShields(regen, 100, 1);
  assert.equal(regen.shields, 1);
});
