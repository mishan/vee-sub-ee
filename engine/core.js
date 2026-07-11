/*
 * engine/core.js — DOM-free EV flight core. Normative behavior lives in
 * engine/ENGINE_SPEC.md; this file implements it.
 *
 * An ES module: esbuild bundles it (npm run build:engine) into
 * engine/core.bundle.js — an IIFE that exposes the exports as the browser global
 * `EV`, which the flight shell reads and evexport.js / the loader inject at build
 * time. (The repo defaults to CommonJS, so Node can't `require` this directly;
 * for a Node-side engine test import it via a `.mjs` shim or
 * `node --input-type=module`.)
 */

const FPS = 30;

/* ---- unit conversions (spec: "Ship stat conversions") ---- */
const maxSpeedOf = rec => rec.Speed / 100;   // px/frame
const accelOf    = rec => rec.Accel / 9000;  // px/frame²
const turnOf     = rec => rec.Maneuver;      // deg/frame

/* ---- angles ---- */
const rad = d => d * Math.PI / 180;
const norm = d => ((d % 360) + 360) % 360;
const frameIndex = (heading, frames) =>
  ((Math.round(heading / (360 / frames)) % frames) + frames) % frames;
const bearing = (dx, dy) => norm(Math.atan2(dx, -dy) * 180 / Math.PI);

/* ---- entities ---- */
function makeShip(rec, x, y, heading) {
  return {
    rec, x, y, heading: norm(heading), vx: 0, vy: 0,
    maxSpeed: maxSpeedOf(rec), accel: accelOf(rec), turn: turnOf(rec),
    thrusting: false,
  };
}

function thrust(s) {
  s.vx += Math.sin(rad(s.heading)) * s.accel;
  s.vy -= Math.cos(rad(s.heading)) * s.accel;
  const v = Math.hypot(s.vx, s.vy);
  if (v > s.maxSpeed) { s.vx *= s.maxSpeed / v; s.vy *= s.maxSpeed / v; }
  s.thrusting = true;
}

function steerToward(s, desired) {
  let diff = norm(desired - s.heading);
  if (diff > 180) diff -= 360;
  const step = Math.max(-s.turn, Math.min(s.turn, diff));
  s.heading = norm(s.heading + step);
  return Math.abs(diff) < s.turn * 1.5;
}

const retrograde = s => norm(Math.atan2(-s.vx, s.vy) * 180 / Math.PI);

function integrate(s) { s.x += s.vx; s.y += s.vy; }

/* ---- player controls (spec: "Player controls") ----
 * controls: {left, right, retro, thrust} booleans for this frame.
 * Applies controls and integrates. */
function stepPlayer(s, c) {
  s.thrusting = false;
  if (c.left)  s.heading = norm(s.heading - s.turn);
  if (c.right) s.heading = norm(s.heading + s.turn);
  if (c.retro) steerToward(s, retrograde(s));
  if (c.thrust) thrust(s);
  integrate(s);
}

/* ---- AI trader state machine (spec: "AI trader state machine") ----
 * s.state: 'cruise' | 'brake' | 'landing'; s.fade for landing.
 * target: {x, y}. Returns false once the entity should despawn. */
function stepTrader(s, target) {
  s.thrusting = false;
  if (!target) { integrate(s); return true; }
  if (s.state === undefined) s.state = 'cruise';
  const dx = target.x - s.x, dy = target.y - s.y;
  const dist = Math.hypot(dx, dy);
  const speed = Math.hypot(s.vx, s.vy);
  // brake distance + coast while turning 180° to retrograde + pad
  const stopDist = speed * speed / (2 * s.accel) + speed * (180 / s.turn) + 40;
  if (s.state === 'cruise') {
    const aligned = steerToward(s, bearing(dx, dy));
    if (dist > stopDist) { if (aligned) thrust(s); }
    else s.state = 'brake';
  } else if (s.state === 'brake') {
    const aligned = steerToward(s, retrograde(s));
    if (speed > 0.15) { if (aligned) thrust(s); }
    else if (dist < 80) s.state = 'landing';
    else s.state = 'cruise';
  } else { // landing
    s.fade = (s.fade ?? 1) - 0.02;
    if (s.fade <= 0) return false;
  }
  integrate(s);
  return true;
}

/* ---- landing rules (spec: "Landing") ---- */
const LAND_DIST = 60, LAND_SPEED = 0.9;
function canLand(s, spob) {
  return Math.hypot(spob.x - s.x, spob.y - s.y) < LAND_DIST &&
         Math.hypot(s.vx, s.vy) <= LAND_SPEED;
}
function placeAtTakeoff(s, spob) {
  s.x = spob.x; s.y = spob.y - 40;
  s.heading = 0; s.vx = 0; s.vy = 0; // launch stationary, not adrift
}

/* ---- hyperjump (spec: "Hyperjump") ---- */
const JUMP_FUEL = 100, JUMP_STREAK_FRAMES = 30, ARRIVE_DIST = 700;
const JUMP_WARMUP_FRAMES = 220;  // hyperdrive spin-up before the streak
const JUMP_MIN_DIST = 800;       // no jumping this close to a spöb (approx.)
/* Autopilot one frame of jump engagement toward mapBearing (galaxy-map
 * bearing to destination). Returns true once ship is ready to enter
 * hyperspace: aligned within one turn-step and at ≥95% max speed. */
