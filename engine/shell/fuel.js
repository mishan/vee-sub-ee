/*
 * engine/shell/fuel.js — the ship's hyperspace fuel (current level + tank size).
 *
 * Owns the fuel invariants: the level never exceeds the tank or drops below empty,
 * a hyperjump costs a fixed amount (JUMP_FUEL), and the tank refills on landing.
 * Capacity is ship-derived (base Fuel + fuel-capacity outfits), so applyShipStats
 * resizes it via setMax. Fuel is transient session state (not saved — you land,
 * which tops off, before every save), so there's no toJSON. DOM/game-free, so it
 * is unit-tested directly (test/fuel.test.mjs). One of the focused state classes
 * the S bag is being broken into (docs/OOP_DESIGN.md, phase 5), alongside Wallet,
 * Hold and Outfits.
 */
export class Fuel {
  // `max` is the tank size; `jumpCost` the fuel a single hyperjump spends. Tanks
  // start full, as the original does for a fresh/refuelled ship.
  constructor(max, jumpCost) {
    this.max = max;
    this.jumpCost = jumpCost;
    this.current = max;
  }

  get value() {
    return this.current;
  }

  // Whole hyperjumps the current fuel affords (the panel's "Jumps left").
  get jumps() {
    return Math.floor(this.current / this.jumpCost);
  }

  // 0..1 fill fraction for the fuel bar (guards an empty/zero-size tank).
  get fraction() {
    return this.max > 0 ? Math.max(0, Math.min(1, this.current / this.max)) : 0;
  }

  full() {
    return this.current >= this.max;
  }

  canJump() {
    return this.current >= this.jumpCost;
  }

  // Spend one jump's fuel, clamped at empty.
  spendJump() {
    this.current = Math.max(0, this.current - this.jumpCost);
  }

  // Spend an arbitrary amount (the afterburner drains fuel per frame), clamped
  // at empty. Returns the amount actually spent.
  burn(amount) {
    const spent = Math.min(this.current, Math.max(0, amount));
    this.current -= spent;
    return spent;
  }

  // Top off the tank (landing, the refuel service, buying/capturing a ship).
  refill() {
    this.current = this.max;
  }

  // Resize the tank on a refit (fuel-capacity outfit added/removed); keep the
  // current level within the new tank.
  setMax(max) {
    this.max = max;
    if (this.current > max) this.current = max;
  }
}
