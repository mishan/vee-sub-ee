import { S, html, escorts, ships, savePilot, showMsg } from './01-state.js';
import { HIRE_ROSTER, MAX_ESCORTS, hireFee, shipClassDesc, upkeepOf } from './02-spawning.js';
import { holds } from './04-combat.js';
import { cargoUsed, refreshView } from './07-trade.js';
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
} from './08-missions.js';

/*
 * engine/shell/16-missionboard.js — spaceport bar / mission computer board and
 * the hire-escorts dialog. The service-dialog View registry (07-trade) points
 * `bar`/`missioncomputer` at renderBar/renderComputer here; mission *logic*
 * (availability, accept, goals) stays in 08-missions.js. Part of the flight
 * shell bundled by esbuild (entry: main.js); 01-state holds the shared state S.
 */

S.selMisnId = null;

export function renderMissionBoard(loc, topHtml = '') {
  // loc 0 = computer, 1 = bar
  const p = S.landedAt;
  const offers = offeredMissions(p, loc);
  const active = S.activeMissions;
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
     <div class="wallet">${S.credits.toLocaleString('en-US')} credits · cargo ${cargoUsed()}/${holds} tons · day ${S.gameDay}</div>
     <div style="margin-top:10px"><button class="svc" data-action="close">Done (Esc)</button></div>`;
}

/* The bar hosts two boards — the mission BBS and the hire-escort dialog —
 * toggled by a pair of tabs (spec: "Escorts for hire"). */
S.barTab = 'missions';
export function barTabs() {
  const t = (k, label) =>
    html`<button class="svc" data-action="barTab" data-arg="${k}"${S.barTab === k ? ' disabled' : ''}>${label}</button>`;
  return html`<div style="margin:6px 0 2px">${t('missions', 'Missions')} ${t('hire', 'Hire Escorts')}</div>`;
}
export function renderBar() {
  return S.barTab === 'hire' ? renderHireBoard() : renderMissionBoard(1, barTabs());
}
export function renderComputer() {
  return renderMissionBoard(0);
}

export function renderHireBoard() {
  const p = S.landedAt;
  const totalUpkeep = escorts.reduce((n, e) => n + (e.upkeep || 0), 0);

  const fleetItems = [];
  if (!escorts.length) fleetItems.push(html`<div class="sub">You have no escorts yet.</div>`);
  for (const e of escorts) {
    const r = ships[e.shipId],
      kind = e.upkeep ? `~${e.upkeep.toLocaleString('en-US')} cr/jump` : 'captured';
    fleetItems.push(html`<div class="row" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span>${e.name} <span class="sub">${r ? r.name : ''} · ${kind}</span></span>
      <button class="svc" style="padding:2px 8px" data-action="dismiss" data-arg="${e.id}">Dismiss</button></div>`);
  }
  if (totalUpkeep)
    fleetItems.push(
      html`<div class="row sub" style="margin-top:6px">Payroll: ~${totalUpkeep.toLocaleString('en-US')} cr / jump</div>`,
    );
  const fleet = html`<div style="flex:1;min-width:210px;max-height:340px;overflow-y:auto">
    <div class="meta" style="margin:0 0 4px">Your fleet (${escorts.length}/${MAX_ESCORTS})</div>${fleetItems}</div>`;

  const hireItems = [];
  for (const id of HIRE_ROSTER) {
    const r = ships[id];
    if (!r) continue;
    const fee = hireFee(r),
      up = upkeepOf(r);
    const full = escorts.length >= MAX_ESCORTS,
      afford = S.credits >= fee;
    const desc = shipClassDesc(id);
    hireItems.push(html`<div class="row" style="border-bottom:1px solid #26304a;padding:6px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b>${r.name}</b>
        <button class="svc" style="padding:2px 10px" data-action="hire" data-arg="${id}"${full || !afford ? ' disabled' : ''}>Hire</button>
      </div>
      <div class="sub">Fee ~${fee.toLocaleString('en-US')} cr · ~${up.toLocaleString('en-US')} cr/jump${
        full ? ' · fleet full' : !afford ? ' · can’t afford' : ''
      }</div>${
        desc
          ? html`<div class="sub" style="margin-top:3px;max-height:64px;overflow-y:auto">${desc}</div>`
          : ''
      }</div>`);
  }
  const hire = html`<div style="flex:1.3;min-width:240px;max-height:340px;overflow-y:auto">
    <div class="meta" style="margin:0 0 4px">Pilots for hire</div>${hireItems}</div>`;

  return html`<h2>Spaceport Bar</h2><div class="meta">${p.name}</div>${barTabs()}
     <div class="shop">${fleet}${hire}</div>
     <div class="wallet">${S.credits.toLocaleString('en-US')} credits · payroll ${totalUpkeep.toLocaleString('en-US')} cr/jump</div>
     <div style="margin-top:10px"><button class="svc" data-action="close">Done (Esc)</button></div>`;
}

export function doAcceptMission(id) {
  const m = misns[id];
  const need =
    m.CargoType >= 0 && m.CargoQty && m.PickupMode === 0
      ? m.CargoQty <= -2
        ? Math.abs(m.CargoQty)
        : m.CargoQty
      : 0;
  if (need > holds - cargoUsed()) {
    showMsg('Not enough cargo space for this mission.');
    return;
  }
  acceptMission(id, S.landedAt);
  savePilot(S.landedAt.id);
  refreshView();
}
