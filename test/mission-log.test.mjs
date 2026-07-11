// Unit tests for the MissionLog state class (engine/shell/mission-log.js).
// Run with `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionLog } from '../engine/shell/mission-log.js';

test('active-mission list: add/find/has/remove/count', () => {
  const log = new MissionLog();
  assert.equal(log.count, 0);
  log.add({ id: 5, name: 'A' });
  log.add({ id: 9, name: 'B' });
  assert.equal(log.count, 2);
  assert.ok(log.has(5));
  assert.ok(!log.has(7));
  assert.equal(log.find(9).name, 'B');
  assert.equal(log.find(7), undefined);
  log.remove(5);
  assert.equal(log.count, 1);
  assert.ok(!log.has(5));
  assert.ok(log.has(9));
});

test('the constructor seeds the mission list from a pilot file', () => {
  const log = new MissionLog([{ id: 1 }, { id: 2 }]);
  assert.equal(log.count, 2);
  assert.ok(log.has(1));
});

test('plot bits: set/clear/test, seeded from a pilot file, 512 wide', () => {
  const log = new MissionLog([], [3, 100]);
  assert.ok(log.bit(3));
  assert.ok(log.bit(100));
  assert.ok(!log.bit(4));
  log.setBit(4);
  assert.ok(log.bit(4));
  log.clearBit(3);
  assert.ok(!log.bit(3));
  assert.equal(log.bits.length, 512);
  // out-of-range seed bits are ignored, not written past the array
  assert.doesNotThrow(() => new MissionLog([], [999, -1]));
});

test('per-system caches are null-prototype and reset together', () => {
  const log = new MissionLog();
  assert.equal(Object.getPrototypeOf(log.availRandom), null);
  assert.equal(Object.getPrototypeOf(log.resolvedOffers), null);
  log.availRandom[5] = 42;
  log.resolvedOffers['128@200'] = { dest: 1 };
  log.resetForSystem();
  assert.equal(log.availRandom[5], undefined);
  assert.deepEqual({ ...log.resolvedOffers }, {});
  assert.equal(Object.getPrototypeOf(log.availRandom), null); // still null-proto after reset
});
