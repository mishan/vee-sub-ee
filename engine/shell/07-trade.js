/*
 * engine/shell/07-trade.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---- trading (spec: "Trading") ---- */

const cargoNames = DATA.strings[4000].list.slice(0, 6);
const basePrices = DATA.strings[4004].list.slice(0, 6).map(Number);
const missionCargoUsed = () => activeMissions.reduce((n, a) => n + (a.cargoLoaded ? a.cargoQty : 0), 0);
const cargoUsed = () => COMMODITIES.reduce((n, c) => n + cargo[c], 0) + missionCargoUsed();

function priceAt(spob, i) {
  const lvl = spob.$sem && spob.$sem.prices[COMMODITIES[i]];
  return lvl && PRICE_MULT[lvl] ? Math.round(basePrices[i] * PRICE_MULT[lvl]) : null;
}
function trade(i, qty) {
  if (!landedAt) return;
  const price = priceAt(landedAt, i);
  if (price == null) return;
  if (qty > 0) qty = Math.min(qty, holds - cargoUsed(), Math.floor(credits / price));
  else qty = Math.max(qty, -cargo[COMMODITIES[i]]);
  cargo[COMMODITIES[i]] += qty;
  credits -= qty * price;
  rerenderService();
}

/* ---- service dialogs: exchange / outfitter / shipyard ---- */

let serviceOpen = null; // 'exchange' | 'outfitter' | 'shipyard' | 'bar' | 'missioncomputer' | null
const SERVICE_RENDER = {};
function openService(kind) {
  const gate = { exchange: 'commodityExchange', outfitter: 'outfitter', shipyard: 'shipyard',
    bar: 'bar', missioncomputer: 'canLand' }[kind];
  if (!landedAt || !(landedAt.$sem && landedAt.$sem[gate])) return;
  if (kind === 'outfitter' && !outfitterStock(landedAt).length) return;
  if (kind === 'shipyard' && !shipyardStock(landedAt).length) return;
  serviceOpen = kind;
  SERVICE_RENDER[kind]();
  document.getElementById('service').style.display = 'flex';
}
function closeService() {
  serviceOpen = null;
  document.getElementById('service').style.display = 'none';
  renderPlanetScreen(); // refresh wallet line
}
function rerenderService() { if (serviceOpen) SERVICE_RENDER[serviceOpen](); }
const walletHtml = () => {
  const fm = effectiveShip().freeMass;
  return html`<div class="wallet"><b>${credits.toLocaleString('en-US')}</b> credits ·
    cargo ${cargoUsed()}/${holds} tons · ${fm} tons outfit space</div>
    <div style="margin-top:12px"><button class="svc" onclick="closeService()">Done (Esc)</button></div>`;
};

/* tech availability (spec: spöb TechLevel gate + SpecialTech exact match) */
function techAvailable(itemTech, p) {
  if (itemTech <= p.TechLevel) return true;
  return [p.SpecialTech1, p.SpecialTech2, p.SpecialTech3].includes(itemTech);
}

SERVICE_RENDER.exchange = function () {
  const p = landedAt, m = p.$sem || {};
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const price = priceAt(p, i);
    const held = cargo[COMMODITIES[i]];
    if (price == null && !held) continue;
    const lvl = m.prices[COMMODITIES[i]];
    rows.push(html`<tr><td>${cargoNames[i]}${lvl ? html` <span class="meta" style="margin:0">(${lvl})</span>` : ''}</td>
      <td class="num">${price != null ? price + ' cr' : '—'}</td>
      <td class="num">${held}</td><td style="text-align:right">${price != null ? html`
        <button onclick="trade(${i},-10)" ${held < 1 ? 'disabled' : ''}>-10</button>
        <button onclick="trade(${i},-1)"  ${held < 1 ? 'disabled' : ''}>-1</button>
        <button onclick="trade(${i},1)"   ${cargoUsed() >= holds || credits < price ? 'disabled' : ''}>+1</button>
        <button onclick="trade(${i},10)"  ${cargoUsed() >= holds || credits < price ? 'disabled' : ''}>+10</button>` : ''}</td></tr>`);
  }
  document.getElementById('serviceCard').innerHTML = html`<h2>Commodity Exchange</h2>
    <div class="meta">${p.name} · prices per ton</div>
    <table><tr><th>Commodity</th><th style="text-align:right">Price</th>
    <th style="text-align:right">Held</th><th></th></tr>${rows}</table>${walletHtml()}`;
};

