import { wallet, S, dudes, escorts, ships, showMsg, spinOfShip } from './01-state.js';
import { preloadSprites } from './ui/sprites.js';
import { attenuate, playSnd } from './03-sound.js';
import { armShip, player } from './04-combat.js';
import { refreshView } from './ui/dialog.js';
import { dudeShipPairs, govtAllies, govts } from './08-missions.js';
import { isCriminalWith, legalOf } from './13-legal.js';
import { introUp } from './11-title.js';

/*
 * engine/shell/02-spawning.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- AI spawning (shell; see spec "Spawning") ------------- */

export function weighted(pairs) {
  if (!pairs.length) return null;
  let r = Math.random() * pairs.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of pairs) {
    if ((r -= w) <= 0) return v;
  }
  return pairs[0][0];
}

/* Arrive from hyperspace like the player does (spec: "Warp-in"): enter moving
 * fast toward the interior point (tx,ty) and let the step loop decelerate the
 * ship down to its sub-light top speed. Replaces the old pop-in ring — the ship
 * comes in from off-screen and slows, the way ships and the player do in the
 * original. */
export function warpIntoSystem(e, tx = 0, ty = 0) {
  const dx = tx - e.x,
    dy = ty - e.y;
  const len = Math.hypot(dx, dy) || 1;
  const entry = e.maxSpeed * 4; // hyperspace exit speed; coasts down to maxSpeed
  e.vx = (dx / len) * entry;
  e.vy = (dy / len) * entry;
  e.heading = EV.bearing(dx, dy);
  e.warpIn = 60; // safety cap; the coast ends as soon as it drops sub-light
  playSnd(130, attenuate(e.x, e.y) * 0.7); // Warp In boom (faint when far off)
}
// A "port": an inhabited, landable spöb — the only place an ambient trader
// stops (mirrors ui/map.js's port definition). `portsHere()` is the current
// system's ports; a system with none is a fly-through (traders head straight
// back out — see TraderAI).
export const isPort = (p) => !!(p && p.$sem && p.$sem.canLand && !p.$sem.uninhabited);
export const portsHere = () => S.spobs.filter(isPort);

/* Populate S.asteroids for the current system (spec: "Asteroids"). The syst
 * `Asteroids` field is a *density level* (0 = none, 2–10 = light→heavy), not a
 * count: a light field still has many rocks. We scatter that many around the
 * player within ±BOUND; the per-frame wrap (core Asteroid.step) then keeps the
 * field centred on the player as they fly. Ambient scenery, regenerated per visit
 * and never saved. */
export function spawnAsteroids() {
  S.asteroids = [];
  const density = S.syst && S.syst.Asteroids > 0 ? S.syst.Asteroids : 0;
  if (!density) return;
  const n = 4 + density * 2; // level 2 (light) ≈ 8, level 10 (heavy) ≈ 24
  const B = EV.ASTEROID_BOUND;
  const cx = player.x || 0,
    cy = player.y || 0;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = rand(0.2, 0.6); // drift, px/frame
    S.asteroids.push(
      new EV.Asteroid(
        cx + rand(-B, B),
        cy + rand(-B, B),
        Math.cos(ang) * spd,
        Math.sin(ang) * spd,
        Math.floor(Math.random() * 2), // size 0 small / 1 big (EV spïn 800 / 801)
        rand(-0.8, 0.8), // spin, deg/frame
      ),
    );
  }
}

