/*
 * engine/shell/ai-targeting.js — the pure decision logic the combat AI uses to
 * pick who to fight, lifted out of 09-step.js.
 *
 * These take the acting ship, a plain array of candidate ships, and small
 * plain-data context (a govt-relations interface, the engage range) — no
 * ambient `DATA`/`document`/`EV` global, no `S`, no live `world`. So the module
 * imports in Node and the targeting rules are unit-tested directly
 * (test/ai-targeting.test.mjs) — the last item in OOP_DESIGN.md's "Testability —
 * next". 09-step.js keeps thin wrappers that read the live world/govt tables and
 * pass the plain data in, so behavior is unchanged.
 *
 * A "ship" here is any object with {x, y, govt, deathT, disabled, playerEscort,
 * misnId, isPers, hostile} — the fields these rules read; the flight core's Ship
 * has them, and tests use plain literals.
 */

/* Nearest candidate to `self` for which `eligible(o)` is true, or null. `self`
 * is skipped. Distance is straight-line; ties go to the earlier candidate. */
export function nearest(self, candidates, eligible) {
  let best = null,
    bd = Infinity;
  for (const o of candidates) {
    if (o === self || !eligible(o)) continue;
    const d = Math.hypot(o.x - self.x, o.y - self.y);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

/* Govt hostility between two ships (spec: "AI vs AI"): should govt `sg` attack
 * govt `og` on sight? `rel` is a govt-relations interface:
 *   allies(g)  -> array of ally govt ids,
 *   enemies(g) -> array of enemy govt ids,
 *   flags(g)   -> array of govt flag names (e.g. 'xenophobic').
 * Ally/Enemy are read in both directions (like legal `relation()` in 13-legal),
 * so the two sides can't disagree. Same govt or allies never fight; a declared
 * enemy always does; otherwise only a xenophobic govt attacks a stranger. */
export function aiEnemies(sg, og, rel) {
  if (sg < 128 || og < 128 || sg === og) return false;
  if (rel.allies(sg).includes(og) || rel.allies(og).includes(sg)) return false;
  if (rel.enemies(sg).includes(og) || rel.enemies(og).includes(sg)) return true;
  return rel.flags(sg).includes('xenophobic');
}

/* The ship a combat AI should fight this frame, or null: the nearest of the
 * player (only when `player` is passed non-null AND `self.hostile`), a `foe`
 * that has damaged it (at any range), and — for an ambient warship (`hunts`) —
 * the nearest govt-enemy within `engageRange`. Mission and pers ships and the
 * player's escorts are never ambient-targeted. `ctx`:
 *   player      — the player ship, or null when it isn't targetable
 *                 (dead / game over / landed) — the caller folds those in,
 *   foe         — the resolved foe ship, or null,
 *   hunts       — whether this ship hunts govt-enemies (ambient warship),
 *   rel         — govt-relations interface (see aiEnemies),
 *   engageRange — how close a govt-enemy must be to be hunted. */
export function combatTarget(self, candidates, ctx) {
  const { player, foe, hunts, rel, engageRange } = ctx;
  const dist = (o) => Math.hypot(o.x - self.x, o.y - self.y);
  // The player is the first candidate (only if hostile to this ship and
  // targetable); ships must beat its distance strictly, so a tie keeps the player.
  let best = self.hostile && player ? player : null;
  let bd = best ? dist(player) : Infinity;
  for (const o of candidates) {
    if (o === self || o.deathT >= 0 || o.disabled || o.playerEscort) continue;
    let elig = o === foe;
    if (!elig && hunts && o.misnId == null && !o.isPers && aiEnemies(self.govt, o.govt, rel))
      elig = dist(o) <= engageRange;
    if (!elig) continue;
    const d = dist(o);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}
