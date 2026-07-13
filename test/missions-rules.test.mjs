import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  govtAllies,
  govtEnemies,
  goalSupported,
  resolveStel,
  availStelMatch,
  bitReq,
  setBitCode,
  formatDate,
} from '../engine/shell/missions-rules.js';

// Synthetic data tables. The govt-relative AvailStel ranges are exactly the
// originals from 08-missions.js, so these ids are chosen to land in-range:
// self-govt allows g up to 128 (code 9999..10127); ally/enemy/not-govt allow
// g 0..127 (code 15000/20000/25000 + g), so those use g = 10.
// govtAllies/Enemies keep only ids >= 128 (that filter is the original's), so
// the Ally/Enemy values here are >= 128; the *govt* keys can be 0..127.
const govts = {
  10: { Ally: 129, Enemy: 130 }, // g=10 for the ally/enemy/not-govt ranges
  128: { Ally: 129, Enemy: 130 }, // for the self-govt range (allows g up to 128)
  129: { Ally: -1, Enemy: -1 },
  130: { Ally: -1, Enemy: -1 },
};
const spobs = {
  128: { Govt: 10, $sem: { canLand: true } }, // inhabited, govt 10
  129: { Govt: 129, $sem: { canLand: true } }, // inhabited, govt 129 (ally of 10)
  130: { Govt: 130, $sem: { canLand: true } }, // inhabited, govt 130 (enemy of 10)
  131: { Govt: -1, $sem: { uninhabited: true } }, // uninhabited
};
const zero = () => 0; // deterministic rng: always picks the first candidate

test('govtAllies / govtEnemies read the single Ally/Enemy id, ignore <128 and missing', () => {
  assert.deepEqual(govtAllies(10, govts), [129]);
  assert.deepEqual(govtAllies(128, govts), [129]);
  assert.deepEqual(govtEnemies(128, govts), [130]);
  assert.deepEqual(govtAllies(999, govts), []); // unknown govt → empty
});

test('goalSupported: real ship goals supported, unknown goal not, cargo/go-to always', () => {
  assert.equal(goalSupported({ ShipCount: 2, ShipGoal: 0 }), true);
  assert.equal(goalSupported({ ShipCount: 2, ShipGoal: 6 }), true);
  assert.equal(goalSupported({ ShipCount: 2, ShipGoal: 7 }), false); // out of 0..6
  assert.equal(goalSupported({ ShipCount: 0 }), true); // cargo delivery
  assert.equal(goalSupported({ ShipCount: 2, ShipGoal: -1 }), true); // no ship goal
});

test('resolveStel: sentinel codes (-1 none, -4 here)', () => {
  const ctx = { spobs, govts, rng: zero };
  assert.equal(resolveStel(-1, { id: 128 }, ctx), null);
  assert.equal(resolveStel(-4, { id: 129 }, ctx), 129);
  assert.equal(resolveStel(-4, null, ctx), null);
});

test('resolveStel: explicit spob id resolves only if it exists', () => {
  const ctx = { spobs, govts, rng: zero };
  assert.equal(resolveStel(129, null, ctx), 129);
  assert.equal(resolveStel(500, null, ctx), null);
});

test('resolveStel: inhabited/uninhabited picks use the injected rng', () => {
  const ctx = { spobs, govts, rng: zero };
  assert.equal(resolveStel(-2, null, ctx), 128); // first inhabited
  assert.equal(resolveStel(-3, null, ctx), 131); // first uninhabited
  // last inhabited (128, 129, 130) when rng points at the end of the list
  assert.equal(resolveStel(-2, null, { spobs, govts, rng: () => 0.999 }), 130);
});

test('resolveStel: govt-relative ranges (self / ally / not / enemy)', () => {
  const ctx = { spobs, govts, rng: zero };
  assert.equal(resolveStel(9999 + 10, null, ctx), 128); // govt 10 → spob 128
  assert.equal(resolveStel(15000 + 10, null, ctx), 129); // ally(10)=129 → spob 129
  assert.equal(resolveStel(20000 + 10, null, ctx), 129); // not-govt-10 → first is spob 129
  assert.equal(resolveStel(25000 + 10, null, ctx), 130); // enemy(10)=130 → spob 130
});

test('availStelMatch: sentinel, explicit id, and govt ranges', () => {
  const inhabited = spobs[128],
    rock = spobs[131];
  assert.equal(availStelMatch(-1, inhabited, govts), true);
  assert.equal(availStelMatch(-1, rock, govts), false); // uninhabited
  assert.equal(availStelMatch(129, { id: 129 }, govts), true);
  assert.equal(availStelMatch(129, { id: 128 }, govts), false);
  assert.equal(availStelMatch(9999 + 128, { Govt: 128 }, govts), true); // self govt
  assert.equal(availStelMatch(9999 + 128, { Govt: 129 }, govts), false);
  assert.equal(availStelMatch(15000 + 10, { Govt: 129 }, govts), true); // ally(10)=129
  assert.equal(availStelMatch(20000 + 10, { Govt: 20 }, govts), true); // not govt 10
  assert.equal(availStelMatch(20000 + 10, { Govt: 10 }, govts), false);
  assert.equal(availStelMatch(25000 + 10, { Govt: 130 }, govts), true); // enemy(10)=130
});

// A minimal bit store with the MissionLog interface the rules expect.
function fakeBits(set = []) {
  const s = new Set(set);
  return {
    bit: (i) => s.has(i),
    setBit: (i) => s.add(i),
    clearBit: (i) => s.delete(i),
    has: (i) => s.has(i),
  };
}

test('bitReq: negative always true; 0-511 set-check; 1000+ inverted clear-check', () => {
  const bits = fakeBits([5]);
  assert.equal(bitReq(-1, bits), true); // no requirement
  assert.equal(bitReq(5, bits), true); // bit 5 is set
  assert.equal(bitReq(7, bits), false); // bit 7 unset
  assert.equal(bitReq(1005, bits), false); // "bit 5 must be clear" — it isn't
  assert.equal(bitReq(1007, bits), true); // "bit 7 must be clear" — it is
});

test('setBitCode: null/negative no-op; 0-511 sets; 1000+ clears', () => {
  const bits = fakeBits([5]);
  setBitCode(null, bits);
  setBitCode(-1, bits);
  assert.equal(bits.has(5), true); // unchanged
  setBitCode(8, bits);
  assert.equal(bits.has(8), true); // set
  setBitCode(1005, bits);
  assert.equal(bits.has(5), false); // cleared
});

test('formatDate: pilot birthdate + 250 years, one day per gameDay, ordinal suffix', () => {
  const born = new Date(2000, 0, 1); // Jan 1, 2000
  assert.equal(formatDate(0, born), 'January 1st, 2250');
  assert.equal(formatDate(1, born), 'January 2nd, 2250');
  assert.equal(formatDate(2, born), 'January 3rd, 2250');
  assert.equal(formatDate(3, born), 'January 4th, 2250');
  assert.equal(formatDate(10, born), 'January 11th, 2250'); // 11th, not 11st
  assert.equal(formatDate(20, born), 'January 21st, 2250');
  assert.equal(formatDate(21, born), 'January 22nd, 2250');
});
