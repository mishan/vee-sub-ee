import { S, dudes, escorts, preloadSprites, ships, showMsg, spinOfShip } from './01-state.js';
import { attenuate, playSnd } from './03-sound.js';
import { armShip, player } from './04-combat.js';
import { refreshView } from './07-trade.js';
import { dudeShipPairs, govts } from './08-missions.js';
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
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
}
export function spawnAI(atEdge) {
  const pairsD = [];
  for (let i = 1; i <= 4; i++) {
    const d = S.syst['DudeTypes' + i], w = S.syst['Prob' + i];
    if (d >= 128 && dudes[d] && w > 0) pairsD.push([d, w]);
  }
  const dudeId = weighted(pairsD);
  if (dudeId == null) return;
  const pairsS = [];
  for (let j = 1; j <= 4; j++) {
    const s = dudes[dudeId]['ShipTypes' + j], w = dudes[dudeId]['Prob' + j];
    if (s >= 128 && ships[s] && w > 0) pairsS.push([s, w]);
  }
  const shipId = weighted(pairsS);
  if (shipId == null) return;
  const a = Math.random() * Math.PI * 2;
  const r = atEdge ? 2400 : 400 + Math.random() * 1200;
  const e = EV.makeShip(ships[shipId], Math.cos(a) * r, Math.sin(a) * r, Math.random() * 360);
  e.shipId = shipId;
  e.govt = dudes[dudeId].Govt;
  e.aiType = dudes[dudeId].AIType;
  e.booty = dudes[dudeId].Booty || 0; // what you can plunder when boarding (bible)
  e.target = S.spobs.length ? S.spobs[Math.floor(Math.random() * S.spobs.length)] : null;
  armShip(e, ships[shipId]);
  // hostility from govt flags (spec: "Hostility")
  const gf = e.govt >= 128 && DATA.types.govt[e.govt] && DATA.types.govt[e.govt].$sem
    ? DATA.types.govt[e.govt].$sem.flags : [];
  if ((gf.includes('alwaysAttacksPlayer') || gf.includes('xenophobic')) && e.aiType >= 3)
    e.hostile = true;
  // a warship of a govt you're a criminal with attacks on sight (spec)
  if (e.aiType >= 3 && isCriminalWith(e.govt)) e.hostile = true;
  // Warp-in: ships hyperspace into the system (a brief flash) rather than
  // popping into existence. Arrivals near the player get the warp sound.
  e.warpIn = 18;
  if (atEdge) playSnd(130, attenuate(e.x, e.y) * 0.7); // Warp Out (arrival boom)
  S.aiShips.push(e);
}

/* ---------------- player escorts (spec: "Escorts") ------------------- */

/* Spawn one live escort entity for a saved escort record, near the player. */
export function makeEscort(esc) {
  const rec = ships[esc.shipId];
  if (!rec) return null;
  const a = Math.random() * Math.PI * 2, r = 140 + Math.random() * 120;
  const e = EV.makeShip(rec, player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, player.heading);
  e.shipId = esc.shipId;
  e.govt = 0;                          // no affiliation: stays out of govt vendetta logic
  e.aiType = 3;                        // fights like a warship, but on your side
  e.playerEscort = true; e.escId = esc.id; e.misnName = esc.name;
  e.target = null; e.warpIn = 12;
  armShip(e, rec);
  preloadSprites([spinOfShip(esc.shipId)]);
  S.aiShips.push(e);
  return e;
}
/* Re-materialise the player's whole fleet on system entry / takeoff. */
export function spawnEscorts() { for (const esc of escorts) makeEscort(esc); }
/* Enlist a ship as a persistent escort (and, if in flight, spawn it now). */
export function addEscort(shipId, name) {
  const rec = ships[shipId];
  if (!rec) return null;                      // unknown hull (data/version mismatch) — skip
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
  if (!(w.have > 0)) { showMsg('Fighter bay is empty.'); return false; }
  const rec = ships[w.rec.AmmoType];
  if (!rec) return false;
  const ahead = EV.rad(player.heading);
  const e = EV.makeShip(rec, player.x + Math.sin(ahead) * 60, player.y - Math.cos(ahead) * 60, player.heading);
  e.shipId = w.rec.AmmoType;
  e.govt = 0; e.aiType = 3;
  e.playerEscort = true; e.fighter = true; e.bayWeapId = w.id;
  e.misnName = rec.name; e.target = null; e.warpIn = 8;
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
    const bay = player.weapons.find(w => w.id === s.bayWeapId && w.have < w.n)
             || player.weapons.find(w => w.rec.Guidance === 99 && w.rec.AmmoType === s.shipId && w.have < w.n);
    if (bay) bay.have++;                       // docks; if no bay has room the fighter just leaves
    S.aiShips.splice(S.aiShips.indexOf(s), 1);
    if (S.shipTarget === s) S.shipTarget = null;
    back++;
  }
  if (back) showMsg(`Recalled ${back} fighter${back > 1 ? 's' : ''}.`);
  else showMsg('No fighters deployed.');
}
export const fightersOut = () => S.aiShips.some(s => s.fighter && s.deathT < 0);

