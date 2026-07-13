/*
 * engine/shell/ui/shops.js — the landed service dialogs' presentation: the
 * commodity exchange, outfitter and shipyard `render() → SafeHtml` functions,
 * plus the shared shop grid and wallet-line helpers.
 *
 * Logic (prices, buy/sell, stock/tech gating, trade-in) stays in 07-trade.js;
 * these read it and lay it out. Buttons carry `data-action` for the Dialog
 * delegation in ui/dialog.js — no inline handlers. Part of the flight shell
 * bundled by esbuild (entry: main.js); the logic/UI split is OOP_DESIGN.md's
 * "Separating UI from logic" (slice 1). Selection state lives on S
 * (S.selOutfitId / S.selShipId) so the select actions and these renderers share
 * it without a mutable cross-module binding — the outfitter/shipyard renderers
 * normalize it (clamp a stale/empty selection to the first item), so they are
 * not side-effect-free.
 */
import { S, hold, COMMODITIES, outfits, ships, wallet } from '../01-state.js';
import { html } from './html.js';
import { effectiveShip, holds } from '../04-combat.js';
import {
  cargoNames,
  cargoUsed,
  outfitName,
  outfitterStock,
  priceAt,
  shipyardName,
  shipyardStock,
  techAvailable,
  tradeInValue,
} from '../07-trade.js';

export const walletHtml = () => {
  const fm = effectiveShip().freeMass;
  return html`<div class="wallet"><b>${wallet.credits.toLocaleString('en-US')}</b> credits ·
    cargo ${cargoUsed()}/${holds} tons · ${fm} tons outfit space</div>
    <div style="margin-top:12px"><button class="svc" data-action="close">Done (Esc)</button></div>`;
};

export function renderExchange() {
  const p = S.landedAt,
    m = p.$sem || {};
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const price = priceAt(p, i);
    const held = hold.get(COMMODITIES[i]);
    if (price == null && !held) continue;
    // A spöb without price semantics still lists commodities the player is
    // carrying (price "—"); guard m.prices the way priceAt does so it can't throw.
    const lvl = m.prices && m.prices[COMMODITIES[i]];
    rows.push(html`<tr><td>${cargoNames[i]}${lvl ? html` <span class="meta" style="margin:0">(${lvl})</span>` : ''}</td>
      <td class="num">${price != null ? price + ' cr' : '—'}</td>
      <td class="num">${held}</td><td style="text-align:right">${
        price != null
          ? html`
        <button data-action="trade" data-arg="${i}:-10" ${held < 1 ? 'disabled' : ''}>-10</button>
        <button data-action="trade" data-arg="${i}:-1"  ${held < 1 ? 'disabled' : ''}>-1</button>
        <button data-action="trade" data-arg="${i}:1"   ${cargoUsed() >= holds || !wallet.canAfford(price) ? 'disabled' : ''}>+1</button>
        <button data-action="trade" data-arg="${i}:10"  ${cargoUsed() >= holds || !wallet.canAfford(price) ? 'disabled' : ''}>+10</button>`
          : ''
      }</td></tr>`);
  }
  return html`<h2>Commodity Exchange</h2>
    <div class="meta">${p.name} · prices per ton</div>
    <table><tr><th>Commodity</th><th style="text-align:right">Price</th>
    <th style="text-align:right">Held</th><th></th></tr>${rows}</table>${walletHtml()}`;
}

/* Classic shop layout. Menu-sheet thumbnails: outfit i (id−128) lives at
 * cell (i%8, ⌊i/8⌋) of PICT 6100; ships likewise in PICT 5100. Large
 * 100×100 dialog art: outfit → PICT 6000+i, ship → PICT 5000+i.
 *
 * Only items actually available here are shown — no empty or grayed slots (the
 * grid compacts; each thumbnail is still sliced from the item's fixed cell in
 * the original menu sheet). */
export function shopGrid(sheet, items, selId, clickFn) {
  const cells = items.map(({ id }) => {
    const i = id - 128;
    return html`<button class="cell${id === selId ? ' sel' : ''}"
      style="background-image:url(evassets/graphics/${sheet});
             background-position:-${(i % 8) * 32}px -${Math.floor(i / 8) * 32}px"
      data-action="${clickFn}" data-arg="${id}"></button>`;
  });
  return html`<div class="shopgrid">${cells}</div>`;
}

