import { missionLog, wallet, S, escorts, ships, savePilot, showMsg } from '../01-state.js';
import { html } from './html.js';
import { HIRE_ROSTER, MAX_ESCORTS, hireFee, shipClassDesc, upkeepOf } from '../02-spawning.js';
import { holds } from '../04-combat.js';
import { cargoUsed } from '../07-trade.js';
import { shopGrid } from './shops.js';
import { cargoNeededToAccept } from '../mission-cargo.js';
import { refreshView } from './dialog.js';
import {
  offeredMissions,
  misns,
  misnName,
  getOffer,
  descText,
  formatDate,
  systOfSpob,
  spobById,
  stelName,
  acceptMission,
} from '../08-missions.js';

/*
 * engine/shell/ui/missionboard.js — spaceport bar / mission computer board and
 * the hire-escorts dialog (presentation). The service-dialog registry in
 * ui/services.js points `bar`/`missioncomputer` at renderBar/renderComputer
 * here; mission *logic* (availability, accept, goals) stays in 08-missions.js.
 * Part of the flight shell bundled by esbuild (entry: main.js).
 */

S.selMisnId = null;

export function renderMissionBoard(loc, topHtml = '') {
  // loc 0 = computer, 1 = bar
  const p = S.landedAt;
  const offers = offeredMissions(p, loc);
  const active = missionLog.list;
  if (S.selMisnId == null || !offers.some((o) => o.id === S.selMisnId))
    S.selMisnId = offers.length ? offers[0].id : null;
  const sel = S.selMisnId != null ? misns[S.selMisnId] : null;

  const listItems = [];
  if (active.length) {
    listItems.push(html`<div class="meta" style="margin:0 0 4px">Active missions</div>`);
    for (const a of active) {
      const days =
        a.timeLimit > 0
          ? html` <span class="sub">(${Math.max(0, a.timeLimit - (S.gameDay - a.accepted))}d left)</span>`
          : '';
      listItems.push(
        html`<div class="row" style="color:#98c379">${misnName(misns[a.id], a)}${days}</div>`,
      );
    }
    listItems.push(html`<hr style="border-color:#26304a;margin:8px 0">`);
  }
  listItems.push(
    html`<div class="meta" style="margin:0 0 4px">Available here (${offers.length})</div>`,
  );
  if (!offers.length) listItems.push(html`<div class="sub">Nothing right now.</div>`);
  for (const o of offers)
    listItems.push(html`<div class="row" style="cursor:pointer;color:${o.id === S.selMisnId ? '#ffd479' : '#cfd6e4'}"
      data-action="selMisn" data-arg="${o.id}">${misnName(o, getOffer(o.id, p))}</div>`);
  const list = html`<div style="flex:1;min-width:210px;max-height:340px;overflow-y:auto">${listItems}</div>`;

  let paneBody;
  if (sel) {
    const offer = getOffer(S.selMisnId, p); // resolved once, stable
    const brief =
      descText(sel.BriefText, offer) ||
      descText(sel.QuickBrief, offer) ||
      'No further details are offered.';
    const pay =
      sel.PayVal > 0
        ? `${sel.PayVal.toLocaleString('en-US')} cr`
        : sel.PayVal <= -20128 && sel.PayVal >= -20255
          ? 'an outfit'
          : 'see briefing';
    const goalTxt =
      ['Destroy the ships', null, 'Board', 'Escort', 'Observe', 'Rescue', 'Drive off the ships'][
        sel.ShipGoal
      ] || null;
    // Delivery missions go to the destination; return-only missions come back here.
    const destId = offer.travelStel != null ? offer.travelStel : offer.returnStel;
    const destShown =
      destId != null
        ? `${stelName(destId)}${systOfSpob(spobById(destId)) ? ' (' + systOfSpob(spobById(destId)).name + ')' : ''}` +
          (destId === p.id ? ' — return here' : '')
        : 'no fixed destination';
    paneBody = html`<h3>${misnName(sel, offer)}</h3>
      <div class="desc" style="max-height:150px;overflow-y:auto">${brief}</div>
      <div class="row">Destination: <b>${destShown}</b></div>
      ${offer.cargoName && offer.cargoQty ? html`<div class="row">Cargo: <b>${offer.cargoQty}t ${offer.cargoName}</b></div>` : ''}
      ${sel.ShipCount > 0 && goalTxt ? html`<div class="row">Objective: <b>${goalTxt}</b> (${sel.ShipCount})</div>` : ''}
      ${offer.deadline != null ? html`<div class="row">Deliver by: <b>${formatDate(offer.deadline)}</b> <span class="sub">(${sel.TimeLimit} days)</span></div>` : ''}
      <div class="row">Pay: <b>${pay}</b></div>
      <div style="margin-top:10px">
        <button class="svc" data-action="accept">Accept</button>
      </div>`;
  } else if (active.length) {
    paneBody = html`<div class="sub">Select an available mission, or check your active missions (press I in flight for the briefing).</div>`;
  } else {
    paneBody = html`<div class="sub">No missions are available here right now. Try the ${loc === 0 ? 'bar' : 'mission computer'}, or another world.</div>`;
  }
  const pane = html`<div style="flex:1.3;min-width:240px">${paneBody}</div>`;

  return html`<h2>${loc === 0 ? 'Mission Computer' : 'Spaceport Bar'}</h2>
     <div class="meta">${p.name}</div>${topHtml}
     <div class="shop">${list}${pane}</div>
     <div class="wallet">${wallet.credits.toLocaleString('en-US')} credits · cargo ${cargoUsed()}/${holds} tons · day ${S.gameDay}</div>
     <div style="margin-top:10px"><button class="svc" data-action="close">Done (Esc)</button></div>`;
}

