import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLanding, shouldClearOnApproach } from '../engine/shell/landing-rules.js';

// decideLanding: the outcome of pressing L, given the four booleans the shell
// computes. The opening (non-active) press only ever opens a request — it never
// touches down — and the port clears you at once if you're already in range.
test('decideLanding: first press, out of range → request on approach (not cleared)', () => {
  const r = decideLanding({ active: false, denied: false, inRange: false, tooFast: false });
  assert.deepEqual(r, { action: 'request', cleared: false });
});

test('decideLanding: first press, already in range → request, cleared immediately', () => {
  const r = decideLanding({ active: false, denied: false, inRange: true, tooFast: true });
  // cleared even though tooFast — the opening press never lands, so speed is
  // irrelevant until the touchdown press.
  assert.deepEqual(r, { action: 'request', cleared: true });
});

test('decideLanding: a denied port refuses on any press, active or not', () => {
  for (const active of [false, true]) {
    for (const inRange of [false, true]) {
      const r = decideLanding({ active, denied: true, inRange, tooFast: false });
      assert.equal(r.action, 'deny');
    }
  }
});

test('decideLanding: active request, still out of range → tooFar', () => {
  const r = decideLanding({ active: true, denied: false, inRange: false, tooFast: false });
  assert.equal(r.action, 'tooFar');
});

test('decideLanding: active request, in range but too fast → tooFast', () => {
  const r = decideLanding({ active: true, denied: false, inRange: true, tooFast: true });
  assert.equal(r.action, 'tooFast');
});

test('decideLanding: active request, in range and slow but not yet cleared → clear', () => {
  // Touchdown never skips clearance: pressing L the same frame you cross into
  // range (before the clearance poll runs) announces clearance, not a landing.
  const r = decideLanding({
    active: true,
    denied: false,
    inRange: true,
    tooFast: false,
    cleared: false,
  });
  assert.equal(r.action, 'clear');
});

test('decideLanding: active request, in range, slow, and cleared → land', () => {
  const r = decideLanding({
    active: true,
    denied: false,
    inRange: true,
    tooFast: false,
    cleared: true,
  });
  assert.equal(r.action, 'land');
});

// shouldClearOnApproach: the per-frame auto-clearance ("got close since
// initiating"). Fires exactly once, only for an open, uncleared, undenied
// request on the current target that has reached the radius.
test('shouldClearOnApproach: true once an open uncleared request reaches the radius', () => {
  assert.equal(
    shouldClearOnApproach({
      hasRequest: true,
      sameTarget: true,
      cleared: false,
      denied: false,
      inRange: true,
    }),
    true,
  );
});

test('shouldClearOnApproach: false when already cleared, denied, out of range, or off-target', () => {
  const base = {
    hasRequest: true,
    sameTarget: true,
    cleared: false,
    denied: false,
    inRange: true,
  };
  assert.equal(shouldClearOnApproach({ ...base, cleared: true }), false); // already announced
  assert.equal(shouldClearOnApproach({ ...base, denied: true }), false); // port refuses
  assert.equal(shouldClearOnApproach({ ...base, inRange: false }), false); // not there yet
  assert.equal(shouldClearOnApproach({ ...base, sameTarget: false }), false); // retargeted
  assert.equal(shouldClearOnApproach({ ...base, hasRequest: false }), false); // no request
});
