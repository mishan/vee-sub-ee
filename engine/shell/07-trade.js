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
import { hireEscort, dismissEscort } from './02-spawning.js';
import { renderBar, renderComputer, doAcceptMission } from './16-missionboard.js';
import { renderPlanetScreen } from './14-landing.js';
import { Dialog } from './ui/dialog.js';
import { renderExchange, renderOutfitter, renderShipyard } from './ui/shops.js';

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

/* ---- service dialogs: exchange / outfitter / shipyard ---- */

/* A modal dialog View: the DOM-only `Dialog` base (render + mount/refresh/hide +
 * data-action delegation) plus `activeView` tracking. `activeView` is whichever
 * View is showing (null = none); the shell reads it to know a dialog is up
 * (pause the sim, swallow keys). */
export let activeView = null;
export class View extends Dialog {
  open() {
    activeView = this;
    super.open();
  }
  close() {
    if (activeView === this) activeView = null;
    super.close();
  }
}
export const refreshView = () => {
  if (activeView) activeView.refresh();
};

/* Actions for the mission board / hire dialog (16-missionboard renders its
 * buttons with data-action=…; the Dialog delegation routes them here). */
const boardActions = {
  selMisn: (id) => {
    S.selMisnId = +id;
    refreshView();
  },
  accept: () => doAcceptMission(S.selMisnId),
  barTab: (k) => {
    S.barTab = k;
    refreshView();
  },
  close: () => closeService(),
  hire: (id) => hireEscort(+id),
  dismiss: (id) => dismissEscort(+id),
};

/* Actions for the exchange / outfitter / shipyard dialogs. Two-value buttons
 * (trade, buyOutfit) encode data-arg="a:b" and split it here. */
const pair = (arg) => arg.split(':').map(Number);
const shopActions = {
  close: () => closeService(),
  trade: (arg) => trade(...pair(arg)),
  selectOutfit: (id) => selectOutfit(+id),
  buyOutfit: (arg) => buyOutfit(...pair(arg)),
  selectShip: (id) => selectShip(+id),
  buyShip: (id) => buyShip(+id),
};

// The five landing-screen services share the one 'service' panel; each is a View
// over a pure render function (renderExchange/… below and in 16-missionboard.js).
export const SERVICE_VIEWS = {
  exchange: new View('service', 'serviceCard', renderExchange, shopActions),
  outfitter: new View('service', 'serviceCard', renderOutfitter, shopActions),
  shipyard: new View('service', 'serviceCard', renderShipyard, shopActions),
  bar: new View('service', 'serviceCard', renderBar, boardActions),
  missioncomputer: new View('service', 'serviceCard', renderComputer, boardActions),
};
export function openService(kind) {
  const gate = {
    exchange: 'commodityExchange',
    outfitter: 'outfitter',
    shipyard: 'shipyard',
    bar: 'bar',
    missioncomputer: 'canLand',
  }[kind];
  if (!S.landedAt || !(S.landedAt.$sem && S.landedAt.$sem[gate])) return;
  if (kind === 'outfitter' && !outfitterStock(S.landedAt).length) return;
  if (kind === 'shipyard' && !shipyardStock(S.landedAt).length) return;
  SERVICE_VIEWS[kind].open();
}
export function closeService() {
  if (activeView) activeView.close();
  renderPlanetScreen(); // refresh wallet line
}
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