export function spawnAI(atEdge) {
  const pairsD = [];
  for (let i = 1; i <= 4; i++) {
    const d = S.syst['DudeTypes' + i],
      w = S.syst['Prob' + i];
    if (d >= 128 && dudes[d] && w > 0) pairsD.push([d, w]);
  }
  const dudeId = weighted(pairsD);
  if (dudeId == null) return;
  const pairsS = [];
  for (let j = 1; j <= 4; j++) {
    const s = dudes[dudeId]['ShipTypes' + j],
      w = dudes[dudeId]['Prob' + j];
    if (s >= 128 && ships[s] && w > 0) pairsS.push([s, w]);
  }
  const shipId = weighted(pairsS);
  if (shipId == null) return;
  const a = Math.random() * Math.PI * 2;
  // Arrivals appear just off-screen and warp in; the ambient population that's
  // already here when you enter is scattered in-system.
  const r = atEdge ? 1000 + Math.random() * 500 : 400 + Math.random() * 1200;
  const ex = Math.cos(a) * r,
    ey = Math.sin(a) * r;
  const e = new EV.Ship(ships[shipId], ex, ey, Math.random() * 360);
  e.shipId = shipId;
  e.govt = dudes[dudeId].Govt;
  e.aiType = dudes[dudeId].AIType;
  e.booty = dudes[dudeId].Booty || 0; // what you can plunder when boarding (bible)
  // Ambient traders head for a port to visit; a port-less system leaves the
  // target null → TraderAI sends them straight back out.
  const ports = portsHere();
  e.target = ports.length ? ports[Math.floor(Math.random() * ports.length)] : null;
  armShip(e, ships[shipId]);
  // hostility from govt flags (spec: "Hostility")
  const gf =
    e.govt >= 128 && DATA.types.govt[e.govt] && DATA.types.govt[e.govt].$sem
      ? DATA.types.govt[e.govt].$sem.flags
      : [];
  if ((gf.includes('alwaysAttacksPlayer') || gf.includes('xenophobic')) && e.aiType >= 3)
    e.hostile = true;
  // a warship attacks on sight if you're a criminal in THIS system and its govt
  // enforces here — the local government, an ally, or a "laws everywhere" govt
  if (e.aiType >= 3 && enforcesHere(e.govt)) e.hostile = true;
  // Arrivals warp in from off-screen at speed and decelerate; the already-present
  // ambient population is just there (no warp-in).
  if (atEdge) warpIntoSystem(e, 0, 0);
  S.aiShips.push(e);
}

/* ---------------- player escorts (spec: "Escorts") ------------------- */

/* Spawn one live escort entity for a saved escort record, near the player. */
export function makeEscort(esc) {
  const rec = ships[esc.shipId];
  if (!rec) return null;
  const a = Math.random() * Math.PI * 2,
    r = 140 + Math.random() * 120;
  const e = new EV.Ship(
    rec,
    player.x + Math.cos(a) * r,
    player.y + Math.sin(a) * r,
    player.heading,
  );
  e.shipId = esc.shipId;
  e.govt = 0; // no affiliation: stays out of govt vendetta logic
  e.aiType = 3; // fights like a warship, but on your side
  e.playerEscort = true;
  e.escId = esc.id;
  e.misnName = esc.name;
  e.target = null;
  // Escorts warp with the player and arrive at the same instant: they inherit
  // the player's velocity, so on a jump-in they exit hyperspace moving together
  // (and on takeoff, when the player is stationary, they launch stationary too).
  e.vx = player.vx;
  e.vy = player.vy;
  e.warpIn = 0;
  armShip(e, rec);
  preloadSprites([spinOfShip(esc.shipId)]);
  S.aiShips.push(e);
  return e;
}
/* Re-materialise the player's whole fleet on system entry / takeoff. */
export function spawnEscorts() {
  for (const esc of escorts) makeEscort(esc);
}
/* Enlist a ship as a persistent escort (and, if in flight, spawn it now). */
export function addEscort(shipId, name) {
  const rec = ships[shipId];
  if (!rec) return null; // unknown hull (data/version mismatch) — skip
  const esc = { id: S.escNextId++, shipId, name: name || rec.name };
  escorts.push(esc);
  if (!introUp() && !S.landedAt) makeEscort(esc);
  return esc;
}

/* ---------------- fighter bays (spec: "Fighter bays") ----------------
 * A Guidance-99 weapon launches a carried ship (AmmoType = its class ID) that
 * fights as a player-allied escort. Reuses the escort AI + friendly-fire
 * immunity; fighters are transient (tied to bay ammo, not the saved fleet). */
