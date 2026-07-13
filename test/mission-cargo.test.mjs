// Unit tests for the mission cargo math (engine/shell/mission-cargo.js): the
// CargoQty roll and the accept-time space requirement. Run with `npm test`.
//
// Regression: a user with a nearly-full hold (50t hold, 42t of active-mission
// cargo → 8t free) was falsely told "Not enough cargo space" when accepting
// random-cargo missions. doAcceptMission had recomputed the requirement from the
// raw template as abs(CargoQty), but the mission's real cargo is getOffer's roll
// of abs(CargoQty)×(0.5–1.5), which for a −10 template is 5–15t. A roll of 6–8t
// fits in 8t free, yet abs(−10)=10 rejected it. The requirement must come from
// the resolved offer, which is what these two helpers now guarantee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollCargoQty, cargoNeededToAccept } from '../engine/shell/mission-cargo.js';

test('rollCargoQty: a fixed CargoQty is used as-is; junk clamps to 0', () => {
  assert.equal(rollCargoQty(10), 10);
  assert.equal(rollCargoQty(0), 0);
  assert.equal(rollCargoQty(-1), 0, '−1 is not the random sentinel; clamps to 0');
});

test('rollCargoQty: a random CargoQty (≤ −2) rolls abs × (0.5–1.5)', () => {
  // deterministic rnd → deterministic tons
  assert.equal(
    rollCargoQty(-10, () => 0),
    5,
    'floor of the range: abs × 0.5',
  );
  assert.equal(
    rollCargoQty(-10, () => 1),
    15,
    'ceiling of the range: abs × 1.5',
  );
  assert.equal(
    rollCargoQty(-10, () => 0.5),
    10,
    'mid: abs × 1.0',
  );
  // a low roll really is below abs(CargoQty) — the whole point of the bug
  assert.ok(rollCargoQty(-10, () => 0.1) < 10);
});

test('cargoNeededToAccept: pickup-on-accept cargo needs the resolved offer tons', () => {
  const m = { PickupMode: 0 };
  assert.equal(cargoNeededToAccept(m, { cargoName: 'Food', cargoQty: 6 }), 6);
  assert.equal(cargoNeededToAccept(m, { cargoName: 'Medical', cargoQty: 15 }), 15);
});

test('cargoNeededToAccept: passenger/no-cargo and pickup-later need no space now', () => {
  // no cargoName → passenger or non-cargo mission
  assert.equal(cargoNeededToAccept({ PickupMode: 0 }, { cargoName: null, cargoQty: 0 }), 0);
  // cargo picked up later (PickupMode ≠ 0) occupies nothing on accept
  assert.equal(cargoNeededToAccept({ PickupMode: 1 }, { cargoName: 'Food', cargoQty: 12 }), 0);
});

test('regression: a −10 mission that rolled small is accepted with 8t free', () => {
  const FREE = 8; // 50t hold − 42t active-mission cargo
  const m = { PickupMode: 0 };
  // getOffer resolved this mission to a 6t roll (< abs(−10)=10)
  const offer = { cargoName: 'Medical', cargoQty: rollCargoQty(-10, () => 0.1) };
  assert.ok(offer.cargoQty <= FREE, `rolled ${offer.cargoQty}t, fits in ${FREE}t`);
  const need = cargoNeededToAccept(m, offer);
  assert.equal(need, offer.cargoQty, 'need equals the tons that will actually load');
  assert.ok(need <= FREE, 'accepted: within free space');
  // the old computation would have used abs(CargoQty) and wrongly rejected
  assert.ok(Math.abs(-10) > FREE, 'the old abs(CargoQty) check falsely rejected this');
});
