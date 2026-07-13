import {
  S,
  outfits,
  params,
  persGrudge,
  legal,
  ships,
  showMsg,
  spinOfShip,
  systs,
} from './01-state.js';
import {
  chargeEscortUpkeep,
  fightersOut,
  launchFighter,
  recallFighters,
  spawnEscorts,
} from './02-spawning.js';
import { attenuate, masterVol, playSnd, sndEl, stopSnd } from './03-sound.js';
import { checkExpiredMissions, govts, onMissionShipDisabled } from './08-missions.js';
import { PF } from './15-pers.js';
import { applyGovtDelta } from './13-legal.js';
import { loadSystem } from './09-step.js';

/*
 * engine/shell/04-combat.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- player ----------------
 * This player-state init leads the combat module (rather than living with the
 * rest of the game state in 01-state) purely to preserve top-level execution
 * order: it originally sat right before the audio section, and splitting sound
 * into its own module moved it here. It's referenced lazily everywhere else, so
 * the position is safe; it's grouped with combat only by adjacency. */

export const player = EV.makeShip(
  ships[S.playerShipId],
  +(params.get('x') || 0),
  +(params.get('y') || 300),
  +(params.get('heading') || 0),
);
player.shipId = S.playerShipId;
S.fuel = ships[S.playerShipId].Fuel;
export let fuelMax = ships[S.playerShipId].Fuel;
export let holds = ships[S.playerShipId].Holds;
S.landedAt = null;

/* ---- combat state (spec: "Combat") ---- */
export const weaps = DATA.types.weap;
S.shots = [];
S.beams = [];
S.explosions = [];
S.asteroids = []; // drifting rocks (spec: "Asteroids"); (re)filled by loadSystem
S.gameOver = false;

// ammo pool key for a weapon record (AmmoType 0-63 -> weapon 128+n's pool)
export const poolKey = (rec) =>
  rec.AmmoType >= 0 && rec.AmmoType <= 63 ? 128 + rec.AmmoType : null;

/* Give an entity combat stats + stock loadout from its shïp record. */
export function armShip(e, rec) {
  e.shieldMax = rec.Shield;
  e.shields = rec.Shield;
  e.armorMax = rec.Armor;
  e.armor = rec.Armor;
  e.shieldRe = rec.ShieldRe;
  e.mass = Math.max(rec.Mass, 1);
  e.deathDelay = rec.DeathDelay;
  // Only AI ships can be disabled and boarded; the player is destroyed
  // outright (no disabled limbo), so damage never returns 'disabled' for it.
  e.disableFrac = e === player ? 0 : rec.Flags & 0x0010 ? 0.1 : 1 / 3;
  e.deathT = -1;
  e.disabled = false;
  e.hostile = false;
  e.fleeing = false;
  e.weapons = [];
  e.pools = {};
  e.poolCap = {};
  for (let i = 1; i <= 4; i++) {
    const t = rec['WeapType' + i];
    if (t >= 128 && weaps[t]) {
      const w = { id: t, rec: weaps[t], n: Math.max(rec['WeapCount' + i], 1), cool: 0 };
      if (w.rec.Guidance === 99) w.have = w.n; // fighter bay: fighters docked
      e.weapons.push(w);
      const pk = poolKey(weaps[t]);
      if (pk) {
        e.pools[pk] = (e.pools[pk] || 0) + Math.max(rec['AmmoLoad' + i], 0);
        e.poolCap[pk] = (e.poolCap[pk] || 0) + Math.max(rec['AmmoLoad' + i], 0);
      }
    }
  }
  return e;
}

/* Player loadout = stock + outfitter weapons/ammo (rebuilt on refit). */
export function rebuildPlayerWeapons() {
  armShipKeepingCondition(player, effectiveShip());
  for (const [oid, n] of Object.entries(outfits)) {
    const o = DATA.types.outf[oid];
    if (!o || !n || !o.$sem) continue;
    if (o.$sem.modType === 'weapon' && weaps[o.ModVal]) {
      const existing = player.weapons.find((w) => w.id === o.ModVal);
      if (existing) existing.n += n;
      else player.weapons.push({ id: o.ModVal, rec: weaps[o.ModVal], n, cool: 0 });
    } else if (o.$sem.modType === 'ammunition' && weaps[o.ModVal]) {
      const pk = poolKey(weaps[o.ModVal]) ?? o.ModVal;
      player.pools[pk] = (player.pools[pk] || 0) + n;
      player.poolCap[pk] = (player.poolCap[pk] || 0) + (o.Max > 0 ? o.Max : n);
    }
  }
  // Fighter bays rearm to full capacity here (rebuild runs on landing, same as
  // the ammo-refill simplification) — every bay's docked count = its size.
  for (const w of player.weapons) if (w.rec.Guidance === 99) w.have = w.n;
  if (!player.weapons.some((w) => w === player.selSecondary))
    player.selSecondary = player.weapons.find((w) => w.rec.MiscFlags & 2) || null;
}
export function armShipKeepingCondition(e, s) {
  const frac = e.shieldMax ? e.shields / e.shieldMax : 1;
  const afrac = e.armorMax ? e.armor / e.armorMax : 1;
  armShip(e, { ...ships[S.playerShipId], Shield: s.rec.Shield, Armor: s.rec.Armor });
  e.shields = e.shieldMax * frac;
  e.armor = e.armorMax * afrac;
}

