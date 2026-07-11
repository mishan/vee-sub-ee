/* GENERATED from engine/core.js by esbuild — do not edit. Rebuild: make engine/core.bundle.js */
var EV = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // engine/core.js
  var core_exports = {};
  __export(core_exports, {
    ARRIVE_DIST: () => ARRIVE_DIST,
    FPS: () => FPS,
    HOMING_TURN: () => HOMING_TURN,
    JUMP_FUEL: () => JUMP_FUEL,
    JUMP_MIN_DIST: () => JUMP_MIN_DIST,
    JUMP_STREAK_FRAMES: () => JUMP_STREAK_FRAMES,
    JUMP_WARMUP_FRAMES: () => JUMP_WARMUP_FRAMES,
    LAND_DIST: () => LAND_DIST,
    LAND_SPEED: () => LAND_SPEED,
    accelOf: () => accelOf,
    applyDamage: () => applyDamage,
    bearing: () => bearing,
    canLand: () => canLand,
    frameIndex: () => frameIndex,
    integrate: () => integrate,
    makeShip: () => makeShip,
    makeShot: () => makeShot,
    maxSpeedOf: () => maxSpeedOf,
    norm: () => norm,
    placeAtArrival: () => placeAtArrival,
    placeAtTakeoff: () => placeAtTakeoff,
    rad: () => rad,
    retrograde: () => retrograde,
    shotSpeedOf: () => shotSpeedOf,
    steerToward: () => steerToward,
    stepFlee: () => stepFlee,
    stepJumpEngage: () => stepJumpEngage,
    stepPlayer: () => stepPlayer,
    stepShields: () => stepShields,
    stepShot: () => stepShot,
    stepTrader: () => stepTrader,
    stepWarship: () => stepWarship,
    thrust: () => thrust,
    turnOf: () => turnOf
  });
  var FPS = 30;
  var maxSpeedOf = (rec) => rec.Speed / 100;
  var accelOf = (rec) => rec.Accel / 9e3;
  var turnOf = (rec) => rec.Maneuver;
  var rad = (d) => d * Math.PI / 180;
  var norm = (d) => (d % 360 + 360) % 360;
  var frameIndex = (heading, frames) => (Math.round(heading / (360 / frames)) % frames + frames) % frames;
  var bearing = (dx, dy) => norm(Math.atan2(dx, -dy) * 180 / Math.PI);
  function makeShip(rec, x, y, heading) {
    return {
      rec,
      x,
      y,
      heading: norm(heading),
      vx: 0,
      vy: 0,
      maxSpeed: maxSpeedOf(rec),
      accel: accelOf(rec),
      turn: turnOf(rec),
      thrusting: false
    };
  }
  function thrust(s) {
    s.vx += Math.sin(rad(s.heading)) * s.accel;
    s.vy -= Math.cos(rad(s.heading)) * s.accel;
    const v = Math.hypot(s.vx, s.vy);
    if (v > s.maxSpeed) {
      s.vx *= s.maxSpeed / v;
      s.vy *= s.maxSpeed / v;
    }
    s.thrusting = true;
  }
  function steerToward(s, desired) {
    let diff = norm(desired - s.heading);
    if (diff > 180) diff -= 360;
    const step = Math.max(-s.turn, Math.min(s.turn, diff));
    s.heading = norm(s.heading + step);
    return Math.abs(diff) < s.turn * 1.5;
  }
  var retrograde = (s) => norm(Math.atan2(-s.vx, s.vy) * 180 / Math.PI);
  function integrate(s) {
    s.x += s.vx;
    s.y += s.vy;
  }
  function stepPlayer(s, c) {
    s.thrusting = false;
    if (c.left) s.heading = norm(s.heading - s.turn);
    if (c.right) s.heading = norm(s.heading + s.turn);
    if (c.retro) steerToward(s, retrograde(s));
    if (c.thrust) thrust(s);
    integrate(s);
  }
  function stepTrader(s, target) {
    s.thrusting = false;
    if (!target) {
      integrate(s);
      return true;
    }
    if (s.state === void 0) s.state = "cruise";
    const dx = target.x - s.x, dy = target.y - s.y;
    const dist = Math.hypot(dx, dy);
    const speed = Math.hypot(s.vx, s.vy);
    const stopDist = speed * speed / (2 * s.accel) + speed * (180 / s.turn) + 40;
    if (s.state === "cruise") {
      const aligned = steerToward(s, bearing(dx, dy));
      if (dist > stopDist) {
        if (aligned) thrust(s);
      } else s.state = "brake";
    } else if (s.state === "brake") {
      const aligned = steerToward(s, retrograde(s));
      if (speed > 0.15) {
        if (aligned) thrust(s);
      } else if (dist < 80) s.state = "landing";
      else s.state = "cruise";
    } else {
      s.fade = (s.fade ?? 1) - 0.02;
      if (s.fade <= 0) return false;
    }
    integrate(s);
    return true;
  }
  var LAND_DIST = 60;
  var LAND_SPEED = 0.9;
  function canLand(s, spob) {
    return Math.hypot(spob.x - s.x, spob.y - s.y) < LAND_DIST && Math.hypot(s.vx, s.vy) <= LAND_SPEED;
  }
  function placeAtTakeoff(s, spob) {
    s.x = spob.x;
    s.y = spob.y - 40;
    s.heading = 0;
    s.vx = 0;
    s.vy = 0;
  }
  var JUMP_FUEL = 100;
  var JUMP_STREAK_FRAMES = 30;
  var ARRIVE_DIST = 700;
  var JUMP_WARMUP_FRAMES = 220;
  var JUMP_MIN_DIST = 800;
  function stepJumpEngage(s, mapBearing) {
    steerToward(s, mapBearing);
    thrust(s);
    integrate(s);
    let diff = norm(mapBearing - s.heading);
    if (diff > 180) diff -= 360;
    return Math.abs(diff) <= s.turn && Math.hypot(s.vx, s.vy) >= 0.95 * s.maxSpeed;
  }
  function placeAtArrival(s, inBearing) {
    const b = rad(inBearing);
    s.x = -Math.sin(b) * ARRIVE_DIST;
    s.y = Math.cos(b) * ARRIVE_DIST;
    s.heading = norm(inBearing);
    s.vx = Math.sin(b) * s.maxSpeed;
    s.vy = -Math.cos(b) * s.maxSpeed;
  }
  var HOMING_TURN = 3;
  var ROCKET_ACCEL_DIV = 15;
  var shotSpeedOf = (rec) => rec.Speed / 100;
  function makeShot(rec, shooter, aim) {
    const g = rec.Guidance;
    const freefall = g === 5;
    const heading = freefall ? shooter.heading : norm(aim);
    const mv = freefall || g === 6 ? 0 : shotSpeedOf(rec);
    return {
      rec,
      guidance: g,
      x: shooter.x,
      y: shooter.y,
      heading,
      vx: shooter.vx * (freefall ? 0.8 : 1) + Math.sin(rad(heading)) * mv,
      vy: shooter.vy * (freefall ? 0.8 : 1) - Math.cos(rad(heading)) * mv,
      speed: shotSpeedOf(rec),
      life: rec.Count
    };
  }
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
      if (v > shot.speed) {
        shot.vx *= shot.speed / v;
        shot.vy *= shot.speed / v;
      }
    }
    shot.x += shot.vx;
    shot.y += shot.vy;
    return --shot.life > 0;
  }
  function applyDamage(st, rec) {
    const up = st.shields > 0;
    const dmg = Math.max(1, up ? rec.MassDmg / 4 + rec.EnergyDmg : rec.MassDmg + rec.EnergyDmg / 4);
    if (up) {
      st.shields = Math.max(0, st.shields - dmg);
      return "shielded";
    }
    st.armor -= dmg;
    if (st.armor <= 0) return "destroyed";
    if (st.armor <= st.armorMax * (st.disableFrac ?? 1 / 3)) return "disabled";
    return "hit";
  }
  function stepShields(st, shieldMax, shieldRe) {
    if (st.shields >= shieldMax || shieldRe <= 0) return;
    st.shieldT = (st.shieldT ?? 0) + 1;
    if (st.shieldT >= shieldRe) {
      st.shieldT = 0;
      st.shields = Math.min(shieldMax, st.shields + shieldMax / 100);
    }
  }
  function stepWarship(s, ex, ey) {
    const dist = Math.hypot(ex - s.x, ey - s.y);
    const aligned = steerToward(s, bearing(ex - s.x, ey - s.y));
    if (dist > 260 && aligned || dist < 120) thrust(s);
    integrate(s);
    return { aligned, dist };
  }
  function stepFlee(s, ex, ey) {
    const aligned = steerToward(s, norm(bearing(ex - s.x, ey - s.y) + 180));
    if (aligned) thrust(s);
    integrate(s);
  }
  return __toCommonJS(core_exports);
})();
globalThis.EV=EV;
