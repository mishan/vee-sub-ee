/*
 * engine/shell/missions-rules.js — the pure decision logic behind mission
 * offering, lifted out of 08-missions.js.
 *
 * These are the record-only "rules": given a mission/spöb/govt record (and, for
 * the bit helpers, a plain bit-store), they return a value or a boolean with no
 * reference to the ambient `DATA`/`document`/`EV` globals or the live game
 * state. 08-missions.js keeps thin wrappers that thread its module-scoped data
 * tables (the govt table, the spöb table, the mission log, the pilot birthdate)
 * into these, so its public API is unchanged.
 *
 * Because this module is DOM- and global-free it imports in node, so the
 * branching that decides where a mission sends you / whether it's offered is
 * unit-tested directly (test/missions-rules.test.mjs) — the pattern
 * OOP_DESIGN.md's "Testability — next" section lays out, already used by
 * mission-cargo.js. No behavior change: the bodies are the originals, with the
 * data they used to close over passed in as arguments instead.
 */

/* govt relations. Classic gövt records carry a single Ally / Enemy govt id (we
 * don't have alliance *lists* as data), so these return a 0- or 1-element array.
 * `govts` is the govt table (id -> record). */
export function govtAllies(g, govts) {
  const r = govts[g];
  return r ? [r.Ally].filter((a) => a >= 128) : [];
}
export function govtEnemies(g, govts) {
  const r = govts[g];
  return r ? [r.Enemy].filter((a) => a >= 128) : [];
}

/* Which goal types can we actually complete? Others aren't offered. Pure over
 * the mission record. */
export function goalSupported(m) {
  // Ship goals are the contiguous range 0..6; the guard already pins ShipGoal >= 0,
  // so an upper-bound check is all that's needed (no per-call array allocation).
  if (m.ShipCount > 0 && m.ShipGoal >= 0) return m.ShipGoal <= 6;
  return true; // cargo delivery / plain go-to
}

/* Resolve an AvailStel/TravelStel/ReturnStel code to a concrete spob id.
 * `here` is the spob the mission is being offered/accepted at. Returns a spob
 * id, or null if unresolvable. `ctx` carries the data this used to close over:
 *   spobs — the spöb table (id -> record), govts — the govt table,
 *   rng    — random source (defaults to Math.random; injected in tests). */
export function resolveStel(code, here, ctx) {
  const { spobs, govts, rng = Math.random } = ctx;
  const allSpobs = () => Object.entries(spobs).map(([id, p]) => ({ id: +id, ...p }));
  const spobById = (id) => spobs[id];
  const inhabited = () => allSpobs().filter((p) => p.$sem && !p.$sem.uninhabited && p.$sem.canLand);
  const uninhab = () => allSpobs().filter((p) => p.$sem && p.$sem.uninhabited);
  // A *random* destination never lands on the spöb you're being offered the job at
  // (the original never sent you "deliver to where you already are") — so exclude
  // `here` from the pool. The explicit codes (−4 "here", a fixed spöb ID) bypass
  // this by not going through pick().
  const pick = (arr) => {
    const pool = here ? arr.filter((p) => p.id !== here.id) : arr;
    return pool.length ? pool[Math.floor(rng() * pool.length)].id : null;
  };
  if (code === -1) return null; // no specific dest / any (caller decides)
  if (code === -2) return pick(inhabited());
  if (code === -3) return pick(uninhab());
  if (code === -4) return here ? here.id : null;
  if (code >= 128 && code <= 1627) return spobById(code) ? code : null;
  const govtPick = (g, filter) => pick(inhabited().filter((p) => filter(p.Govt, g)));
  if (code >= 9999 && code <= 10127) return govtPick(code - 9999, (pg, g) => pg === g);
  if (code >= 15000 && code <= 15127)
    return govtPick(code - 15000, (pg, g) => govtAllies(g, govts).includes(pg));
  if (code >= 20000 && code <= 20127) return govtPick(code - 20000, (pg, g) => pg !== g);
  if (code >= 25000 && code <= 25127)
    return govtPick(code - 25000, (pg, g) => govtEnemies(g, govts).includes(pg));
  return null;
}

/* Does an AvailStel code match the spob `p`? `govts` is the govt table. */
export function availStelMatch(code, p, govts) {
  if (code === -1) return p.$sem && !p.$sem.uninhabited && p.$sem.canLand;
  if (code >= 128 && code <= 1627) return p.id === code;
  const g = (c) => code - c;
  if (code >= 9999 && code <= 10127) return p.Govt === g(9999);
  if (code >= 15000 && code <= 15127) return govtAllies(g(15000), govts).includes(p.Govt);
  if (code >= 20000 && code <= 20127) return p.Govt !== g(20000);
  if (code >= 25000 && code <= 25127) return govtEnemies(g(25000), govts).includes(p.Govt);
  return false;
}

/* Mission-bit gates. `bits` is any store exposing bit(i)/setBit(i)/clearBit(i)
 * — the MissionLog in the game, a fake in tests. */
export function bitReq(v, bits) {
  // AvailBitSet-style code check
  if (v < 0) return true;
  if (v >= 1000) return !bits.bit(v - 1000);
  return bits.bit(v);
}
export function setBitCode(v, bits) {
  // CompBitSet-style: 0-511 set, 1000-1511 clear
  if (v == null || v < 0) return; // classic misn lacks some Nova bit fields
  if (v >= 1000) bits.clearBit(v - 1000);
  else bits.setBit(v);
}

/* Render an absolute gameDay as the real in-game calendar date, e.g.
 * "May 3rd, 2276" — the pilot's creation date (`born`) + 250 years, advanced one
 * day per jump. gameDate() in 11-title is just this called with the current
 * day. */
const DATE_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export function formatDate(day, born) {
  const base = new Date(born);
  const d = new Date(base.getFullYear() + 250, base.getMonth(), base.getDate());
  d.setDate(d.getDate() + day);
  const dd = d.getDate();
  const suf =
    dd % 10 === 1 && dd !== 11
      ? 'st'
      : dd % 10 === 2 && dd !== 12
        ? 'nd'
        : dd % 10 === 3 && dd !== 13
          ? 'rd'
          : 'th';
  return `${DATE_MONTHS[d.getMonth()]} ${dd}${suf}, ${d.getFullYear()}`;
}