export const clampArc = (aim, base, arc) => {
  let d = EV.norm(aim - base);
  if (d > 180) d -= 360;
  return EV.norm(base + Math.max(-arc, Math.min(arc, d)));
};
export function leadAim(e, t, shotSpeed) {
  const dist = Math.hypot(t.x - e.x, t.y - e.y);
  const dt = shotSpeed > 0 ? dist / shotSpeed : 0;
  return EV.bearing(t.x + t.vx * dt - e.x, t.y + t.vy * dt - e.y);
}

export function fire(e, target, primary) {
  for (const w of e.weapons) {
    const sec = (w.rec.MiscFlags & 2) !== 0;
    if (primary ? sec : w !== e.selSecondary) continue;
    if (w.cool > 0) continue;
    const g = w.rec.Guidance;
    if (g === 99) {
      // fighter bay: launch a carried ship (player only)
      if (e === player && launchFighter(w)) {
        w.cool = w.rec.Reload;
        if (w.rec.Sound >= 0) playSnd(200 + w.rec.Sound, attenuate(e.x, e.y));
      }
      continue;
    }
    const pk = poolKey(w.rec);
    if (g === 0 || g === 3) {
      // beam
      if (pk && !((e.pools[pk] || 0) > 0)) continue;
      if (pk) e.pools[pk]--;
      S.beams.push({ owner: e, rec: w.rec, life: w.rec.Count, turreted: g === 3, target });
      w.cool = w.rec.Reload + w.rec.Count;
      if (w.rec.Sound >= 0) playSnd(200 + w.rec.Sound, attenuate(e.x, e.y));
      continue;
    }
    let fired = false;
    for (let i = 0; i < w.n; i++) {
      if (pk) {
        if ((e.pools[pk] || 0) < 1) break;
        e.pools[pk]--;
      }
      let aim = e.heading;
      if ((g === 1 || g === 2 || g === 4) && target)
        aim = leadAim(e, target, EV.shotSpeedOf(w.rec));
      if (g === 7 || g === 8) {
        const base = g === 7 ? e.heading : EV.norm(e.heading + 180);
        aim = target ? clampArc(leadAim(e, target, EV.shotSpeedOf(w.rec)), base, 45) : base;
      }
      aim = EV.norm(aim + (Math.random() * 2 - 1) * w.rec.Inaccuracy);
      const shot = EV.makeShot(w.rec, e, aim);
      shot.owner = e;
      shot.homing = g === 1 || g === 2 ? target : null;
      S.shots.push(shot);
      fired = true;
    }
    if (fired) {
      w.cool = w.rec.Reload;
      if (w.rec.Sound >= 0) playSnd(200 + w.rec.Sound, attenuate(e.x, e.y));
    }
  }
}

export function spawnExplosion(x, y, type) {
  const spin = 400 + Math.max(0, Math.min(type, 2));
  const meta = MANIFEST.spins[spin];
  if (meta) S.explosions.push({ x, y, spin, f: 0, frames: meta.frames, tick: 0 });
}
/* Begin a ship's destruction: the fireball plays immediately over the ship
 * as it breaks up (was flash-then-boom, which looked backwards). The ship
 * then fades out over deathDelay frames; big ships get a final blast. */
export function beginDestruction(v) {
  v.deathT = Math.max(v.deathDelay, 1);
  v.thrusting = false; // no engine flame on a hull that's breaking up
  spawnExplosion(v.x, v.y, v.deathDelay >= 60 ? 1 : 0);
  playSnd(302, attenuate(v.x, v.y)); // breaking up
}

