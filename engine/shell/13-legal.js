/*
 * engine/shell/13-legal.js — part of the browser flight shell (legal record).
 *
 * The player's legal record is **per system** (like classic EV): each system
 * has its own standing, so two systems under the same government can differ.
 * The status label / criminal test for a system scale that system's record by
 * its controlling government's CrimeTol. The combat rating (spec: "Legal
 * record") is separate — it's driven by total crew killed.
 *
 * esbuild bundles the shell modules (entry: main.js). Normative: ENGINE_SPEC.md.
 */

import { legal, S } from './01-state.js';
import { govts, govtAllies, govtEnemies } from './08-missions.js';

/* ---- legal record & combat rating (spec: "Legal record") ---- */
// The government that controls a system (independent systems use govt 128).
export function govtOf(systId) {
  const s = DATA.types.syst[systId];
  return s && s.Govt >= 128 ? s.Govt : 128;
}
// Player's legal record in a system, defaulting to the controlling govt's
// InitialRec until something has moved it.
export function legalOf(systId) {
  if (legal.has(systId)) return legal.raw(systId);
  const g = govtOf(systId);
  return govts[g] ? govts[g].InitialRec : 0;
}
// STR# 134 status label (bible App. II). The score is record ÷ that govt's
// CrimeTol; the ladder numbers are the UPPER bound of each tier, so a score
// anywhere in (0,4) reads "Decent Individual", [4,16) "Good Egg", and so on —
// any non-zero record already moves you off Clean. (The Bible lists these as if
// they were floors, but real pilots show otherwise: Confed record 9 / CrimeTol
// 50 = 0.18 is a "Decent Individual", Rebel record 365 / 75 = 4.87 a "Good Egg".)
export const GOOD_STEPS = [
  [4, 'Decent Individual'],
  [16, 'Good Egg'],
  [64, 'Upstanding Citizen'],
  [256, 'Role Model'],
  [1024, 'Pillar of Society'],
  [4096, 'Honored Leader'],
];
export const EVIL_STEPS = [
  [1, 'Offender'],
  [4, 'Criminal'],
  [16, 'Felon'],
  [64, 'Fugitive'],
  [256, 'Public Enemy'],
  [1024, 'Prime Evil'],
  [4096, 'Galactic Scourge'],
];
export function legalStatus(systId) {
  const rec = govts[govtOf(systId)];
  if (!rec) return 'Clean';
  const v = legalOf(systId) / Math.max(rec.CrimeTol, 1);
  const tier = (steps, m) => {
    for (const [t, label] of steps) if (m < t) return label;
    return steps[steps.length - 1][1]; // off the top of the ladder
  };
  if (v > 0) return tier(GOOD_STEPS, v);
  if (v < 0) return tier(EVIL_STEPS, -v);
  return 'Clean';
}
export function isCriminalWith(systId) {
  // record below the controlling govt's crime tolerance → warships attack
  const rec = govts[govtOf(systId)];
  if (!rec) return false;
  return legalOf(systId) <= -Math.max(rec.CrimeTol, 1);
}

/* ---- applying record changes (per-system) ----
 * Game effects are keyed by government (a killed ship's govt, a mission's
 * CompGovt), but the record is stored per system. Classic EV spreads the change
 * RANDOMLY across that government's systems: the current system always takes the
 * full signed hit, and every other related system has a per-event chance of
 * catching a reduced one. Reverse-engineered from repeated kills against real
 * pilots — the affected set has no geometric or topological logic (structurally
 * identical systems diverge) and no per-system data field distinguishes them, so
 * the only explanation is a roll (see ENGINE_SPEC "Legal record"). The sign
 * follows the relationship: on the govt's own or an allied system a good deed
 * helps and a crime hurts; on an enemy system it flips (harming a govt pleases
 * its foes); neutral systems don't notice. The spread constants are tuned for
 * feel, not measured (CLAUDE.md "Known approximations"). */
function relation(here, govt) {
  if (here === govt || govtAllies(govt).includes(here) || govtAllies(here).includes(govt)) return 1;
  if (govtEnemies(govt).includes(here) || govtEnemies(here).includes(govt)) return -1;
  // a xenophobic govt counts everyone not allied to it as an enemy (bible), so
  // hunting its ships (pirates) is lawful — the local govt credits you.
  const gf = govts[govt] && govts[govt].$sem ? govts[govt].$sem.flags : [];
  if (gf.includes('xenophobic')) return -1;
  return 0;
}
// Calibrated from a real before/after pilot diff (one crime spree against the
// Confederation reddened 26% of Confed systems and lifted 31% of the enemy
// Rebellion's), so ~1/4 of related systems get caught, at a reduced magnitude.
export const SPREAD_PROB = 0.25; // chance a related system is caught in the net
export const SPREAD_FRAC = 0.4; // fraction of the change those systems take
// `delta` is a change to your standing WITH `govt` (positive = improves it);
// crimes pass a negative delta. `rng` is injectable so the scatter is testable.
export function applyGovtDelta(govt, delta, rng = Math.random) {
  if (govt < 128 || !delta) return;
  const here = S.SYSTEM_ID;
  const bump = (sys, d) => {
    if (d) legal.set(sys, legalOf(sys) + d);
  };
  bump(here, relation(govtOf(here), govt) * delta); // current system: full hit
  const scatter = Math.round(delta * SPREAD_FRAC);
  if (!scatter) return;
  // for..in over the syst table (no fresh key array) — this runs on every
  // kill/disable/mission event, so keep it allocation-free.
  for (const id in DATA.types.syst) {
    if (!Object.hasOwn(DATA.types.syst, id)) continue;
    const sys = +id;
    if (sys === here) continue;
    const rel = relation(govtOf(sys), govt);
    if (rel && rng() < SPREAD_PROB) bump(sys, rel * scatter); // random spread
  }
}
// "Clean legal record with govt G": clear a criminal (negative) record in every
// system that govt controls.
export function pardonGovt(govt) {
  for (const id in DATA.types.syst) {
    if (!Object.hasOwn(DATA.types.syst, id)) continue;
    const systId = +id;
    if (govtOf(systId) === govt) legal.pardon(systId);
  }
}
// Combat rating from total crew destroyed (bible App. I / STR# 138).
export const RATING_STEPS = [
  [25600, 10],
  [12800, 9],
  [6400, 8],
  [3200, 7],
  [1600, 6],
  [800, 5],
  [400, 4],
  [200, 3],
  [100, 2],
  [1, 1],
  [0, 0],
];
export function combatRating() {
  for (const [t, idx] of RATING_STEPS)
    if (legal.kills >= t) return DATA.strings[138].list[idx] || 'Harmless';
  return 'Harmless';
}
