import {
  missionLog,
  wallet,
  COMMODITIES,
  PRICE_MULT,
  S,
  cargo,
  outfits,
  preloadSprites,
  ships,
  showMsg,
  spinOfShip,
} from './01-state.js';
import { applyShipStats, effectiveShip, fuelMax, holds, player } from './04-combat.js';
import { refreshView } from './ui/dialog.js';

/*
 * engine/shell/07-trade.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---- trading (spec: "Trading") ---- */

export const cargoNames = DATA.strings[4000].list.slice(0, 6);
export const basePrices = DATA.strings[4004].list.slice(0, 6).map(Number);
export const missionCargoUsed = () =>
  missionLog.list.reduce((n, a) => n + (a.cargoLoaded ? a.cargoQty : 0), 0);
export const cargoUsed = () => COMMODITIES.reduce((n, c) => n + cargo[c], 0) + missionCargoUsed();

export function priceAt(spob, i) {
  const lvl = spob.$sem && spob.$sem.prices[COMMODITIES[i]];
  return lvl && PRICE_MULT[lvl] ? Math.round(basePrices[i] * PRICE_MULT[lvl]) : null;
}
export function trade(i, qty) {
  if (!S.landedAt) return;
  const price = priceAt(S.landedAt, i);
  if (price == null) return;
  if (qty > 0) qty = Math.min(qty, holds - cargoUsed(), Math.floor(wallet.credits / price));
  else qty = Math.max(qty, -cargo[COMMODITIES[i]]);
  cargo[COMMODITIES[i]] += qty;
  wallet.settle(qty * price); // buy (qty>0) charges, sell (qty<0) credits
  refreshView();
}

/* The service-dialog framework — the `View`/`activeView`/`refreshView` base
 * (ui/dialog.js) and the concrete `openService`/`closeService`/`SERVICE_VIEWS`
 * registry (ui/services.js) — used to live here; this module now keeps only the
 * trade/outfit/shipyard *logic* the dialogs act on. */

/* tech availability (spec: spöb TechLevel gate + SpecialTech exact match) */
export function techAvailable(itemTech, p) {
  if (itemTech <= p.TechLevel) return true;
  return [p.SpecialTech1, p.SpecialTech2, p.SpecialTech3].includes(itemTech);
}

/* ---- outfitter ---- */

export const outfitName = (id) =>
  DATA.strings[5000].list[id - 128] || (DATA.types.outf[id] ? 'outfit ' + id : null);

export function buyOutfit(id, qty) {
  const o = DATA.types.outf[id];
  if (!o) return;
  const s = effectiveShip();
  if (qty > 0) {
    if (o.Max > 0 && (outfits[id] || 0) + qty > o.Max) qty = o.Max - (outfits[id] || 0);
    if (o.Mass > 0) qty = Math.min(qty, Math.floor(s.freeMass / o.Mass));
    if (o.Cost > 0) qty = Math.min(qty, Math.floor(wallet.credits / o.Cost));
    if (qty <= 0) return;
  } else {
    qty = Math.max(qty, -(outfits[id] || 0));
    if (qty === 0) return;
  }
  outfits[id] = (outfits[id] || 0) + qty;
  if (!outfits[id]) delete outfits[id];
  wallet.settle(qty * o.Cost); // buy (qty>0) charges, sell (qty<0) credits
  applyShipStats();
  // cargo can't exceed a shrunken hold: dump overflow (paid nothing for it)
  while (cargoUsed() > holds) {
    const c = COMMODITIES.find((c) => cargo[c] > 0);
    if (!c) break;
    cargo[c]--;
  }
  refreshView();
}

// Shop selection (which grid cell is highlighted) lives on S so the select
// actions here and the renderers in ui/shops.js share it. Menu-sheet + dialog
// art conventions are documented on shopGrid in ui/shops.js.
S.selOutfitId = null;
S.selShipId = null;

/* Would this spob's shop have anything to show? Gates both the dialog
 * and the button on the landing screen. */
export function outfitterStock(p) {
  return Object.entries(DATA.types.outf).filter(
    ([id, o]) => o.MissionBit < 0 && (techAvailable(o.TechLevel, p) || (outfits[id] || 0) > 0),
  );
}
export function shipyardStock(p) {
  return Object.entries(ships).filter(([, r]) => r.MissionBit < 0 && techAvailable(r.TechLevel, p));
}

export function selectOutfit(id) {
  S.selOutfitId = id;
  refreshView();
}
export function selectShip(id) {
  S.selShipId = id;
  refreshView();
}

/* ---- shipyard ---- */

export const shipyardName = (id) =>
  DATA.strings[5001].list[id - 128] || (ships[id] ? ships[id].name : null);

/* Trade-in per the resource bible: "the cost of buying a ship is always
 * the cost of the new ship minus 25% of the original cost of your current
 * ship and upgrades." */
export function tradeInValue() {
  return Math.round(
    0.25 *
      (ships[S.playerShipId].Cost +
        Object.entries(outfits).reduce(
          (n, [oid, c]) => n + (DATA.types.outf[oid] ? DATA.types.outf[oid].Cost * c : 0),
          0,
        )),
  );
}
export function buyShip(id) {
  const rec = ships[id];
  if (!rec || id === S.playerShipId) return;
  const refund = tradeInValue();
  const price = rec.Cost - refund;
  // A net-negative price (trade-in worth more than the new hull) pays the pilot,
  // so only guard affordability for a positive net cost.
  if (price > 0 && !wallet.canAfford(price)) return;
  if (cargoUsed() > rec.Holds) {
    showMsg('Your cargo would not fit aboard.');
    return;
  }
  wallet.settle(price); // net-negative (trade-in > cost) pays the pilot
  S.playerShipId = id;
  player.shipId = id;
  for (const k of Object.keys(outfits)) delete outfits[k];
  applyShipStats();
  S.fuel = fuelMax;
  preloadSprites(new Set([spinOfShip(id)]));
  showMsg(`${shipyardName(id)} purchased. Old hull and outfits traded in.`);
  refreshView();
}
