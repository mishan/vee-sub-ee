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
