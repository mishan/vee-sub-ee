/*
 * engine/shell/legal.js — the pilot's legal record and combat tally.
 *
 * Holds the mutable state behind the "Legal record" spec: per-government record
 * values and the running total of crew destroyed (which drives the combat
 * rating). The guarded mutations live here; the *queries* that need government
 * data — legalOf, legalStatus, isCriminalWith, combatRating — stay in
 * 13-legal.js, which reads this record plus the govt table.
 *
 * DOM/game-free, so it is unit-tested directly (test/legal.test.mjs). One of the
 * focused state classes the S bag is being broken into (docs/OOP_DESIGN.md,
 * phase 5).
 */
// Coerce a possibly-corrupt saved/passed value to a finite number, else fall
// back. Keeps arithmetic numeric so a bad pilot file can't turn `+=` into string
// concatenation or NaN.
function num(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export class LegalRecord {
  constructor(records = {}, kills = 0) {
    // Copy into a null-prototype map so keys from a save file (e.g. __proto__,
    // constructor) can't reach the prototype chain and lookups never observe
    // inherited properties — and coerce every value to a finite number, so
    // downstream arithmetic (e.g. legalOf(g) + kp in creditKill) can never
    // string-concatenate on a corrupt/hand-edited pilot file.
    this.records = Object.create(null); // govtId -> stored record
    for (const [g, v] of Object.entries(records)) this.records[g] = num(v);
    this.kills = Math.max(0, num(kills)); // total crew destroyed → combat rating
  }

  // Whether a record has been stored for a govt (vs. still at its default).
  has(govt) {
    return Object.hasOwn(this.records, govt) && this.records[govt] != null;
  }
  raw(govt) {
    return Object.hasOwn(this.records, govt) ? this.records[govt] : undefined;
  }

  // Store an absolute record. Callers that adjust the *effective* record (which
  // may still be at the govt default) compute the new value via legalOf and set
  // the result — see commitCrime/creditKill. The value is coerced numeric so the
  // class keeps its arithmetic invariants; govts are always >= 128.
  set(govt, value) {
    if (govt < 0) return;
    this.records[govt] = num(value);
  }

  // Bump the record with a govt from a 0 baseline (mission rewards/penalties).
  // The delta and the stored value are coerced numeric; a zero/invalid delta
  // is a no-op.
  adjust(govt, amt) {
    const delta = num(amt);
    if (govt < 0 || delta === 0) return;
    this.records[govt] = num(this.records[govt]) + delta;
  }

  // Clear a criminal (negative) record with a govt back to clean. Only touches an
  // existing negative record: a govt still at its default is left alone, so we
  // don't create a spurious 0 that overrides its InitialRec and bloats the save.
  pardon(govt) {
    if (this.has(govt) && this.raw(govt) < 0) this.records[govt] = 0;
  }

  // Record a kill of `crew` (counted as at least 1) toward the combat rating.
  recordKill(crew) {
    this.kills += Math.max(1, num(crew, 0));
  }
}
