import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PilotStore } from '../engine/shell/save.js';

// PilotStore reads `localStorage` and `DATA` only inside its methods, so it
// imports in node; we stub those globals to exercise the roster/slot machinery.
// Capture and restore any pre-existing globals so this file doesn't leak stubs
// into other suites sharing the process.
const origLocalStorage = globalThis.localStorage;
const origDATA = globalThis.DATA;
after(() => {
  if (origLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = origLocalStorage;
  if (origDATA === undefined) delete globalThis.DATA;
  else globalThis.DATA = origDATA;
});

function fakeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
function reset() {
  globalThis.localStorage = fakeLocalStorage();
}
// migrateV1 expands per-govt records onto the systems each govt controls.
// Govts 200/201 are run by govt 150; 300 is independent (Govt < 128 → 128).
globalThis.DATA = {
  types: { syst: { 128: { Govt: 128 }, 200: { Govt: 150 }, 201: { Govt: 150 }, 300: { Govt: 5 } } },
};

test('_set/_get round-trips JSON; _get is null on a missing or unparseable key', () => {
  reset();
  assert.equal(PilotStore._set('k', { a: 1 }), true); // stored and verified
  assert.deepEqual(PilotStore._get('k'), { a: 1 });
  assert.equal(PilotStore._get('missing'), null);
  localStorage.setItem('bad', '{not json');
  assert.equal(PilotStore._get('bad'), null);
});

test('create adds a slot + roster summary + active id; read/activeId/roster reflect it', () => {
  reset();
  const id = PilotStore.create({ v: 2, name: 'A', ship: 128, credits: 5, day: 1 });
  assert.ok(id);
  assert.equal(PilotStore.activeId(), id);
  assert.equal(PilotStore.read(id).name, 'A');
  const r = PilotStore.roster();
  assert.equal(r.length, 1);
  assert.deepEqual(
    { id: r[0].id, name: r[0].name, credits: r[0].credits },
    { id, name: 'A', credits: 5 },
  );
});

test('load returns the active v2 pilot, or null when there is none', () => {
  reset();
  assert.equal(PilotStore.load(), null); // no active pilot
  PilotStore.create({ v: 2, name: 'A' });
  assert.equal(PilotStore.load().name, 'A');
});

test('load migrates a v1 pilot to v2 (per-govt record → per-system)', () => {
  reset();
  const id = 'p1';
  PilotStore._set(PilotStore.slot(id), { v: 1, name: 'Old', rep: { 150: 42 } });
  PilotStore._set(PilotStore.ROSTER, [{ id, name: 'Old' }]);
  PilotStore._set(PilotStore.ACTIVE, id);
  const p = PilotStore.load();
  assert.equal(p.v, 2);
  assert.equal(p.rep['200'], 42); // govt 150 controls systems 200 and 201
  assert.equal(p.rep['201'], 42);
  assert.equal(p.rep['128'], undefined); // govt 128 had no v1 record
});

test('migrateV1 maps each govt record onto all systems it controls (independents → 128)', () => {
  const out = PilotStore.migrateV1({ v: 1, rep: { 150: 10, 128: 3 } });
  assert.equal(out.v, 2);
  assert.deepEqual(out.rep, { 200: 10, 201: 10, 128: 3, 300: 3 }); // 300 is independent → govt 128
});

test('write updates the active slot and its roster summary in place (no duplicate)', () => {
  reset();
  const id = PilotStore.create({ v: 2, name: 'A', credits: 5, day: 1, ship: 128 });
  assert.equal(PilotStore.write({ v: 2, name: 'A', credits: 999, day: 2, ship: 128 }), true);
  assert.equal(PilotStore.read(id).credits, 999);
  assert.equal(PilotStore.roster().length, 1); // updated, not appended
  assert.equal(PilotStore.roster()[0].credits, 999);
});

test('write with no active pilot falls back to creating one', () => {
  reset();
  assert.equal(PilotStore.activeId(), null);
  assert.equal(PilotStore.write({ v: 2, name: 'New' }), true);
  assert.ok(PilotStore.activeId());
});

test('select and clear change the active pilot without touching the roster', () => {
  reset();
  const a = PilotStore.create({ v: 2, name: 'A' });
  const b = PilotStore.create({ v: 2, name: 'B' });
  assert.equal(PilotStore.activeId(), b); // create makes the new one active
  PilotStore.select(a);
  assert.equal(PilotStore.activeId(), a);
  PilotStore.clear();
  assert.equal(PilotStore.activeId(), null);
  assert.equal(PilotStore.roster().length, 2); // both still listed
});

test('remove deletes the slot, drops its roster entry, and reassigns active', () => {
  reset();
  const a = PilotStore.create({ v: 2, name: 'A' });
  const b = PilotStore.create({ v: 2, name: 'B' }); // active = b
  PilotStore.remove(b);
  assert.equal(PilotStore.read(b), null);
  assert.deepEqual(
    PilotStore.roster().map((e) => e.id),
    [a],
  );
  assert.equal(PilotStore.activeId(), a); // reassigned to the survivor
  PilotStore.remove(a);
  assert.equal(PilotStore.activeId(), null); // none left
});

test('_migrateLegacy absorbs a stray ve_pilot blob into a fresh active slot', () => {
  reset();
  PilotStore._set(PilotStore.LEGACY, { v: 2, name: 'Legacy', ship: 128, credits: 7 });
  const r = PilotStore.roster(); // roster() runs _migrateLegacy
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'Legacy');
  assert.equal(PilotStore._get(PilotStore.LEGACY), null); // the legacy blob is consumed
  assert.equal(PilotStore.read(PilotStore.activeId()).name, 'Legacy');
});

test('_migrateLegacy does not re-import when removeItem throws (no duplicate pilots)', () => {
  // A storage whose removeItem always fails (e.g. locked). The legacy key must
  // still be neutralized so a second roster() doesn't import it again.
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: () => {
      throw new Error('storage locked');
    },
  };
  PilotStore._set(PilotStore.LEGACY, { v: 2, name: 'Legacy', ship: 128 });
  assert.equal(PilotStore.roster().length, 1); // imported once
  assert.equal(PilotStore.roster().length, 1); // second pass: NOT re-imported
});
