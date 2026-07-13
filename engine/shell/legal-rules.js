/*
 * engine/shell/legal-rules.js — the pure legal-record spread logic, lifted out
 * of 13-legal.js.
 *
 * The player's legal record is stored per system, but game effects are keyed by
 * government. Classic EV scatters a standing change randomly across that govt's
 * systems: the current system always takes the full signed hit, and every other
 * related system has a per-event chance of catching a reduced one. The sign
 * follows the relationship (own/allied systems move with the govt, enemy systems
 * flip, neutral ones ignore it). This module holds that policy as DOM-free
 * functions taking plain data + a govt-relations interface, so it imports in node
 * and is unit-tested directly (test/legal-rules.test.mjs). 13-legal.js keeps a
 * thin `applyGovtDelta` wrapper that reads the live syst table / legal store and
 * feeds this. See ENGINE_SPEC "Legal record" and CLAUDE.md "Known
 * approximations" (the spread constants are tuned, not measured).
 *
 * `rel` is the same govt-relations interface ai-targeting uses:
 *   allies(g) -> ally govt ids, enemies(g) -> enemy govt ids,
 *   flags(g)  -> govt flag names (e.g. 'xenophobic').
 */

/* Sign of how a change to your standing WITH `govt` lands on a system controlled
 * by govt `here`: +1 on the govt's own or an allied system (a good deed helps, a
 * crime hurts), −1 on an enemy system (harming a govt pleases its foes), 0 on a
 * neutral one. A xenophobic govt treats every non-ally as an enemy, so hunting
 * its ships (e.g. pirates) is lawful — read in both directions, like the combat
 * AI's aiEnemies, so the two sides can't disagree. */
export function relation(here, govt, rel) {
  if (here === govt || rel.allies(govt).includes(here) || rel.allies(here).includes(govt)) return 1;
  if (rel.enemies(govt).includes(here) || rel.enemies(here).includes(govt)) return -1;
  if (rel.flags(govt).includes('xenophobic')) return -1;
  return 0;
}

/* Apply a standing change `delta` with `govt` (positive improves your standing;
 * crimes pass a negative delta) by calling `bump(systemId, amount)` for each
 * affected system: the current system takes the full signed hit, then every
 * other related system has a `prob` chance of catching `round(delta * frac)`,
 * signed by its relation. No-ops for a civilian govt (<128) or a zero delta.
 *
 * Kept allocation-free (it runs on every kill/disable/mission event): the caller
 * passes `forEachSystem(fn)` which invokes `fn(systemId, controllingGovt)` with
 * primitives, and `bump`/`rng` as plain callbacks — nothing here builds a list.
 * `ctx`: { here, hereGovt, forEachSystem, rel, prob, frac, rng, bump }. */
export function spreadGovtDelta(govt, delta, ctx) {
  const { here, hereGovt, forEachSystem, rel, prob, frac, rng, bump } = ctx;
  if (govt < 128 || !delta) return;
  bump(here, relation(hereGovt, govt, rel) * delta); // current system: full hit
  const scatter = Math.round(delta * frac);
  if (!scatter) return;
  forEachSystem((sysId, sysGovt) => {
    if (sysId === here) return;
    const r = relation(sysGovt, govt, rel);
    if (r && rng() < prob) bump(sysId, r * scatter); // random, reduced spread
  });
}