export function grudge(victim, attacker) {
  // Friendly fire between AI ships (spec: "AI vs AI"): a ship damaged by another
  // AI turns on it — warships/brave traders fight the foe, wimpy traders flee it
  // — even against its own govt. The player's own side is immune: an escort's or
  // the player's fire never makes an AI take one of them as a foe.
  if (attacker !== player) {
    if (
      attacker &&
      attacker.aiType &&
      !attacker.playerEscort &&
      victim.aiType &&
      !victim.playerEscort &&
      attacker !== victim &&
      victim.deathT < 0
    ) {
      victim.foe = attacker;
      if (victim.aiType < 2) victim.fleeing = true; // wimpy → run from the attacker
    }
    return;
  }
  if (!victim.aiType) return;
  const react = (s) => {
    if (s.aiType >= 3 || s.aiType === 2) s.hostile = true;
    else s.fleeing = true;
  };
  react(victim);
  for (const s of S.aiShips) if (s.govt === victim.govt && s.govt >= 128) react(s);
  if (victim.isPers) {
    // a character you fired on won't deal with you
    victim.offered = true;
    if (victim.persFlags & PF.GRUDGE) persGrudge.add(victim.persId); // and remembers it
  }
}

export function hitShip(victim, rec, heading, attacker) {
  const result = EV.applyDamage(victim, rec);
  const kick = rec.Impact / (10 * victim.mass);
  victim.vx += Math.sin(EV.rad(heading)) * kick;
  victim.vy -= Math.cos(EV.rad(heading)) * kick;
  if (rec.ExplodType >= 0)
    playSnd(rec.ExplodType >= 1 ? 300 : 301, attenuate(victim.x, victim.y) * 0.8);
  if (result === 'destroyed' && victim.deathT < 0) {
    if (attacker === player) victim.killedByPlayer = true; // for legal credit on death
    beginDestruction(victim);
  } else if (result === 'disabled' && !victim.disabled) {
    victim.disabled = true;
    if (attacker === player) commitCrime(victim.govt, penaltyOf(victim.govt, 'DisabPenalty'));
    if (victim.misnId != null && attacker === player) onMissionShipDisabled(victim);
  }
  grudge(victim, attacker);
}

/* ---- legal consequences of combat (spec: "Legal record") ---- */
export const penaltyOf = (g, field) => (g >= 128 && govts[g] ? govts[g][field] : 0);
// A crime against govt g. applyGovtDelta lands it on the current system, signed
// by that system's relationship to g (crime on their/allied turf, a favour on
// an enemy's turf).
export function commitCrime(victimGovt, penalty) {
  applyGovtDelta(victimGovt, -penalty);
}
// A kill: adds to combat rating, then applies KillPenalty to the current
// system. The sign handles the rest — a crime against the victim govt on its
// own/allied turf, a credited bounty on an enemy's turf or against xenophobic
// pirates (relation() in 13-legal).
export function creditKill(victim) {
  legal.recordKill(ships[victim.shipId] && ships[victim.shipId].Crew);
  const g = victim.govt;
  if (g < 128) return;
  applyGovtDelta(g, -penaltyOf(g, 'KillPenalty'));
}

export function shipHalf(e) {
  const m = MANIFEST.spins[spinOfShip(e.shipId)];
  return m ? Math.max(m.frameW, m.frameH) / 2 : 16;
}

/* ---- outfits (spec-adjacent; oütf ModType effects from semantics.js) ----
 * outfits: outf id -> count. Effective ship stats = base shïp record plus
 * every owned outfit's effect; outfit Mass consumes the hull's FreeMass. */
export function effectiveShip() {
  const rec = { ...ships[S.playerShipId] };
  let h = rec.Holds,
    fm = rec.Fuel,
    massUsed = 0;
  for (const [id, n] of Object.entries(outfits)) {
    const o = DATA.types.outf[id];
    if (!o || !n) continue;
    massUsed += o.Mass * n;
    switch (o.$sem && o.$sem.modType) {
      case 'cargoSpace':
        h += o.ModVal * n;
        break;
      case 'fuelCapacity':
        fm += o.ModVal * n;
        break;
      case 'shieldCapacity':
        rec.Shield += o.ModVal * n;
        break;
      case 'armor':
        rec.Armor += o.ModVal * n;
        break;
      case 'accelBoost':
        rec.Accel += o.ModVal * n;
        break;
      case 'speedBoost':
        rec.Speed += o.ModVal * n;
        break;
      case 'turnBoost':
        rec.Maneuver += o.ModVal * n;
        break;
    }
  }
  return {
    rec,
    holds: h,
    fuelMax: fm,
    massUsed,
    freeMass: ships[S.playerShipId].FreeMass - massUsed,
  };
}
export function applyShipStats() {
  const s = effectiveShip();
  player.rec = s.rec;
  player.maxSpeed = EV.maxSpeedOf(s.rec);
  player.accel = EV.accelOf(s.rec);
  player.turn = EV.turnOf(s.rec);
  holds = s.holds;
  fuelMax = s.fuelMax;
  S.fuel = Math.min(S.fuel, fuelMax);
  rebuildPlayerWeapons(); // loadout + shield/armor maxes follow the refit
}