/* ---- outfitter ---- */

const outfitName = id => DATA.strings[5000].list[id - 128] ||
  (DATA.types.outf[id] ? 'outfit ' + id : null);

function buyOutfit(id, qty) {
  const o = DATA.types.outf[id];
  if (!o) return;
  const s = effectiveShip();
  if (qty > 0) {
    if (o.Max > 0 && (outfits[id] || 0) + qty > o.Max) qty = o.Max - (outfits[id] || 0);
    if (o.Mass > 0) qty = Math.min(qty, Math.floor(s.freeMass / o.Mass));
    if (o.Cost > 0) qty = Math.min(qty, Math.floor(credits / o.Cost));
    if (qty <= 0) return;
  } else {
    qty = Math.max(qty, -(outfits[id] || 0));
    if (qty === 0) return;
  }
  outfits[id] = (outfits[id] || 0) + qty;
  if (!outfits[id]) delete outfits[id];
  credits -= qty * o.Cost;
  applyShipStats();
  // cargo can't exceed a shrunken hold: dump overflow (paid nothing for it)
  while (cargoUsed() > holds) {
    const c = COMMODITIES.find(c => cargo[c] > 0);
    if (!c) break;
    cargo[c]--;
  }
  rerenderService();
}

/* Classic shop layout. Menu-sheet thumbnails: outfit i (id−128) lives at
 * cell (i%8, ⌊i/8⌋) of PICT 6100; ships likewise in PICT 5100. Large
 * 100×100 dialog art: outfit → PICT 6000+i, ship → PICT 5000+i. */
let selOutfitId = null, selShipId = null;

/* Only items actually available here are shown — no empty or grayed
 * slots (the grid compacts; each thumbnail is still sliced from the
 * item's fixed cell in the original menu sheet). */
function shopGrid(sheet, items, selId, clickFn) {
  const cells = items.map(({ id }) => {
    const i = id - 128;
    return html`<button class="cell${id === selId ? ' sel' : ''}"
      style="background-image:url(evassets/graphics/${sheet});
             background-position:-${(i % 8) * 32}px -${Math.floor(i / 8) * 32}px"
      onclick="${clickFn}(${id})"></button>`;
  });
  return html`<div class="shopgrid">${cells}</div>`;
}

/* Would this spob's shop have anything to show? Gates both the dialog
 * and the button on the landing screen. */
function outfitterStock(p) {
  return Object.entries(DATA.types.outf).filter(([id, o]) =>
    o.MissionBit < 0 && (techAvailable(o.TechLevel, p) || (outfits[id] || 0) > 0));
}
function shipyardStock(p) {
  return Object.entries(ships).filter(([, r]) =>
    r.MissionBit < 0 && techAvailable(r.TechLevel, p));
}

function selectOutfit(id) { selOutfitId = id; rerenderService(); }
function selectShip(id) { selShipId = id; rerenderService(); }

SERVICE_RENDER.outfitter = function () {
  const p = landedAt;
  const s = effectiveShip();
  const items = outfitterStock(p).map(([id]) => ({ id: +id }));
  if (selOutfitId == null || !items.some(x => x.id === selOutfitId))
    selOutfitId = items.length ? items[0].id : null;

  let pane = '';
  if (selOutfitId != null) {
    const o = DATA.types.outf[selOutfitId];
    const own = outfits[selOutfitId] || 0;
    const canBuy = techAvailable(o.TechLevel, p) &&
      credits >= o.Cost && (o.Max <= 0 || own < o.Max) &&
      (o.Mass <= 0 || s.freeMass >= o.Mass);
    pane = html`<div class="shoppane">
      <img src="evassets/graphics/PICT_${6000 + (selOutfitId - 128)}.png" onerror="this.style.visibility='hidden'">
      <h3>${outfitName(selOutfitId)}</h3>
      <div class="row">${o.$sem ? o.$sem.modType : ''}${o.Max > 0 ? ` · max ${o.Max}` : ''}</div>
      <div class="row">Cost: <b>${o.Cost.toLocaleString('en-US')}</b> cr</div>
      <div class="row">Mass: <b>${o.Mass}</b> tons</div>
      <div class="row">Owned: <b>${own}</b></div>
      <div style="margin-top:10px">
        <button class="svc" onclick="buyOutfit(${selOutfitId},1)" ${canBuy ? '' : 'disabled'}>Buy</button>
        <button class="svc" onclick="buyOutfit(${selOutfitId},-1)" ${own < 1 ? 'disabled' : ''}>Sell</button>
      </div></div>`;
  }
  document.getElementById('serviceCard').innerHTML =
    html`<h2>Outfitter</h2><div class="meta">${p.name} · tech ${p.TechLevel}</div>
     <div class="shop">${shopGrid('PICT_6100.png', items, selOutfitId, 'selectOutfit')}${pane}</div>${walletHtml()}`;
};

