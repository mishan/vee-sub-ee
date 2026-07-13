/*
 * engine/core.js — DOM-free EV flight core. Normative behavior lives in
 * engine/ENGINE_SPEC.md; this file implements it.
 *
 * Entities are classes: `Ship` (kinematics, landing, hyperjump, damage),
 * `Projectile` (shot flight) and `Asteroid`. The math lives in their methods,
 * and callers use those methods directly (`ship.thrust()`, `shot.step(target)`,
 * `new EV.Ship(rec, x, y, h)`). The old `EV.thrust(ship)`-style free-function
 * wrappers and the make* factories are gone — one way to do each thing (see
 * docs/OOP_DESIGN.md). The per-behavior AI movement (warship/trader/flee) is now
 * `Ship` methods too; the shell's `aiFor` strategy layer picks which to run.
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

  /* ---- AI movement (spec: "AI …") ----
   * One frame of a behavior. The strategy layer (the shell's `aiFor`) decides
   * which to run, picks the target, and fires; the movement math lives here on
   * the ship (docs/OOP_DESIGN.md phase 3). */

  /* AI trader state machine (spec: "AI trader"). States on this.state:
   *   'cruise' → 'brake' → 'landed' (motionless above the planet) → 'depart'.
   * Landing doesn't despawn the ship (the original never made ships vanish on
   * touchdown): it holds still for landTimer frames, then takes off and heads
   * back out. The shell (TraderAI) assigns the depart target (a system edge) and
   * removes the ship once it's flown clear. target: {x, y}. Always returns true;
   * the shell owns the despawn decision. */
  stepTrader(target) {
    this.thrusting = false;
    if (this.state === undefined) this.state = 'cruise';
    // Landed: hold position above the planet, counting down to takeoff.
    if (this.state === 'landed') {
      this.vx = 0;
      this.vy = 0;
      if ((this.landTimer = (this.landTimer ?? 0) - 1) <= 0) {
        this.state = 'depart';
        this.target = null; // shell picks an edge to leave through next frame
      }
      return true;
    }
    if (!target) {
      this.integrate();
      return true;
    }
    const dx = target.x - this.x,
      dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    const speed = Math.hypot(this.vx, this.vy);
    // brake distance + coast while turning 180° to retrograde + pad
    const stopDist = (speed * speed) / (2 * this.accel) + speed * (180 / this.turn) + 40;
    if (this.state === 'cruise') {
      const aligned = this.steerToward(bearing(dx, dy));
      if (dist > stopDist) {
        if (aligned) this.thrust();
      } else this.state = 'brake';
    } else if (this.state === 'brake') {
      const aligned = this.steerToward(this.retrograde());
      if (speed > 0.15) {
        if (aligned) this.thrust();
      } else if (dist < 80) {
        // touchdown: sit motionless above the planet for a few seconds
        this.state = 'landed';
        this.landTimer = 120 + Math.floor(Math.random() * 180); // ~4–10s @30Hz
        this.vx = 0;
        this.vy = 0;
        return true;
      } else this.state = 'cruise';
    } else if (this.state === 'depart') {
      // head out to the edge target (set by the shell) and build up speed
      const aligned = this.steerToward(bearing(dx, dy));
      if (aligned) this.thrust();
    }
    this.integrate();
    return true;
  }

  /* Warship attack step (spec: "Warship AI"): steer, thrust per distance bands,
   * integrate. Returns {aligned, dist} so the shell decides firing. */
  stepWarship(ex, ey) {
    const dist = Math.hypot(ex - this.x, ey - this.y);
    const aligned = this.steerToward(bearing(ex - this.x, ey - this.y));
    if ((dist > 260 && aligned) || dist < 120) this.thrust();
    this.integrate();
    return { aligned, dist };
  }

  /* Flee: turn tail to the threat and burn. */
  stepFlee(ex, ey) {
    const aligned = this.steerToward(norm(bearing(ex - this.x, ey - this.y) + 180));
    if (aligned) this.thrust();
    this.integrate();
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

/* ---- asteroids (spec: "Asteroids") ----
 * Inert cover: rocks that drift and spin but never touch ships; their only effect
 * is to block weapons fire (projectiles absorbed, beams stopped short). Size 0/1
 * is small/big, matching EV's two asteroid sprites (spïn 800/801) and a collision
 * radius. The field wraps around the player (see step) so it always surrounds them
 * while they're in an asteroid system. */
const ASTEROID_BOUND = 1300; // rocks wrap within ±this (px) of the player
const ASTEROID_RADII = [10, 14]; // collision radius by size (small / big)

class Asteroid {
  constructor(x, y, vx, vy, size, spin) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.size = size;
    this.r = ASTEROID_RADII[size] ?? ASTEROID_RADII[0];
    this.rot = 0;
    this.spin = spin; // deg/frame (drives the sprite's rotation frame)
  }

  /* Drift and spin one frame, wrapping toroidally within ±BOUND of the point
   * (px,py) — the player — so the field follows them and never disperses. With no
   * point given it wraps around the origin. */
  step(px = 0, py = 0) {
    this.x += this.vx;
    this.y += this.vy;
    this.rot = norm(this.rot + this.spin);
    const B = ASTEROID_BOUND,
      W = 2 * B;
    const wrap = (d) => ((((d + B) % W) + W) % W) - B; // fold into [-B, B)
    this.x = px + wrap(this.x - px);
    this.y = py + wrap(this.y - py);
  }
}

