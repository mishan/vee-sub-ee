import {
  missionLog,
  wallet,
  COMMODITIES,
  PRICE_MULT,
  S,
  hold,
  outfits,
  preloadSprites,
  ships,
  showMsg,
  spinOfShip,
  explored,
} from './01-state.js';
import {
  applyShipStats,
  effectiveShip,
  fuel,
  holds,
  player,
  systemsWithinJumps,
} from './04-combat.js';
import { refreshView } from './ui/dialog.js';
import * as rules from './trade-rules.js';

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
export const cargoUsed = () => hold.used() + missionCargoUsed();

// The pure pricing/tech/trade-in math lives in trade-rules.js (DOM-free,
// unit-tested); these wrappers thread this module's data tables.
export const priceAt = (spob, i) =>
  rules.priceAt(spob, i, { commodities: COMMODITIES, priceMult: PRICE_MULT, basePrices });
export function trade(i, qty) {
  if (!S.landedAt) return;
  const price = priceAt(S.landedAt, i);
  if (price == null) return;
  if (qty > 0) qty = Math.min(qty, holds - cargoUsed(), Math.floor(wallet.credits / price));
  else qty = Math.max(qty, -hold.get(COMMODITIES[i]));
  hold.adjust(COMMODITIES[i], qty);
  wallet.settle(qty * price); // buy (qty>0) charges, sell (qty<0) credits
  refreshView();
}

/* The service-dialog framework — the `View`/`activeView`/`refreshView` base
 * (ui/dialog.js) and the concrete `openService`/`closeService`/`SERVICE_VIEWS`
 * registry (ui/services.js) — used to live here; this module now keeps only the
 * trade/outfit/shipyard *logic* the dialogs act on. */

/* tech availability (spec: spöb TechLevel gate + SpecialTech exact match) */
export const techAvailable = rules.techAvailable;

/* ---- outfitter ---- */

export const outfitName = (id) =>
  DATA.strings[5000].list[id - 128] || (DATA.types.outf[id] ? 'outfit ' + id : null);

/* A "map" outfit (ModType 16, e.g. the Regional Map) isn't a kept item: buying it
 * charts the region — every system within its ModVal jumps of the current one. */
export const isMapOutfit = rules.isMapOutfit;
// Would buying this map here chart any system not already known? (Drives whether
// it's purchasable — once the region is explored there's nothing left to buy.)
export function mapRevealsSomething(o) {
  if (!isMapOutfit(o)) return false;
  for (const id of systemsWithinJumps(S.SYSTEM_ID, o.ModVal)) if (!explored.has(id)) return true;
  return false;
}

export function buyOutfit(id, qty) {
  const o = DATA.types.outf[id];
  if (!o) return;
  // Map outfits are one-shot region charts, not inventory (spec: "Outfitter").
  if (isMapOutfit(o)) {
    if (qty <= 0 || !wallet.canAfford(o.Cost)) return;
    const added = [];
    for (const sid of systemsWithinJumps(S.SYSTEM_ID, o.ModVal))
      if (!explored.has(sid)) added.push(sid);
    if (!added.length) return; // whole region already known → nothing to buy
    for (const sid of added) explored.add(sid);
    wallet.settle(o.Cost);
    showMsg(
      `${outfitName(id)}: charted ${added.length} nearby system${added.length > 1 ? 's' : ''}.`,
    );
    refreshView();
    return;
  }
  const s = effectiveShip();
  if (qty > 0) {
    if (o.Max > 0 && outfits.count(id) + qty > o.Max) qty = o.Max - outfits.count(id);
    if (o.Mass > 0) qty = Math.min(qty, Math.floor(s.freeMass / o.Mass));
    if (o.Cost > 0) qty = Math.min(qty, Math.floor(wallet.credits / o.Cost));
    if (qty <= 0) return;
  } else {
    qty = Math.max(qty, -outfits.count(id));
    if (qty === 0) return;
  }
  outfits.add(id, qty); // clamps at 0 and prunes an outfit that hits 0
  wallet.settle(qty * o.Cost); // buy (qty>0) charges, sell (qty<0) credits
  applyShipStats();
  // cargo can't exceed a shrunken hold: dump overflow (paid nothing for it),
  // leaving room for any mission cargo aboard.
  hold.clampTo(holds - missionCargoUsed());
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
    ([id, o]) => o.MissionBit < 0 && (techAvailable(o.TechLevel, p) || outfits.has(id)),
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
  return rules.tradeInValue(ships[S.playerShipId].Cost, outfits.entries(), (oid) =>
    DATA.types.outf[oid] ? DATA.types.outf[oid].Cost : 0,
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
  outfits.clear(); // old hull's upgrades are traded in
  applyShipStats();
  fuel.refill();
  preloadSprites(new Set([spinOfShip(id)]));
  showMsg(`${shipyardName(id)} purchased. Old hull and outfits traded in.`);
  refreshView();
}
