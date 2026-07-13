/*
 * engine/shell/outfits.js — the pilot's outfit inventory (outf id → count).
 *
 * Owns the per-outfit counts and their invariants: a count never goes negative
 * and an outfit at zero is dropped from the inventory (add clamps and prunes), so
 * the "buy/sell → set-or-delete" dance that used to be duplicated at every call
 * site lives in one place. DOM/game-free, so it is unit-tested directly
 * (test/outfits.test.mjs). One of the focused state classes the S bag is being
 * broken into (docs/OOP_DESIGN.md, phase 5), alongside Wallet and Hold.
 */
export class Outfits {
  // `initial` is a plain {id: count} map (e.g. a pilot file's saved outfits). A
  // corrupt/negative/non-integer count coerces away, so a bad save can't poison
  // the inventory.
  constructor(initial = {}) {
    // Null-prototype: ids come from untrusted save data, so a good named e.g.
    // "toString" can't collide with an inherited Object.prototype member —
    // count/add operate on own keys only.
    this.counts = Object.create(null);
    for (const [id, n] of Object.entries(initial || {})) {
      const c = Math.floor(Number(n));
      if (Number.isFinite(c) && c > 0) this.counts[id] = c;
    }
  }

  count(id) {
    return this.counts[id] || 0;
  }

  has(id) {
    return this.count(id) > 0;
  }

  // Add `n` of outfit `id` (negative removes), clamped at 0; an outfit that hits
  // 0 is deleted. A non-finite/NaN `n` is a no-op. Returns the new count.
  add(id, n) {
    const d = Math.trunc(Number(n));
    if (!Number.isFinite(d)) return this.count(id);
    const after = Math.max(0, this.count(id) + d);
    if (after > 0) this.counts[id] = after;
    else delete this.counts[id];
    return after;
  }

  // [id, count] pairs (ids are strings, as from the save) — for iteration.
  entries() {
    return Object.entries(this.counts);
  }

  ids() {
    return Object.keys(this.counts);
  }

  // Discard the whole inventory (e.g. trading in the ship, or a captured hull).
  clear() {
    this.counts = Object.create(null);
  }

  // Plain {id: count} object for the pilot save file (the `outfits` field).
  toJSON() {
    return { ...this.counts };
  }
}
