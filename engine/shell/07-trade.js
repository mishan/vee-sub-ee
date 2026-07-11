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
  return `<div class="wallet"><b>${credits.toLocaleString('en-US')}</b> credits ·
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
  let html = `<h2>Commodity Exchange</h2>
    <div class="meta">${escapeHtml(p.name)} · prices per ton</div>
    <table><tr><th>Commodity</th><th style="text-align:right">Price</th>
    <th style="text-align:right">Held</th><th></th></tr>`;
  for (let i = 0; i < 6; i++) {
    const price = priceAt(p, i);
    const held = cargo[COMMODITIES[i]];
    if (price == null && !held) continue;
    const lvl = m.prices[COMMODITIES[i]];
    html += `<tr><td>${cargoNames[i]}${lvl ? ` <span class="meta" style="margin:0">(${lvl})</span>` : ''}</td>
      <td class="num">${price != null ? price + ' cr' : '—'}</td>
      <td class="num">${held}</td><td style="text-align:right">` +
      (price != null ? `
        <button onclick="trade(${i},-10)" ${held < 1 ? 'disabled' : ''}>-10</button>
        <button onclick="trade(${i},-1)"  ${held < 1 ? 'disabled' : ''}>-1</button>
        <button onclick="trade(${i},1)"   ${cargoUsed() >= holds || credits < price ? 'disabled' : ''}>+1</button>
        <button onclick="trade(${i},10)"  ${cargoUsed() >= holds || credits < price ? 'disabled' : ''}>+10</button>`
      : '') + `</td></tr>`;
  }
  html += `</table>` + walletHtml();
  document.getElementById('serviceCard').innerHTML = html;
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

