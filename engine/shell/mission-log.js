/*
 * engine/shell/mission-log.js — the pilot's mission state.
 *
 * Three things that all belong to "the player's missions" and were scattered on
 * the S bag: the list of accepted missions, the 512 plot flags ("mission bits"),
 * and two per-system caches used while offering missions. The list + bits are
 * persisted in the pilot file; the caches are transient and cleared on each
 * system arrival (resetForSystem).
 *
 * The queries that need the mission *records* (availability, text, goals) stay
 * in 08-missions.js and read this log. DOM/game-free, so it is unit-tested
 * directly (test/mission-log.test.mjs). One of the focused state classes the S
 * bag is being broken into (docs/OOP_DESIGN.md, phase 5).
 */
export class MissionLog {
  constructor(missions = [], setBits = []) {
    this.list = Array.isArray(missions) ? missions : []; // accepted missions
    this.bits = new Uint8Array(512); // mission plot flags
    for (const b of setBits) if (b >= 0 && b < 512) this.bits[b] = 1;
    // Per-system offer caches, keyed by mission id / offer key. Null-prototype so
    // keys can't reach the prototype chain; both are cleared on system arrival.
    this.availRandom = Object.create(null); // misnId -> rolled % (AvailRandom check)
    this.resolvedOffers = Object.create(null); // offer key -> resolved offer
  }

  /* ---- accepted missions ---- */
  get count() {
    return this.list.length;
  }
  has(id) {
    return this.list.some((a) => a.id === id);
  }
  find(id) {
    return this.list.find((a) => a.id === id);
  }
  add(mission) {
    this.list.push(mission);
  }
  remove(id) {
    this.list = this.list.filter((a) => a.id !== id);
  }

  /* ---- plot flags (spec: mission bits) ---- */
  bit(i) {
    return !!this.bits[i];
  }
  setBit(i) {
    this.bits[i] = 1;
  }
  clearBit(i) {
    this.bits[i] = 0;
  }

  /* ---- per-system offer caches ---- */
  resetForSystem() {
    this.availRandom = Object.create(null);
    this.resolvedOffers = Object.create(null);
  }
}