/* Nearest distance along a unit ray (ox,oy) + t·(dx,dy), t∈[0,maxLen], at which it
 * first enters an asteroid — or Infinity if none is hit. Origin-inside counts as 0.
 * Drives both beam blocking and the swept-segment test for projectiles. */
function rayHitsAsteroids(ox, oy, dx, dy, maxLen, asteroids) {
  let best = Infinity;
  for (const a of asteroids) {
    const mx = a.x - ox,
      my = a.y - oy;
    const tc = mx * dx + my * dy; // asteroid centre projected onto the ray
    if (tc - a.r > maxLen) continue; // disc begins past the ray's end
    if (tc + a.r < 0) continue; // disc ends before the ray's start
    const perp2 = mx * mx + my * my - tc * tc; // perpendicular distance²
    const r2 = a.r * a.r;
    if (perp2 > r2) continue; // ray misses the disc
    let t = tc - Math.sqrt(r2 - perp2); // entry point along the ray
    if (t < 0) t = 0; // origin already inside → blocked here
    if (t <= maxLen && t < best) best = t;
  }
  return best;
}

/* Where a shot's swept path (previous → current position) first enters an
 * asteroid this frame, as {x, y}, or null if it hits none. Testing the swept
 * segment stops a fast shot from tunnelling a thin rock; returning the entry
 * point (not just a boolean) lets the shell play the impact effect where the rock
 * actually stopped the shot, not at its post-step position. */
function shotAsteroidImpact(shot, asteroids) {
  const len = Math.hypot(shot.vx, shot.vy);
  if (len < 1e-6) {
    // a resting shot (e.g. a dropped mine): plain point-in-disc test
    for (const a of asteroids)
      if ((a.x - shot.x) ** 2 + (a.y - shot.y) ** 2 < a.r * a.r) return { x: shot.x, y: shot.y };
    return null;
  }
  const dx = shot.vx / len,
    dy = shot.vy / len;
  const ox = shot.x - shot.vx, // where the shot was last frame
    oy = shot.y - shot.vy;
  const t = rayHitsAsteroids(ox, oy, dx, dy, len, asteroids);
  return t < Infinity ? { x: ox + dx * t, y: oy + dy * t } : null;
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
  LAND_DIST,
  LAND_SPEED,
  JUMP_FUEL,
  JUMP_STREAK_FRAMES,
  ARRIVE_DIST,
  JUMP_WARMUP_FRAMES,
  JUMP_MIN_DIST,
  HOMING_TURN,
  shotSpeedOf,
  Asteroid,
  rayHitsAsteroids,
  shotAsteroidImpact,
  ASTEROID_BOUND,
  ASTEROID_RADII,
};
