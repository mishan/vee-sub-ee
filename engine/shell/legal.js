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
export class LegalRecord {
  constructor(records = {}, kills = 0) {
    this.records = records; // govtId -> stored record; unset ⇒ caller uses the govt's InitialRec
    this.kills = kills; // total crew destroyed → combat rating
  }

  // Whether a record has been stored for a govt (vs. still at its default).
  has(govt) {
    return this.records[govt] != null;
  }
  raw(govt) {
    return this.records[govt];
  }

  // Store an absolute record. Callers that adjust the *effective* record (which
  // may still be at the govt default) compute the new value via legalOf and set
  // the result — see commitCrime/creditKill.
  set(govt, value) {
    this.records[govt] = value;
  }

  // Bump the record with a govt from a 0 baseline (mission rewards/penalties).
  adjust(govt, amt) {
    if (govt < 0 || !amt) return;
    this.records[govt] = (this.records[govt] || 0) + amt;
  }

  // Clear a criminal (negative) record with a govt back to clean; leave a good
  // record alone.
  pardon(govt) {
    this.records[govt] = Math.max(0, this.records[govt] || 0);
  }

  // Record a kill of `crew` (counted as at least 1) toward the combat rating.
  recordKill(crew) {
    this.kills += Math.max(1, crew || 1);
  }
}
