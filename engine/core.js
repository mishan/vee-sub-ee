/*
 * engine/core.js — DOM-free EV flight core. Normative behavior lives in
 * engine/ENGINE_SPEC.md; this file implements it.
 *
 * Entities are classes: `Ship` (kinematics, landing, hyperjump, damage) and
 * `Projectile` (shot flight). The math lives in their methods; the older
 * free-function exports (`thrust(s)`, `stepShot(shot, target)`, …) are kept as
 * thin wrappers that delegate to those methods, so the shell keeps working
 * unchanged while call sites migrate. The wrappers are duck-typed (they use
 * `Ship.prototype.method.call`), so they also work on the plain state objects
 * some call sites pass. See docs/OOP_DESIGN.md; these wrappers go away once
 * callers move to methods.
 *
 * An ES module: esbuild bundles it (npm run build:engine) into
 * engine/core.bundle.js — an IIFE that exposes the exports as the browser global
 * `EV`, which the flight shell reads and evexport.js / the loader inject at build
 * time. Node can `import` it directly (engine/package.json marks engine/*.js as
 * ES modules) — see test/core.test.mjs, run by `npm test`.
 */

// Sim tick rate. The per-frame physics below are unchanged; the wall-clock pace
// is (px/frame)·FPS, so running at 60 Hz makes the whole game move at the
// original's real-time speed — our old 30 Hz was half that (it matched the
// original only with the 2× pill held down). The 2× pill still doubles this.
const FPS = 60;

/* ---- unit conversions (spec: "Ship stat conversions") ---- */
const maxSpeedOf = (rec) => rec.Speed / 100; // px/frame
const accelOf = (rec) => rec.Accel / 9000; // px/frame²
const turnOf = (rec) => rec.Maneuver; // deg/frame

/* ---- angles ---- */
const rad = (d) => (d * Math.PI) / 180;
const norm = (d) => ((d % 360) + 360) % 360;
const frameIndex = (heading, frames) =>
  ((Math.round(heading / (360 / frames)) % frames) + frames) % frames;
const bearing = (dx, dy) => norm((Math.atan2(dx, -dy) * 180) / Math.PI);

/* ---- landing rules (spec: "Landing") ---- */
const LAND_DIST = 120, // the original is forgiving about landing range; 60 was
  LAND_SPEED = 0.9; //   too tight and made landing feel fussy (see spec)

/* ---- hyperjump (spec: "Hyperjump") ---- */
const JUMP_FUEL = 100,
  JUMP_STREAK_FRAMES = 60, // 1s at 60 Hz
  ARRIVE_DIST = 700;
const JUMP_WARMUP_FRAMES = 440; // ~7.3s hyperdrive spin-up before the streak;
// warmup + streak = 500 frames / 60 Hz = 8.3s, matching the Warp Up sound (these
// are doubled from the old 30 Hz values so the cinematic keeps its real duration)
const JUMP_MIN_DIST = 800; // no jumping this close to a spöb (approx.)

/* ---- combat (spec: "Combat") ---- */
const HOMING_TURN = 3; // deg/frame (approximation, see spec)
const ROCKET_ACCEL_DIV = 15; // rocket reaches max speed in 15 frames
const shotSpeedOf = (rec) => rec.Speed / 100;

/* ==================== entities ==================== */

/* A ship in flight. `rec` is its raw shïp record; the derived stats
 * (maxSpeed/accel/turn) are cached at construction. The shell adds more fields
 * to instances (weapons, shields/armor, hostile, …); methods only touch what
 * they read, so those extra fields are unaffected. */
class Ship {
  constructor(rec, x, y, heading) {
    this.rec = rec;
    this.x = x;
    this.y = y;
    this.heading = norm(heading);
    this.vx = 0;
    this.vy = 0;
    this.maxSpeed = maxSpeedOf(rec);
    this.accel = accelOf(rec);
    this.turn = turnOf(rec);
    this.thrusting = false;
  }

  thrust() {
    this.vx += Math.sin(rad(this.heading)) * this.accel;
    this.vy -= Math.cos(rad(this.heading)) * this.accel;
    const v = Math.hypot(this.vx, this.vy);
    if (v > this.maxSpeed) {
      this.vx *= this.maxSpeed / v;
      this.vy *= this.maxSpeed / v;
    }
    this.thrusting = true;
  }

  /* Turn toward `desired` (deg), clamped to the turn rate. Returns whether the
   * ship is now roughly aligned (within 1.5 turn-steps). */
  steerToward(desired) {
    let diff = norm(desired - this.heading);
    if (diff > 180) diff -= 360;
    const step = Math.max(-this.turn, Math.min(this.turn, diff));
    this.heading = norm(this.heading + step);
    return Math.abs(diff) < this.turn * 1.5;
  }

  /* Heading that points opposite the current velocity vector. */
  retrograde() {
    return norm((Math.atan2(-this.vx, this.vy) * 180) / Math.PI);
  }

  integrate() {
    this.x += this.vx;
    this.y += this.vy;
  }