/* jump state: null | {destId, phase:'engage'|'streak', t} */
S.jump = null;
S.mapOpen = false;
S.jumpDest = null; // next hyperspace hop (armed from the map's route)
S.route = []; // planned multi-jump route (contiguous system ids ahead)

export function linkedSystems() {
  const out = [];
  for (let i = 1; i <= 16; i++) {
    const c = S.syst['Con' + i];
    if (c >= 128 && systs[c]) out.push(c);
  }
  return out;
}

export function mapBearingTo(destId) {
  const a = systs[S.SYSTEM_ID],
    b = systs[destId];
  return EV.bearing(b.xPos - a.xPos, b.yPos - a.yPos);
}

export function nearestSpobInfo() {
  let best = null,
    bd = Infinity;
  for (const p of S.spobs) {
    const d = Math.hypot(p.x - player.x, p.y - player.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return { spob: best, dist: bd };
}

/* Push the just-arrived player out beyond the hyperspace no-jump ring so a
 * chained route jump works the instant they arrive — ARRIVE_DIST alone lands
 * inside the ring. Nudge straight away from the nearest object, iterating so a
 * crowded system still settles clear of *every* object. */
export function clearArrivalOfSpobs() {
  const need = EV.JUMP_MIN_DIST + 200; // ring + a buffer to press J right away
  for (let i = 0; i < 40; i++) {
    const n = nearestSpobInfo();
    if (!n.spob || n.dist >= need) break;
    const dx = player.x - n.spob.x,
      dy = player.y - n.spob.y;
    const d = Math.hypot(dx, dy) || 1;
    const push = need - n.dist;
    player.x += (dx / d) * push;
    player.y += (dy / d) * push;
  }
}
export let warpSnd = null;
export function beginJump() {
  if (S.jump || S.landedAt) return;
  if (S.jumpDest == null || !linkedSystems().includes(S.jumpDest)) return;
  if (S.fuel < EV.JUMP_FUEL) {
    showMsg('Not enough fuel to jump.');
    return;
  }
  const near = nearestSpobInfo();
  if (near.spob && near.dist < EV.JUMP_MIN_DIST) {
    showMsg(`You are too close to ${near.spob.name} to engage your hyperdrive.`);
    return;
  }
  S.jump = { destId: S.jumpDest, phase: 'engage', t: 0 };
  // Warp Up (8.3s spin-up) — kept as a handle so it can be cut on abort;
  // routed through masterVol like every other sound, and adjustable live.
  if (S.soundOn && masterVol > 0) {
    warpSnd = sndEl(128).cloneNode();
    warpSnd._baseVol = 1;
    warpSnd.volume = Math.min(masterVol, 1);
    warpSnd.play().catch(() => {});
  } else warpSnd = null;
}
export function abortJump() {
  S.jump = null;
  stopSnd(warpSnd);
  warpSnd = null;
}
export function completeJump() {
  const from = S.SYSTEM_ID;
  S.gameDay++; // a day passes each hyperspace jump (spec)
  if (fightersOut()) recallFighters(); // fighters dock before the carrier jumps out
  loadSystem(S.jump.destId);
  // placeAtArrival wants the inbound bearing (origin → dest); from the
  // destination, mapBearingTo(origin) is the reverse bearing, so flip it.
  EV.placeAtArrival(player, EV.norm(mapBearingTo(from) + 180));
  clearArrivalOfSpobs(); // materialise beyond the no-jump ring (chain-jump ready)
  spawnEscorts(); // fleet jumps in around the now-placed player
  S.fuel -= EV.JUMP_FUEL;
  S.jump = null;
  // Advance a planned route one hop at a time: if we just arrived at the next
  // waypoint, drop it and arm the following one (press J to take it); else clear.
  if (S.route && S.route.length && S.route[0] === S.SYSTEM_ID) S.route.shift();
  S.jumpDest = S.route && S.route.length ? S.route[0] : null;
  checkExpiredMissions();
  chargeEscortUpkeep(); // pay the fleet's salaries; the unpaid quit here
  warpSnd = null; // Warp Up ends naturally as the streak completes
  playSnd(130); // Warp Out
}
