/*
 * engine/shell/ui/services.js — the landed-services dialog registry: which
 * `View` each spaceport service maps to, the button actions those dialogs
 * delegate to, and open/close.
 *
 * The `View`/`Dialog` framework itself is the leaf in ui/dialog.js (kept
 * import-free so any dialog can construct at init); this module is the concrete
 * wiring that pulls the renderers (ui/shops, ui/missionboard) and the logic they
 * act on (07-trade, 02-spawning) together. Lifted out of 07-trade per
 * OOP_DESIGN.md's "Separating UI from logic" (slice 2).
 */
import { S } from '../01-state.js';
import { View, activeView, refreshView } from './dialog.js';
import { renderExchange, renderOutfitter, renderShipyard } from './shops.js';
import { renderBar, renderComputer, doAcceptMission } from './missionboard.js';
import {
  trade,
  selectOutfit,
  buyOutfit,
  selectShip,
  buyShip,
  outfitterStock,
  shipyardStock,
} from '../07-trade.js';
import { hireEscort, dismissEscort } from '../02-spawning.js';

/* Actions for the mission board / hire dialog (ui/missionboard renders its
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
// over a pure render function (renderExchange/… from ui/shops + ui/missionboard).
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
  // Notify the landing screen to refresh (its wallet line may have changed).
  // A DOM event instead of importing 14-landing keeps this module free of a
  // cycle with the landing screen (14-landing imports open/closeService).
  document.dispatchEvent(new Event('ve:serviceclosed'));
}
