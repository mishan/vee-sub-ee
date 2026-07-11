/*
 * engine/shell/13-legal.js — part of the browser flight shell (legal record).
 *
 * Extracted from 08-missions: the player's legal record per government and the
 * combat rating (spec: "Legal record"). esbuild bundles the shell modules
 * (entry: main.js). Normative behavior: engine/ENGINE_SPEC.md.
 */

import { S, reputation } from './01-state.js';
import { govts } from './08-missions.js';

/* ---- legal record & combat rating (spec: "Legal record") ---- */
// Player's legal record with a govt, defaulting to the govt's InitialRec.
export function legalOf(g) {
  if (g < 128) g = 128; // independent systems use govt 128
  if (reputation[g] != null) return reputation[g];
  return govts[g] ? govts[g].InitialRec : 0;
}
// STR# 134 status label, scaled by the govt's crime tolerance (bible App. II:
// enough good/evil to equal CrimeTol counts as 1 unit).
export const EVIL_STEPS = [
  [4096, 'Galactic Scourge'],
  [1024, 'Prime Evil'],
  [256, 'Public Enemy'],
  [64, 'Fugitive'],
  [16, 'Felon'],
  [4, 'Criminal'],
  [1, 'Offender'],
];
export const GOOD_STEPS = [
  [4096, 'Honored Leader'],
  [1024, 'Pillar of Society'],
  [256, 'Role Model'],
  [64, 'Upstanding Citizen'],
  [16, 'Good Egg'],
  [4, 'Decent Individual'],
];
export function legalStatus(g) {
  if (g < 128) g = 128;
  const rec = govts[g];
  if (!rec) return 'Clean';
  const v = legalOf(g) / Math.max(rec.CrimeTol, 1);
  if (v <= -1) for (const [t, label] of EVIL_STEPS) if (-v >= t) return label;
  if (v >= 4) for (const [t, label] of GOOD_STEPS) if (v >= t) return label;
  return 'Clean';
}
export function isCriminalWith(g) {
  // over the crime-tolerance threshold → warships attack
  if (g < 128) g = 128;
  const rec = govts[g];
  if (!rec) return false;
  return legalOf(g) <= -Math.max(rec.CrimeTol, 1);
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
    if (S.kills >= t) return DATA.strings[138].list[idx] || 'Harmless';
  return 'Harmless';
}

export function adjustRep(govt, amt) {
  if (govt < 0 || !amt) return;
  reputation[govt] = (reputation[govt] || 0) + amt;
}