function stepJumpEngage(s, mapBearing) {
  steerToward(s, mapBearing);
  thrust(s);
  integrate(s);
  let diff = norm(mapBearing - s.heading);
  if (diff > 180) diff -= 360;
  return Math.abs(diff) <= s.turn && Math.hypot(s.vx, s.vy) >= 0.95 * s.maxSpeed;
}
/* Arrival placement in the destination system. inBearing = map bearing
 * from origin to destination (degrees). */
function placeAtArrival(s, inBearing) {
  const b = rad(inBearing);
  s.x = -Math.sin(b) * ARRIVE_DIST;
  s.y = Math.cos(b) * ARRIVE_DIST;
  s.heading = norm(inBearing);
  s.vx = Math.sin(b) * s.maxSpeed;
  s.vy = -Math.cos(b) * s.maxSpeed;
}

/* ---- combat (spec: "Combat") ---- */
const HOMING_TURN = 3;          // deg/frame (approximation, see spec)
const ROCKET_ACCEL_DIV = 15;    // rocket reaches max speed in 15 frames
const shotSpeedOf = rec => rec.Speed / 100;

/* aim: launch heading (shell resolves turret/quadrant aim + inaccuracy).
 * shooter: {x, y, vx, vy, heading}. */
function makeShot(rec, shooter, aim) {
  const g = rec.Guidance;
  const freefall = g === 5;
  const heading = freefall ? shooter.heading : norm(aim);
  const mv = (freefall || g === 6) ? 0 : shotSpeedOf(rec);
  return {
    rec, guidance: g,
    x: shooter.x, y: shooter.y, heading,
    vx: shooter.vx * (freefall ? 0.8 : 1) + Math.sin(rad(heading)) * mv,
    vy: shooter.vy * (freefall ? 0.8 : 1) - Math.cos(rad(heading)) * mv,
    speed: shotSpeedOf(rec),
    life: rec.Count,
  };
}

/* target: {x, y} or null. Returns false when the shot expires. */
function stepShot(shot, target) {
  const g = shot.guidance;
  if ((g === 1 || g === 2) && target) {
    let diff = norm(bearing(target.x - shot.x, target.y - shot.y) - shot.heading);
    if (diff > 180) diff -= 360;
    shot.heading = norm(shot.heading + Math.max(-HOMING_TURN, Math.min(HOMING_TURN, diff)));
    shot.vx = Math.sin(rad(shot.heading)) * shot.speed;
    shot.vy = -Math.cos(rad(shot.heading)) * shot.speed;
  } else if (g === 6) {
    const acc = shot.speed / ROCKET_ACCEL_DIV;
    shot.vx += Math.sin(rad(shot.heading)) * acc;
    shot.vy -= Math.cos(rad(shot.heading)) * acc;
    const v = Math.hypot(shot.vx, shot.vy);
    if (v > shot.speed) { shot.vx *= shot.speed / v; shot.vy *= shot.speed / v; }
  }
  shot.x += shot.vx; shot.y += shot.vy;
  return --shot.life > 0;
}

/* st: {shields, armor, armorMax, disableFrac?}. Returns the ship's new
 * condition after one hit: 'shielded' | 'hit' | 'disabled' | 'destroyed'. */
function applyDamage(st, rec) {
  const up = st.shields > 0;
  const dmg = Math.max(1, up ? rec.MassDmg / 4 + rec.EnergyDmg
                             : rec.MassDmg + rec.EnergyDmg / 4);
  if (up) { st.shields = Math.max(0, st.shields - dmg); return 'shielded'; }
  st.armor -= dmg;
  if (st.armor <= 0) return 'destroyed';
  if (st.armor <= st.armorMax * (st.disableFrac ?? (1 / 3))) return 'disabled';
  return 'hit';
}

/* +1% of max every ShieldRe frames (st gains a shieldT counter). */
function stepShields(st, shieldMax, shieldRe) {
  if (st.shields >= shieldMax || shieldRe <= 0) return;
  st.shieldT = (st.shieldT ?? 0) + 1;
  if (st.shieldT >= shieldRe) {
    st.shieldT = 0;
    st.shields = Math.min(shieldMax, st.shields + shieldMax / 100);
  }
}

/* Warship attack step (spec: "Warship AI"): steer, thrust per distance
 * bands, integrate. Returns {aligned, dist} so the shell decides firing. */
function stepWarship(s, ex, ey) {
  const dist = Math.hypot(ex - s.x, ey - s.y);
  const aligned = steerToward(s, bearing(ex - s.x, ey - s.y));
  if ((dist > 260 && aligned) || dist < 120) thrust(s);
  integrate(s);
  return { aligned, dist };
}
/* Flee: turn tail to the threat and burn. */
function stepFlee(s, ex, ey) {
  const aligned = steerToward(s, norm(bearing(ex - s.x, ey - s.y) + 180));
  if (aligned) thrust(s);
  integrate(s);
}

export {
  FPS, maxSpeedOf, accelOf, turnOf,
  rad, norm, frameIndex, bearing,
  makeShip, thrust, steerToward, retrograde, integrate,
  stepPlayer, stepTrader,
  LAND_DIST, LAND_SPEED, canLand, placeAtTakeoff,
  JUMP_FUEL, JUMP_STREAK_FRAMES, ARRIVE_DIST, JUMP_WARMUP_FRAMES,
  JUMP_MIN_DIST, stepJumpEngage, placeAtArrival,
  HOMING_TURN, shotSpeedOf, makeShot, stepShot, applyDamage, stepShields,
  stepWarship, stepFlee,
};
