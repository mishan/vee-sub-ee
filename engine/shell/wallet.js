/*
 * engine/shell/wallet.js — the pilot's credit balance.
 *
 * The affordability invariant ("can't spend what you don't have") lives here in
 * one place: callers ask canAfford() before spending. DOM/game-free, so it is
 * unit-tested directly (test/wallet.test.mjs). This is the first of the focused
 * state classes the S bag is being broken into (docs/OOP_DESIGN.md, phase 5).
 */
export class Wallet {
  constructor(credits = 0) {
    this.credits = credits;
  }

  canAfford(cost) {
    return this.credits >= cost;
  }

  earn(amount) {
    this.credits += amount;
  }

  // Deduct `cost`. Callers must have checked canAfford() first; overdrawing is a
  // bug, so fail fast rather than silently letting the balance go negative.
  spend(cost) {
    if (cost > this.credits) {
      throw new RangeError(`Wallet: cannot spend ${cost} with balance ${this.credits}`);
    }
    this.credits -= cost;
  }
}