/* ---- escort-for-hire economics (spec: "Escorts for hire") ----
 * The bible describes the hire dialog but not the price, so the fee and the
 * per-jump upkeep are conventions (like the commodity multipliers): fractions
 * of the ship's Cost, flagged as approximations. */
export const MAX_ESCORTS = 6;                       // fleet cap (hired + captured)
export const HIRE_FEE_FRAC = 0.5, UPKEEP_FRAC = 0.01;
export const shipHasWeapon = r => [1, 2, 3, 4].some(i => r['WeapType' + i] >= 128);
export const hireFee = r => Math.max(1000, Math.round((r.Cost || 0) * HIRE_FEE_FRAC));
export const upkeepOf = r => Math.max(50, Math.round((r.Cost || 0) * UPKEEP_FRAC));
export const shipClassDesc = id => {
  const d = DATA.types.desc[2000 + (id - 128)];   // 2000-2063: ship class descriptions
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
  const r = ships[shipId]; if (!r) return;
  if (escorts.length >= MAX_ESCORTS) { showMsg('Your fleet is already full.'); return; }
  const fee = hireFee(r);
  if (S.credits < fee) { showMsg('You can’t afford the hiring fee.'); return; }
  S.credits -= fee;
  const esc = addEscort(shipId, r.name);     // landed ⇒ joins the fleet, spawns on takeoff
  esc.upkeep = upkeepOf(r);
  playSnd(150, 0.5);
  refreshView();
}
/* Let an escort go: drop it from the fleet (and remove any live entity). */
export function dismissEscort(id) {
  const i = escorts.findIndex(e => e.id === id); if (i < 0) return;
  escorts.splice(i, 1);
  const s = S.aiShips.find(x => x.escId === id);
  if (s) { const j = S.aiShips.indexOf(s); if (j >= 0) S.aiShips.splice(j, 1); }
  refreshView();
}
/* Pay the fleet's salaries at each hyperspace jump. Deducted in fleet order
 * (earliest-enlisted first); any escort whose salary you can't cover when its
 * turn comes quits on arrival. */
export function chargeEscortUpkeep() {
  let quit = 0;
  for (const e of [...escorts]) {
    if (!e.upkeep) continue;                  // captured ships draw no salary
    if (S.credits >= e.upkeep) { S.credits -= e.upkeep; continue; }
    const i = escorts.indexOf(e); if (i >= 0) escorts.splice(i, 1);
    const s = S.aiShips.find(x => x.escId === e.id);
    if (s) { const j = S.aiShips.indexOf(s); if (j >= 0) S.aiShips.splice(j, 1); }
    quit++;
  }
  if (quit) showMsg(quit === 1 ? 'An escort quit — you couldn’t make payroll.'
                               : `${quit} escorts quit — you couldn’t make payroll.`);
}

/* Bounty hunters (spec: "Bounty hunters"): when the player is a criminal in
 * the current system, that government sends warships after them. They
 * hyperspace in at the edge, hostile, named from STR# 10008. */
export function systemGovt() { return S.syst && S.syst.Govt >= 128 ? S.syst.Govt : 128; }
export function maybeSpawnBountyHunter() {
  if (S.landedAt || S.gameOver || player.deathT >= 0) return;
  const g = systemGovt();
  if (!isCriminalWith(g)) return;
  const present = S.aiShips.filter(s => s.bounty).length;
  // more evil → more hunters, capped; low per-frame chance
  const cap = Math.min(1 + Math.floor(-legalOf(g) / Math.max(govts[g].CrimeTol, 1) / 4), 4);
  if (present >= cap || Math.random() > 0.004) return;
  // hunters are warships: prefer a warship düde native to this system, then
  // any spöb's defense düde in-system, then any system düde.
  const warDudes = [];
  for (let i = 1; i <= 4; i++) {
    const dd = dudes[S.syst['DudeTypes' + i]];
    if (dd && dd.AIType >= 3) warDudes.push(dd);
  }
  const defDude = S.spobs.map(p => dudes[p.DefDude]).find(Boolean);
  const dude = warDudes[0] || defDude || dudes[S.syst.DudeTypes1];
  if (!dude) return;
  const shipId = weighted(dudeShipPairs(dude));
  if (shipId == null) return;
  const a = Math.random() * Math.PI * 2, r = 2200;
  const e = EV.makeShip(ships[shipId], player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, Math.random() * 360);
  e.shipId = shipId; e.govt = g; e.aiType = 3;
  e.booty = dude.Booty || 0;
  e.hostile = true; e.bounty = true; e.warpIn = 18;
  e.target = S.spobs.length ? S.spobs[Math.floor(Math.random() * S.spobs.length)] : null;
  armShip(e, ships[shipId]);
  const names = DATA.strings[10008] && DATA.strings[10008].list;
  e.misnName = names && names.length ? names[Math.floor(Math.random() * names.length)] : 'Bounty Hunter';
  playSnd(130, attenuate(e.x, e.y) * 0.6);
  S.aiShips.push(e);
  showMsg('A bounty hunter has jumped in!');
}