/* The Spaceport Bar (spec: "Spaceport bar"). Unlike the mission computer it has
 * no browsable mission list: on entry each available bar mission is offered as a
 * modal briefing with Accept / Not interested (the queue is filled in
 * openService); once the offers are dealt with, the bar shows the hire-escorts
 * board. */
S.barOffers = null; // queue of mission ids still to offer this visit
export function renderBar() {
  return S.barOffers && S.barOffers.length ? renderBarOffer(S.barOffers[0]) : renderHireBoard();
}
export function renderComputer() {
  return renderMissionBoard(0);
}

/* One bar patron's job offer: the briefing text + Accept / Not interested, shown
 * one at a time as the player enters the bar (like the original). */
function renderBarOffer(id) {
  const p = S.landedAt;
  const m = misns[id];
  const offer = getOffer(id, p);
  const brief =
    descText(m.BriefText, offer) ||
    descText(m.QuickBrief, offer) ||
    'A patron offers you a job, but says little about it.';
  const pay =
    m.PayVal > 0
      ? `${m.PayVal.toLocaleString('en-US')} cr`
      : m.PayVal <= -20128 && m.PayVal >= -20255
        ? 'an outfit'
        : 'see briefing';
  const goalTxt =
    ['Destroy the ships', null, 'Board', 'Escort', 'Observe', 'Rescue', 'Drive off the ships'][
      m.ShipGoal
    ] || null;
  const destId = offer.travelStel != null ? offer.travelStel : offer.returnStel;
  const destShown =
    destId != null
      ? `${stelName(destId)}${systOfSpob(spobById(destId)) ? ' (' + systOfSpob(spobById(destId)).name + ')' : ''}` +
        (destId === p.id ? ' — return here' : '')
      : 'no fixed destination';
  const more = S.barOffers.length - 1;
  return html`<h2>Spaceport Bar</h2><div class="meta">${p.name}</div>
    <div class="shoppane" style="float:none;width:auto">
      <h3>${misnName(m, offer)}</h3>
      <div class="desc" style="max-height:190px;overflow-y:auto">${brief}</div>
      <div class="row">Destination: <b>${destShown}</b></div>
      ${offer.cargoName && offer.cargoQty ? html`<div class="row">Cargo: <b>${offer.cargoQty}t ${offer.cargoName}</b></div>` : ''}
      ${m.ShipCount > 0 && goalTxt ? html`<div class="row">Objective: <b>${goalTxt}</b> (${m.ShipCount})</div>` : ''}
      ${offer.deadline != null ? html`<div class="row">Deliver by: <b>${formatDate(offer.deadline)}</b> <span class="sub">(${m.TimeLimit} days)</span></div>` : ''}
      <div class="row">Pay: <b>${pay}</b></div>
      <div style="margin-top:12px">
        <button class="svc" data-action="acceptOffer">Accept</button>
        <button class="svc" data-action="declineOffer">Not interested</button>
      </div>
      ${more > 0 ? html`<div class="sub" style="margin-top:8px">${more} other patron${more > 1 ? 's' : ''} waiting to talk to you.</div>` : ''}
    </div>
    <div class="wallet">${wallet.credits.toLocaleString('en-US')} credits · cargo ${cargoUsed()}/${holds} tons · day ${S.gameDay}</div>`;
}

/* Accept the current bar offer (with the same cargo-space check the computer
 * uses), then advance to the next patron. */