/* ---- shipyard ---- */

const shipyardName = id => DATA.strings[5001].list[id - 128] ||
  (ships[id] ? ships[id].name : null);

/* Trade-in per the resource bible: "the cost of buying a ship is always
 * the cost of the new ship minus 25% of the original cost of your current
 * ship and upgrades." */
function tradeInValue() {
  return Math.round(0.25 * (ships[playerShipId].Cost +
    Object.entries(outfits).reduce((n, [oid, c]) =>
      n + (DATA.types.outf[oid] ? DATA.types.outf[oid].Cost * c : 0), 0)));
}
function buyShip(id) {
  const rec = ships[id];
  if (!rec || id === playerShipId) return;
  const refund = tradeInValue();
  const price = rec.Cost - refund;
  if (credits < price) return;
  if (cargoUsed() > rec.Holds) { showMsg('Your cargo would not fit aboard.'); return; }
  credits -= price;
  playerShipId = id;
  player.shipId = id;
  for (const k of Object.keys(outfits)) delete outfits[k];
  applyShipStats();
  fuel = fuelMax;
  preloadSprites(new Set([spinOfShip(id)]));
  showMsg(`${shipyardName(id)} purchased. Old hull and outfits traded in.`);
  rerenderService();
}

SERVICE_RENDER.shipyard = function () {
  const p = landedAt;
  const refund = tradeInValue();
  const items = shipyardStock(p).map(([id]) => ({ id: +id }));
  if (selShipId == null || !items.some(x => x.id === selShipId))
    selShipId = items.length ? items[0].id : null;

  let pane = '';
  if (selShipId != null) {
    const r = ships[selShipId];
    const own = selShipId === playerShipId;
    const net = r.Cost - refund;
    pane = html`<div class="shoppane">
      <img src="evassets/graphics/PICT_${5000 + (selShipId - 128)}.png" onerror="this.style.visibility='hidden'">
      <h3>${shipyardName(selShipId)}${own ? html` <span class="meta" style="margin:0">(current)</span>` : ''}</h3>
      <div class="row">Cost: <b>${r.Cost.toLocaleString('en-US')}</b> cr${own ? '' : html` · net <b>${net.toLocaleString('en-US')}</b>`}</div>
      <div class="row">Shield <b>${r.Shield}</b> · Armor <b>${r.Armor}</b></div>
      <div class="row">Speed <b>${r.Speed}</b> · Accel <b>${r.Accel}</b> · Turn <b>${r.Maneuver}</b></div>
      <div class="row">Cargo <b>${r.Holds}</b>t · Outfit space <b>${r.FreeMass}</b>t</div>
      <div class="row">Fuel <b>${r.Fuel / 100}</b> jumps · Crew <b>${r.Crew}</b></div>
      <div class="row">Guns <b>${r.MaxGun}</b> · Turrets <b>${r.MaxTur}</b></div>
      <div style="margin-top:10px">
        <button class="svc" onclick="buyShip(${selShipId})" ${own || credits < net ? 'disabled' : ''}>Buy</button>
      </div></div>`;
  }
  document.getElementById('serviceCard').innerHTML =
    html`<h2>Shipyard</h2><div class="meta">${p.name} · tech ${p.TechLevel} ·
       trade-in: 25% of hull + upgrades (${refund.toLocaleString('en-US')} cr)</div>
     <div class="shop">${shopGrid('PICT_5100.png', items, selShipId, 'selectShip')}${pane}</div>${walletHtml()}`;
};