export function renderOutfitter() {
  const p = S.landedAt;
  const s = effectiveShip();
  const items = outfitterStock(p).map(([id]) => ({ id: +id }));
  if (S.selOutfitId == null || !items.some((x) => x.id === S.selOutfitId))
    S.selOutfitId = items.length ? items[0].id : null;

  let pane = '';
  if (S.selOutfitId != null) {
    const o = DATA.types.outf[S.selOutfitId];
    const own = outfits[S.selOutfitId] || 0;
    const canBuy =
      techAvailable(o.TechLevel, p) &&
      wallet.canAfford(o.Cost) &&
      (o.Max <= 0 || own < o.Max) &&
      (o.Mass <= 0 || s.freeMass >= o.Mass);
    pane = html`<div class="shoppane">
      <img src="evassets/graphics/PICT_${6000 + (S.selOutfitId - 128)}.png" onerror="this.style.visibility='hidden'">
      <h3>${outfitName(S.selOutfitId)}</h3>
      <div class="row">${o.$sem ? o.$sem.modType : ''}${o.Max > 0 ? ` · max ${o.Max}` : ''}</div>
      <div class="row">Cost: <b>${o.Cost.toLocaleString('en-US')}</b> cr</div>
      <div class="row">Mass: <b>${o.Mass}</b> tons</div>
      <div class="row">Owned: <b>${own}</b></div>
      <div style="margin-top:10px">
        <button class="svc" data-action="buyOutfit" data-arg="${S.selOutfitId}:1" ${canBuy ? '' : 'disabled'}>Buy</button>
        <button class="svc" data-action="buyOutfit" data-arg="${S.selOutfitId}:-1" ${own < 1 ? 'disabled' : ''}>Sell</button>
      </div></div>`;
  }
  return html`<h2>Outfitter</h2><div class="meta">${p.name} · tech ${p.TechLevel}</div>
     <div class="shop">${shopGrid('PICT_6100.png', items, S.selOutfitId, 'selectOutfit')}${pane}</div>${walletHtml()}`;
}

export function renderShipyard() {
  const p = S.landedAt;
  const refund = tradeInValue();
  const items = shipyardStock(p).map(([id]) => ({ id: +id }));
  if (S.selShipId == null || !items.some((x) => x.id === S.selShipId))
    S.selShipId = items.length ? items[0].id : null;

  let pane = '';
  if (S.selShipId != null) {
    const r = ships[S.selShipId];
    const own = S.selShipId === S.playerShipId;
    const net = r.Cost - refund;
    pane = html`<div class="shoppane">
      <img src="evassets/graphics/PICT_${5000 + (S.selShipId - 128)}.png" onerror="this.style.visibility='hidden'">
      <h3>${shipyardName(S.selShipId)}${own ? html` <span class="meta" style="margin:0">(current)</span>` : ''}</h3>
      <div class="row">Cost: <b>${r.Cost.toLocaleString('en-US')}</b> cr${own ? '' : html` · net <b>${net.toLocaleString('en-US')}</b>`}</div>
      <div class="row">Shield <b>${r.Shield}</b> · Armor <b>${r.Armor}</b></div>
      <div class="row">Speed <b>${r.Speed}</b> · Accel <b>${r.Accel}</b> · Turn <b>${r.Maneuver}</b></div>
      <div class="row">Cargo <b>${r.Holds}</b>t · Outfit space <b>${r.FreeMass}</b>t</div>
      <div class="row">Fuel <b>${r.Fuel / 100}</b> jumps · Crew <b>${r.Crew}</b></div>
      <div class="row">Guns <b>${r.MaxGun}</b> · Turrets <b>${r.MaxTur}</b></div>
      <div style="margin-top:10px">
        <button class="svc" data-action="buyShip" data-arg="${S.selShipId}" ${own || (net > 0 && !wallet.canAfford(net)) ? 'disabled' : ''}>Buy</button>
      </div></div>`;
  }
  return html`<h2>Shipyard</h2><div class="meta">${p.name} · tech ${p.TechLevel} ·
       trade-in: 25% of hull + upgrades (${refund.toLocaleString('en-US')} cr)</div>
     <div class="shop">${shopGrid('PICT_5100.png', items, S.selShipId, 'selectShip')}${pane}</div>${walletHtml()}`;
}
