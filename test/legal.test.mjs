// Unit tests for the LegalRecord state class (engine/shell/legal.js).
// Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegalRecord } from '../engine/shell/legal.js';

test('adjust bumps from a 0 baseline and guards no-ops', () => {
  const l = new LegalRecord();
  l.adjust(128, 5);
  assert.equal(l.raw(128), 5);
  l.adjust(128, -8);
  assert.equal(l.raw(128), -3);
  l.adjust(-1, 5); // negative govt id ignored
  l.adjust(200, 0); // zero amount ignored
  assert.ok(!l.has(200));
});

test('set stores an absolute value; pardon clears only negative records', () => {
  const l = new LegalRecord({ 128: -50 });
  assert.equal(l.raw(128), -50);
  l.set(128, l.raw(128) - 10); // absolute set from the current value
  assert.equal(l.raw(128), -60);
  l.pardon(128);
  assert.equal(l.raw(128), 0); // criminal record cleared to clean
  l.set(140, 20);
  l.pardon(140);
  assert.equal(l.raw(140), 20); // a good record is left alone
});

test('recordKill accrues at least 1 per kill', () => {
  const l = new LegalRecord({}, 0);
  l.recordKill(5);
  assert.equal(l.kills, 5);
  l.recordKill(0); // 0 crew still counts as a kill
  assert.equal(l.kills, 6);
  l.recordKill(); // undefined crew → +1
  assert.equal(l.kills, 7);
});

test('has/raw reflect stored records; the constructor seeds from a pilot file', () => {
  const l = new LegalRecord({ 128: 3 }, 42);
  assert.ok(l.has(128));
  assert.equal(l.raw(128), 3);
  assert.equal(l.kills, 42);
  assert.ok(!l.has(999));
  assert.equal(l.raw(999), undefined);
});

test('numeric state is coerced against a corrupt pilot file', () => {
  // kills from a save is sanitized to a finite, non-negative number
  assert.equal(new LegalRecord({}, '7').kills, 7);
  assert.equal(new LegalRecord({}, 'oops').kills, 0);
  assert.equal(new LegalRecord({}, -3).kills, 0);

  // seeded record values are coerced too, so legalOf(g) + kp stays numeric in
  // callers like creditKill (a string would concat: '10' + 5 -> '105')
  const seeded = new LegalRecord({ 128: '10', 200: 'bad' });
  assert.strictEqual(seeded.raw(128), 10);
  assert.strictEqual(seeded.raw(200), 0);
  assert.strictEqual(seeded.raw(128) + 5, 15);

  // adjust coerces both the delta and a stringly-typed saved record (no concat)
  const l = new LegalRecord({ 128: '10' });
  l.adjust(128, '5');
  assert.equal(l.raw(128), 15); // '10' + '5' would be "105"
  l.adjust(128, 'x'); // invalid delta → no-op
  assert.equal(l.raw(128), 15);
  l.adjust(128, 0); // zero delta → no-op
  assert.equal(l.raw(128), 15);

  // pardon coerces a stringly saved value instead of producing NaN
  const p = new LegalRecord({ 200: '-40' });
  p.pardon(200);
  assert.equal(p.raw(200), 0);

  // recordKill never lets a non-number corrupt the tally
  const k = new LegalRecord({}, 0);
  k.recordKill('3');
  assert.equal(k.kills, 3);
  k.recordKill('nope');
  assert.equal(k.kills, 4); // falls back to +1
  k.recordKill(undefined);
  assert.equal(k.kills, 5);
});

test('records are a null-prototype map: inherited keys are never observed', () => {
  const l = new LegalRecord();
  // a govt id that collides with an Object.prototype member must not read through
  assert.ok(!l.has('toString'));
  assert.equal(l.raw('toString'), undefined);
  // a hostile save key stays an own data property and never pollutes the prototype
  const seeded = new LegalRecord(JSON.parse('{"__proto__": 5, "128": 3}'));
  assert.equal(Object.getPrototypeOf(seeded.records), null);
  assert.equal(seeded.raw(128), 3);
  assert.equal(Object.getPrototypeOf({}), Object.prototype); // global prototype intact
});