export function launchFighter(w) {
  if (!(w.have > 0)) {
    showMsg('Fighter bay is empty.');
    return false;
  }
  const rec = ships[w.rec.AmmoType];
  if (!rec) return false;
  const ahead = EV.rad(player.heading);
  const e = new EV.Ship(
    rec,
    player.x + Math.sin(ahead) * 60,
    player.y - Math.cos(ahead) * 60,
    player.heading,
  );
  e.shipId = w.rec.AmmoType;
  e.govt = 0;
  e.aiType = 3;
  e.playerEscort = true;
  e.fighter = true;
  e.bayWeapId = w.id;
  e.misnName = rec.name;
  e.target = null;
  // Fighters launch from the carrier, matching its motion (no warp-in).
  e.vx = player.vx;
  e.vy = player.vy;
  e.warpIn = 0;
  armShip(e, rec);
  preloadSprites([spinOfShip(e.shipId)]);
  S.aiShips.push(e);
  w.have--;
  return true;
}
/* Recall living fighters: each returns to a bay of its type, restoring ammo. */
export function recallFighters() {
  let back = 0;
  for (const s of [...S.aiShips]) {
    if (!s.fighter || s.deathT >= 0) continue;
    const bay =
      player.weapons.find((w) => w.id === s.bayWeapId && w.have < w.n) ||
      player.weapons.find(
        (w) => w.rec.Guidance === 99 && w.rec.AmmoType === s.shipId && w.have < w.n,
      );
    if (bay) bay.have++; // docks; if no bay has room the fighter just leaves
    S.aiShips.splice(S.aiShips.indexOf(s), 1);
    if (S.shipTarget === s) S.shipTarget = null;
    back++;
  }
  if (back) showMsg(`Recalled ${back} fighter${back > 1 ? 's' : ''}.`);
  else showMsg('No fighters deployed.');
}
export const fightersOut = () => S.aiShips.some((s) => s.fighter && s.deathT < 0);

/* ---- escort-for-hire economics (spec: "Escorts for hire") ----
 * The bible describes the hire dialog but not the price, so the fee and the
 * per-jump upkeep are conventions (like the commodity multipliers): fractions
 * of the ship's Cost, flagged as approximations. */
export const MAX_ESCORTS = 6; // fleet cap (hired + captured)
export const HIRE_FEE_FRAC = 0.5,
  UPKEEP_FRAC = 0.01;
export const shipHasWeapon = (r) => [1, 2, 3, 4].some((i) => r['WeapType' + i] >= 128);
export const hireFee = (r) => Math.max(1000, Math.round((r.Cost || 0) * HIRE_FEE_FRAC));
export const upkeepOf = (r) => Math.max(50, Math.round((r.Cost || 0) * UPKEEP_FRAC));
export const shipClassDesc = (id) => {
  const d = DATA.types.desc[2000 + (id - 128)]; // 2000-2063: ship class descriptions
  return d && d.Description ? d.Description : '';
};
/* A small, fixed roster available at every bar: the cheapest armed, non-
 * mission-locked, purchasable hulls make sensible entry-level escorts.
 * Cost > 0 filters out carried-fighter classes (bay ammo, priced at 0),
 * which aren't standalone ships you'd hire. Computed once. */
export const HIRE_ROSTER = Object.entries(ships)
  .filter(([, r]) => r.MissionBit < 0 && r.Cost > 0 && shipHasWeapon(r))
  .sort((a, b) => a[1].Cost - b[1].Cost)
  .slice(0, 4)
  .map(([id]) => +id);

/* Hire a pilot: pay the fee, add a persistent escort carrying its upkeep. */
export function hireEscort(shipId) {
  const r = ships[shipId];
  if (!r) return;
  if (escorts.length >= MAX_ESCORTS) {
    showMsg('Your fleet is already full.');
    return;
  }
  const fee = hireFee(r);
  if (!wallet.canAfford(fee)) {
    showMsg('You can’t afford the hiring fee.');
    return;
  }
  wallet.spend(fee);
  const esc = addEscort(shipId, r.name); // landed ⇒ joins the fleet, spawns on takeoff
  esc.upkeep = upkeepOf(r);
  playSnd(150, 0.5);
  refreshView();
}
/* Let an escort go: drop it from the fleet (and remove any live entity). */
export function dismissEscort(id) {
  const i = escorts.findIndex((e) => e.id === id);
  if (i < 0) return;
  escorts.splice(i, 1);
  const s = S.aiShips.find((x) => x.escId === id);
  if (s) {
    const j = S.aiShips.indexOf(s);
    if (j >= 0) S.aiShips.splice(j, 1);
  }
  refreshView();
}
/* Pay the fleet's salaries at each hyperspace jump. Deducted in fleet order
 * (earliest-enlisted first); any escort whose salary you can't cover when its
 * turn comes quits on arrival. */
