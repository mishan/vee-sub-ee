/*
 * engine/shell/wallet.js — the pilot's credit balance.
 *
 * The affordability invariant ("can't spend what you don't have") lives here in
 * one place: callers ask canAfford() before spending. Amounts are validated as
 * finite, non-negative numbers so a bad price or a corrupt save can't silently
 * corrupt the balance (string concatenation, negative "costs", NaN compares).
 * DOM/game-free, so it is unit-tested directly (test/wallet.test.mjs). First of
 * the focused state classes the S bag is being broken into (docs/OOP_DESIGN.md,
 * phase 5).
 */

// Validate a spend/earn amount: coerce to a number and require it be finite and
// non-negative. Throws on misuse so money bugs fail fast during development.
function amount(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`Wallet: expected a non-negative finite amount, got ${x}`);
  }
  return n;
}

export class Wallet {
  constructor(credits = 0) {
    // Tolerate a corrupt pilot file: a non-numeric or negative balance resets to 0.
    const n = Number(credits);
    this.credits = Number.isFinite(n) && n >= 0 ? n : 0;
  }

  canAfford(cost) {
    // A non-numeric or negative cost is never "affordable" — surface the bug as
    // a disabled/blocked action rather than crashing a render.
    const n = Number(cost);
    if (!Number.isFinite(n) || n < 0) return false;
    return this.credits >= n;
  }

  earn(income) {
    this.credits += amount(income);
  }

  // Deduct `cost`. Callers must have checked canAfford() first; overdrawing (or a
  // negative/non-numeric cost) is a bug, so fail fast rather than corrupting the
  // balance.
  spend(cost) {
    const c = amount(cost);
    if (c > this.credits) {
      throw new RangeError(`Wallet: cannot spend ${c} with balance ${this.credits}`);
    }
    this.credits -= c;
  }

  // Apply a signed transaction in one call: a positive net is a charge (spend), a
  // negative net a credit (earn). Lets buy/sell flows — where the quantity can be
  // negative — settle through the validated methods instead of touching credits.
  settle(net) {
    if (net >= 0) this.spend(net);
    else this.earn(-net);
  }
}