export function acceptBarOffer() {
  const id = S.barOffers[0];
  if (id == null) return;
  const need = cargoNeededToAccept(misns[id], getOffer(id, S.landedAt));
  if (need > holds - cargoUsed()) {
    showMsg('Not enough cargo space for this mission.');
    return;
  }
  acceptMission(id, S.landedAt);
  savePilot(S.landedAt.id);
  S.barOffers.shift();
  refreshView();
}
export function declineBarOffer() {
  if (S.barOffers && S.barOffers.length) S.barOffers.shift();
  refreshView();
}

/* Hire escorts, laid out like the shipyard (spec: "Escorts for hire"): a grid of
 * hireable ships + a detail pane with the ship's stats, its escort/class
 * description (dësc 2000+i) and a Hire button; the player's current fleet (with
 * Dismiss) sits below. */
export function renderHireBoard() {
  const p = S.landedAt;
  const totalUpkeep = escorts.reduce((n, e) => n + (e.upkeep || 0), 0);
  const items = HIRE_ROSTER.filter((id) => ships[id]).map((id) => ({ id }));
  if (S.selEscortId == null || !items.some((x) => x.id === S.selEscortId))
    S.selEscortId = items.length ? items[0].id : null;

  let pane = '';
  if (S.selEscortId != null) {
    const r = ships[S.selEscortId];
    const fee = hireFee(r),
      up = upkeepOf(r);
    const full = escorts.length >= MAX_ESCORTS,
      afford = wallet.canAfford(fee);
    pane = html`<div class="shoppane">
      <img src="evassets/graphics/PICT_${5000 + (S.selEscortId - 128)}.png" onerror="this.style.visibility='hidden'">
      <h3>${r.name}</h3>
      <div class="row">Hire fee: <b>${fee.toLocaleString('en-US')}</b> cr · <b>${up.toLocaleString('en-US')}</b> cr/jump</div>
      <div class="row">Shield <b>${r.Shield}</b> · Armor <b>${r.Armor}</b></div>
      <div class="row">Speed <b>${r.Speed}</b> · Accel <b>${r.Accel}</b> · Turn <b>${r.Maneuver}</b></div>
      <div class="row">Guns <b>${r.MaxGun}</b> · Turrets <b>${r.MaxTur}</b></div>
      <div class="desc">${shipClassDesc(S.selEscortId)}</div>
      <div style="margin-top:10px">
        <button class="svc" data-action="hire" data-arg="${S.selEscortId}" ${full || !afford ? 'disabled' : ''}>Hire${
          full ? ' · fleet full' : !afford ? ' · can’t afford' : ''
        }</button>
      </div></div>`;
  }

  const fleetItems = [];
  if (!escorts.length) fleetItems.push(html`<div class="sub">No escorts hired.</div>`);
  for (const e of escorts) {
    const r = ships[e.shipId],
      kind = e.upkeep ? `~${e.upkeep.toLocaleString('en-US')} cr/jump` : 'captured';
    fleetItems.push(html`<div class="row" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span>${e.name} <span class="sub">${r ? r.name : ''} · ${kind}</span></span>
      <button class="svc" style="padding:2px 8px" data-action="dismiss" data-arg="${e.id}">Dismiss</button></div>`);
  }

  return html`<h2>Spaceport Bar</h2>
     <div class="meta">${p.name} · fleet ${escorts.length}/${MAX_ESCORTS}${totalUpkeep ? ` · payroll ${totalUpkeep.toLocaleString('en-US')} cr/jump` : ''}</div>
     <div class="shop">${shopGrid(5000, items, S.selEscortId, 'selectEscort', (id) => ships[id].name)}${pane}</div>
     <div style="margin-top:12px"><div class="meta" style="margin:0 0 4px">Your fleet</div>${fleetItems}</div>
     <div class="wallet">${wallet.credits.toLocaleString('en-US')} credits</div>
     <div style="margin-top:10px"><button class="svc" data-action="close">Done (Esc)</button></div>`;
}

export function doAcceptMission(id) {
  // Check for exactly the cargo acceptMission will load: the resolved offer the
  // briefing showed (cargoNeededToAccept), NOT a fresh reading of the raw
  // template. getOffer rolls a random-cargo mission (CargoQty ≤ −2) to
  // abs(CargoQty)×(0.5–1.5), so the old abs(CargoQty) over-counted low rolls and
  // falsely rejected missions that actually fit. getOffer is cached per offer,
  // so this is the same resolution the player saw and that will be loaded.
  const m = misns[id];
  const need = cargoNeededToAccept(m, getOffer(id, S.landedAt));
  if (need > holds - cargoUsed()) {
    showMsg('Not enough cargo space for this mission.');
    return;
  }
  acceptMission(id, S.landedAt);
  savePilot(S.landedAt.id);
  refreshView();
}