export function chargeEscortUpkeep() {
  let quit = 0;
  for (const e of [...escorts]) {
    if (!e.upkeep) continue; // captured ships draw no salary
    if (wallet.canAfford(e.upkeep)) {
      wallet.spend(e.upkeep);
      continue;
    }
    const i = escorts.indexOf(e);
    if (i >= 0) escorts.splice(i, 1);
    const s = S.aiShips.find((x) => x.escId === e.id);
    if (s) {
      const j = S.aiShips.indexOf(s);
      if (j >= 0) S.aiShips.splice(j, 1);
    }
    quit++;
  }
  if (quit)
    showMsg(
      quit === 1
        ? 'An escort quit — you couldn’t make payroll.'
        : `${quit} escorts quit — you couldn’t make payroll.`,
    );
}

/* Bounty hunters (spec: "Bounty hunters"): when the player is a criminal in
 * the current system, that government sends warships after them. They
 * hyperspace in at the edge, hostile, named from STR# 10008. */
export function systemGovt() {
  return S.syst && S.syst.Govt >= 128 ? S.syst.Govt : 128;
}
// Does govt `g` police the CURRENT system for your crimes here? True when you're
// a criminal in this system and g is its government, an ally of it, or a govt
// that enforces its laws everywhere (flag 0x0002).
function enforcesHere(g) {
  if (g < 128 || !isCriminalWith(S.SYSTEM_ID)) return false;
  const sg = systemGovt();
  if (g === sg || govtAllies(sg).includes(g) || govtAllies(g).includes(sg)) return true;
  const gf = DATA.types.govt[g] && DATA.types.govt[g].$sem ? DATA.types.govt[g].$sem.flags : [];
  return gf.includes('enforcesLawsEverywhere');
}
export function maybeSpawnBountyHunter() {
  if (S.landedAt || S.gameOver || player.deathT >= 0) return;
  const g = systemGovt();
  if (!isCriminalWith(S.SYSTEM_ID)) return;
  const present = S.aiShips.filter((s) => s.bounty).length;
  // more evil → more hunters, capped; low per-frame chance
  const cap = Math.min(
    1 + Math.floor(-legalOf(S.SYSTEM_ID) / Math.max(govts[g].CrimeTol, 1) / 4),
    4,
  );
  if (present >= cap || Math.random() > 0.004) return;
  // hunters are warships: prefer a warship düde native to this system, then
  // any spöb's defense düde in-system, then any system düde.
  const warDudes = [];
  for (let i = 1; i <= 4; i++) {
    const dd = dudes[S.syst['DudeTypes' + i]];
    if (dd && dd.AIType >= 3) warDudes.push(dd);
  }
  const defDude = S.spobs.map((p) => dudes[p.DefDude]).find(Boolean);
  const dude = warDudes[0] || defDude || dudes[S.syst.DudeTypes1];
  if (!dude) return;
  const shipId = weighted(dudeShipPairs(dude));
  if (shipId == null) return;
  const a = Math.random() * Math.PI * 2,
    r = 2200;
  const e = new EV.Ship(
    ships[shipId],
    player.x + Math.cos(a) * r,
    player.y + Math.sin(a) * r,
    Math.random() * 360,
  );
  e.shipId = shipId;
  e.govt = g;
  e.aiType = 3;
  e.booty = dude.Booty || 0;
  e.hostile = true;
  e.bounty = true;
  e.target = S.spobs.length ? S.spobs[Math.floor(Math.random() * S.spobs.length)] : null;
  armShip(e, ships[shipId]);
  const names = DATA.strings[10008] && DATA.strings[10008].list;
  e.misnName =
    names && names.length ? names[Math.floor(Math.random() * names.length)] : 'Bounty Hunter';
  // A bounty hunter hyperspaces in after you, bearing down from off-screen.
  warpIntoSystem(e, player.x, player.y);
  S.aiShips.push(e);
  showMsg('A bounty hunter has jumped in!');
}
