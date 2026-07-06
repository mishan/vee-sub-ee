/*
 * engine/core.js — DOM-free EV flight core. Normative behavior lives in
 * engine/ENGINE_SPEC.md; this file and cpp/main.cpp implement it, and
 * engine/check_traces.js proves they agree.
 *
 * Works as a node module (require) and as a browser global (EV) — the
 * flight shell gets this file injected at build time by evexport.js.
 */

(function (global) {
'use strict';

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
  const stopDist = speed * speed / (2 * s.accel) + 40;
  if (s.state === 'cruise') {
    const aligned = steerToward(s, bearing(dx, dy));
    if (dist > stopDist) { if (aligned) thrust(s); }
    else s.state = 'brake';
  } else if (s.state === 'brake') {
    const aligned = steerToward(s, retrograde(s));
    if (speed > 0.15) { if (aligned) thrust(s); }
    else if (dist < 60) s.state = 'landing';
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
  s.heading = 0; s.vx = 0; s.vy = -0.4;
}

/* ---- hyperjump (spec: "Hyperjump") ---- */
const JUMP_FUEL = 100, JUMP_STREAK_FRAMES = 30, ARRIVE_DIST = 700;
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

const EV = {
  FPS, maxSpeedOf, accelOf, turnOf,
  rad, norm, frameIndex, bearing,
  makeShip, thrust, steerToward, retrograde, integrate,
  stepPlayer, stepTrader,
  LAND_DIST, LAND_SPEED, canLand, placeAtTakeoff,
  JUMP_FUEL, JUMP_STREAK_FRAMES, ARRIVE_DIST, stepJumpEngage, placeAtArrival,
};

if (typeof module !== 'undefined' && module.exports) module.exports = EV;
else global.EV = EV;

})(typeof self !== 'undefined' ? self : this);