  /* One frame of player control. controls: {left, right, retro, thrust}. */
  stepPlayer(c) {
    this.thrusting = false;
    if (c.left) this.heading = norm(this.heading - this.turn);
    if (c.right) this.heading = norm(this.heading + this.turn);
    if (c.retro) this.steerToward(this.retrograde());
    if (c.thrust) this.thrust();
    this.integrate();
  }

  canLand(spob) {
    return (
      Math.hypot(spob.x - this.x, spob.y - this.y) < LAND_DIST &&
      Math.hypot(this.vx, this.vy) <= LAND_SPEED
    );
  }

  placeAtTakeoff(spob) {
    this.x = spob.x;
    this.y = spob.y - 40;
    this.heading = 0;
    this.vx = 0;
    this.vy = 0; // launch stationary, not adrift
  }

  /* Autopilot one frame of jump engagement toward mapBearing (galaxy-map
   * bearing to destination). Returns true once ready to enter hyperspace:
   * aligned within one turn-step and at ≥95% max speed. */
  stepJumpEngage(mapBearing) {
    this.steerToward(mapBearing);
    this.thrust();
    this.integrate();
    let diff = norm(mapBearing - this.heading);
    if (diff > 180) diff -= 360;
    return Math.abs(diff) <= this.turn && Math.hypot(this.vx, this.vy) >= 0.95 * this.maxSpeed;
  }

  /* Arrival placement in the destination system. inBearing = map bearing from
   * origin to destination (degrees). */
  placeAtArrival(inBearing) {
    const b = rad(inBearing);
    this.x = -Math.sin(b) * ARRIVE_DIST;
    this.y = Math.cos(b) * ARRIVE_DIST;
    this.heading = norm(inBearing);
    this.vx = Math.sin(b) * this.maxSpeed;
    this.vy = -Math.cos(b) * this.maxSpeed;
  }

  /* Apply one weapon hit. Reads/writes this.{shields, armor, armorMax,
   * disableFrac?}. Returns 'shielded' | 'hit' | 'disabled' | 'destroyed'. */
  takeDamage(rec) {
    const up = this.shields > 0;
    const dmg = Math.max(1, up ? rec.MassDmg / 4 + rec.EnergyDmg : rec.MassDmg + rec.EnergyDmg / 4);
    if (up) {
      this.shields = Math.max(0, this.shields - dmg);
      return 'shielded';
    }
    this.armor -= dmg;
    if (this.armor <= 0) return 'destroyed';
    if (this.armor <= this.armorMax * (this.disableFrac ?? 1 / 3)) return 'disabled';
    return 'hit';
  }

  /* Regenerate +1% of max every ShieldRe frames (this gains a shieldT counter). */
  regenShields(shieldMax, shieldRe) {
    if (this.shields >= shieldMax || shieldRe <= 0) return;
    this.shieldT = (this.shieldT ?? 0) + 1;
    if (this.shieldT >= shieldRe) {
      this.shieldT = 0;
      this.shields = Math.min(shieldMax, this.shields + shieldMax / 100);
    }
  }
}

/* A projectile in flight (bullet / beam / homing missile / rocket). `aim` is
 * the launch heading the shell resolves (turret/quadrant aim + inaccuracy). */
class Projectile {
  constructor(rec, shooter, aim) {
    const g = rec.Guidance;
    const freefall = g === 5;
    const heading = freefall ? shooter.heading : norm(aim);
    const mv = freefall || g === 6 ? 0 : shotSpeedOf(rec);
    this.rec = rec;
    this.guidance = g;
    this.x = shooter.x;
    this.y = shooter.y;
    this.heading = heading;
    this.vx = shooter.vx * (freefall ? 0.8 : 1) + Math.sin(rad(heading)) * mv;
    this.vy = shooter.vy * (freefall ? 0.8 : 1) - Math.cos(rad(heading)) * mv;
    this.speed = shotSpeedOf(rec);
    this.life = rec.Count;
  }

  /* Advance one frame. target: {x, y} or null. Returns false when it expires. */
  step(target) {
    const g = this.guidance;
    if ((g === 1 || g === 2) && target) {
      let diff = norm(bearing(target.x - this.x, target.y - this.y) - this.heading);
      if (diff > 180) diff -= 360;
      this.heading = norm(this.heading + Math.max(-HOMING_TURN, Math.min(HOMING_TURN, diff)));
      this.vx = Math.sin(rad(this.heading)) * this.speed;
      this.vy = -Math.cos(rad(this.heading)) * this.speed;
    } else if (g === 6) {
      const acc = this.speed / ROCKET_ACCEL_DIV;
      this.vx += Math.sin(rad(this.heading)) * acc;
      this.vy -= Math.cos(rad(this.heading)) * acc;
      const v = Math.hypot(this.vx, this.vy);
      if (v > this.speed) {
        this.vx *= this.speed / v;
        this.vy *= this.speed / v;
      }
    }
    this.x += this.vx;
    this.y += this.vy;
    return --this.life > 0;
  }
}

