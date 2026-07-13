/*
 * engine/shell/hold.js — the pilot's cargo hold (tons of each commodity).
 *
 * Owns the per-commodity quantities and the invariants around them: quantities
 * never go negative (adjust clamps at 0), and clampTo dumps overflow when the
 * hold is downsized. Capacity itself is a ship stat, so it's passed in rather
 * than owned here; mission cargo is tracked elsewhere (MissionLog), so callers
 * that care about total load subtract it. DOM/game-free, so it is unit-tested
 * directly (test/hold.test.mjs). One of the focused state classes the S bag is
 * being broken into (docs/OOP_DESIGN.md, phase 5), alongside Wallet.
 */
export class Hold {
  // `commodities` is the ordered key list (Vₑ's six); `initial` is a plain
  // {key: tons} map (e.g. a pilot file's saved cargo). A corrupt/negative/
  // non-integer amount coerces to 0, so a bad save can't poison the hold.
  constructor(commodities, initial = {}) {
    this.commodities = [...commodities];
    // Null-prototype: keys come from untrusted data (commodity names, save
    // files), so the hold must not confuse a good named e.g. "toString" with an
    // inherited Object.prototype member — `adjust`/`get` check own keys only.
    this.goods = Object.create(null);
    for (const c of this.commodities) {
      const n = Math.floor(Number(initial && initial[c]));
      this.goods[c] = Number.isFinite(n) && n > 0 ? n : 0;
    }
  }

  get(c) {
    return this.goods[c] || 0;
  }

  // Total tons of commodities aboard (mission cargo is separate — see MissionLog).
  used() {
    let n = 0;
    for (const c of this.commodities) n += this.goods[c];
    return n;
  }

  // Move `qty` tons of `c` in (positive) or out (negative), clamped at 0. Returns
  // the delta actually applied (so a sell of more than you hold reports the real
  // amount). An unknown commodity or a non-finite/NaN qty (incl. ±Infinity) is a
  // no-op, so bad input can't poison the hold with Infinity/NaN tons.
  adjust(c, qty) {
    if (!Object.hasOwn(this.goods, c)) return 0;
    const d = Math.trunc(Number(qty));
    if (!Number.isFinite(d)) return 0;
    const before = this.goods[c];
    const after = Math.max(0, before + d);
    this.goods[c] = after;
    return after - before;
  }

  // Dump goods until at most `capacity` tons remain (after downsizing the hold).
  // Removes from whichever commodity still has stock; returns tons dumped.
  clampTo(capacity) {
    const cap = Math.max(0, Math.floor(capacity));
    let dumped = 0;
    while (this.used() > cap) {
      const c = this.commodities.find((x) => this.goods[x] > 0);
      if (!c) break;
      this.goods[c]--;
      dumped++;
    }
    return dumped;
  }

  // Plain {key: tons} object for the pilot save file (the `cargo` field).
  toJSON() {
    return { ...this.goods };
  }
}
