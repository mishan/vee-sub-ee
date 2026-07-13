/*
 * engine/shell/mission-cargo.js — pure cargo math for missions (DOM-free).
 *
 * Extracted so the offer resolver (08-missions getOffer) and the accept-time
 * space check (ui/missionboard doAcceptMission) share one definition of "how
 * much cargo does this mission involve", and so that math can be unit-tested
 * directly (test/mission-cargo.test.mjs) without the DOM/game singletons.
 */

// Resolve a mïsn CargoQty field to actual tons. A value ≤ −2 is a *random*
// amount: classic EV rolls abs(CargoQty) × (0.5–1.5) once, when the mission is
// first offered. A fixed amount is used as-is; any other negative clamps to 0.
export const rollCargoQty = (cargoQty, rnd = Math.random) =>
  cargoQty <= -2 ? Math.round(Math.abs(cargoQty) * (0.5 + rnd())) : Math.max(cargoQty, 0);

// Tons of hold space accepting a mission needs *right now* — exactly the cargo
// acceptMission will load: the already-resolved offer amount the briefing showed
// (offer.cargoQty), and only when that is real cargo picked up on accept
// (PickupMode 0). Passenger / no-cargo missions (no cargoName) and pickup-later
// missions consume no space yet. Using the resolved offer instead of the raw
// abs(CargoQty) is what keeps a random-cargo mission that rolled small from being
// falsely rejected when the hold is nearly full.
export const cargoNeededToAccept = (m, offer) =>
  offer.cargoName && m.PickupMode === 0 ? offer.cargoQty : 0;