/* ---- factories (the shell constructs entities through these) ---- */
const makeShip = (rec, x, y, heading) => new Ship(rec, x, y, heading);
const makeShot = (rec, shooter, aim) => new Projectile(rec, shooter, aim);

/* ---- free-function compatibility wrappers (delegate to the methods) ----
 * Kept until every call site uses methods; then deleted (see docs/OOP_DESIGN.md).
 * `.call` keeps them working on the plain objects a few callers still pass. */
const thrust = (s) => Ship.prototype.thrust.call(s);
const steerToward = (s, desired) => Ship.prototype.steerToward.call(s, desired);
const retrograde = (s) => Ship.prototype.retrograde.call(s);
const integrate = (s) => Ship.prototype.integrate.call(s);
const stepPlayer = (s, c) => Ship.prototype.stepPlayer.call(s, c);
const canLand = (s, spob) => Ship.prototype.canLand.call(s, spob);
const placeAtTakeoff = (s, spob) => Ship.prototype.placeAtTakeoff.call(s, spob);
const stepJumpEngage = (s, mapBearing) => Ship.prototype.stepJumpEngage.call(s, mapBearing);
const placeAtArrival = (s, inBearing) => Ship.prototype.placeAtArrival.call(s, inBearing);
const applyDamage = (st, rec) => Ship.prototype.takeDamage.call(st, rec);
const stepShields = (st, shieldMax, shieldRe) =>
  Ship.prototype.regenShields.call(st, shieldMax, shieldRe);
const stepShot = (shot, target) => Projectile.prototype.step.call(shot, target);

/* ==================== AI (spec: "AI …") ====================
 * Still free functions over a ship; Phase 3 (docs/OOP_DESIGN.md) turns these
 * into strategy objects. They drive a ship through the wrappers above. */

/* AI trader state machine (spec: "AI trader"). States on s.state:
 *   'cruise' → 'brake' → 'landed' (motionless above the planet) → 'depart'.
 * Landing no longer despawns the ship the way the original never made ships
 * vanish on touchdown: it sits still for s.landTimer frames, then takes off and
 * heads back out. The shell (TraderAI) assigns the depart target (a system edge)
 * and removes the ship once it's flown clear. target: {x, y}. Always returns
 * true; the shell owns the despawn decision now. */
function stepTrader(s, target) {
  s.thrusting = false;
  if (s.state === undefined) s.state = 'cruise';
  // Landed: hold position above the planet, counting down to takeoff.
  if (s.state === 'landed') {
    s.vx = 0;
    s.vy = 0;
    if ((s.landTimer = (s.landTimer ?? 0) - 1) <= 0) {
      s.state = 'depart';
      s.target = null; // shell picks an edge to leave through next frame
    }
    return true;
  }
  if (!target) {
    integrate(s);
    return true;
  }
  const dx = target.x - s.x,
    dy = target.y - s.y;
  const dist = Math.hypot(dx, dy);
  const speed = Math.hypot(s.vx, s.vy);
  // brake distance + coast while turning 180° to retrograde + pad
  const stopDist = (speed * speed) / (2 * s.accel) + speed * (180 / s.turn) + 40;
  if (s.state === 'cruise') {
    const aligned = steerToward(s, bearing(dx, dy));
    if (dist > stopDist) {
      if (aligned) thrust(s);
    } else s.state = 'brake';
  } else if (s.state === 'brake') {
    const aligned = steerToward(s, retrograde(s));
    if (speed > 0.15) {
      if (aligned) thrust(s);
    } else if (dist < 80) {
      // touchdown: sit motionless above the planet for a few seconds
      s.state = 'landed';
      s.landTimer = 120 + Math.floor(Math.random() * 180); // ~4–10s @30Hz
      s.vx = 0;
      s.vy = 0;
      return true;
    } else s.state = 'cruise';
  } else if (s.state === 'depart') {
    // head out to the edge target (set by the shell) and build up speed
    const aligned = steerToward(s, bearing(dx, dy));
    if (aligned) thrust(s);
  }
  integrate(s);
  return true;
}

/* Warship attack step (spec: "Warship AI"): steer, thrust per distance bands,
 * integrate. Returns {aligned, dist} so the shell decides firing. */
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
  FPS,
  maxSpeedOf,
  accelOf,
  turnOf,
  rad,
  norm,
  frameIndex,
  bearing,
  Ship,
  Projectile,
  makeShip,
  thrust,
  steerToward,
  retrograde,
  integrate,
  stepPlayer,
  stepTrader,
  LAND_DIST,
  LAND_SPEED,
  canLand,
  placeAtTakeoff,
  JUMP_FUEL,
  JUMP_STREAK_FRAMES,
  ARRIVE_DIST,
  JUMP_WARMUP_FRAMES,
  JUMP_MIN_DIST,
  stepJumpEngage,
  placeAtArrival,
  HOMING_TURN,
  shotSpeedOf,
  makeShot,
  stepShot,
  applyDamage,
  stepShields,
  stepWarship,
  stepFlee,
};
