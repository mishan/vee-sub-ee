/*
 * engine/shell/ui/hail.js — the hail/comm modal's presentation: the dialog body
 * (ship / boarding / planet variants + the ship-offer panel), the button-action
 * map, and the `Dialog` instance + re-render.
 *
 * Interaction *logic and state* — openHail/closeHail/hailOpen, target cycling,
 * the comm outcomes (pay fuel, bribe, surrender, tribute, ship missions) — stay
 * in 06-interaction.js; this module reads them and lays them out. Buttons carry
 * `data-action` for the Dialog delegation. Extracted per OOP_DESIGN.md's
 * "Separating UI from logic" (slice 3). Part of the flight shell bundled by
 * esbuild (entry: main.js).
 */
import { S, ships, escorts, dominated } from '../01-state.js';
import { html, raw } from './html.js';
import { MAX_ESCORTS } from '../02-spawning.js';
import { govts, misns, getOffer, descText, subst, stelName } from '../08-missions.js';
import { systemSpob } from '../15-pers.js';
import {
  captureOdds,
  playerCrew,
  captureVessel,
  lootVessel,
  takeCapturedShip,
  escortCapturedShip,
} from '../12-boarding.js';
import { Dialog } from './dialog.js';
import {
  FUEL_PRICE,
  pickFrom,
  shipOffering,
  shipGreeting,
  hailClick,
  closeHail,
  hailSay,
  demandTribute,
  payFuel,
  payBribe,
  requestAssistance,
  begForMercy,
  demandSurrender,
  acceptShipMission,
  declineShipMission,
} from '../06-interaction.js';

/* The offer panel HTML (comm quote + briefing + destination/pay). */
export function shipOfferPanel(s) {
  const m = misns[s.misnLink],
    here = systemSpob();
  const o = getOffer(s.misnLink, here);
  const A = { ...o, osn: s.misnName };
  const quote =
    s.commQuote >= 0 && DATA.strings[7100] ? DATA.strings[7100].list[s.commQuote] : null;
  const brief = descText(m.BriefText, A) || descText(m.QuickBrief, A) || subst(m.name, A);
  const pay = m.PayVal > 0 ? `${m.PayVal.toLocaleString('en-US')} cr` : 'see briefing';
  const dst =
    o.travelStel != null
      ? stelName(o.travelStel)
      : o.returnStel != null
        ? stelName(o.returnStel)
        : '—';
  return html`${quote ? html`<div class="say">“${subst(quote, A)}”</div>` : ''}<div class="say" style="max-height:120px;overflow-y:auto">${brief}</div>
    <div class="who">Mission: <b>${subst(m.name, A)}</b> · Destination: ${dst} · Pay: ${pay}</div>`;
}

function hailBody() {
  const t = S.hailTarget;
  if (!t) return '';
  let body; // `buttons`/`tag` below are static trusted markup → raw(); data stays escaped
  if (t.kind === 'board') {
    const s = t.obj;
    const govtName = s.govt >= 128 && govts[s.govt] ? govts[s.govt].name : 'Independent';
    const shipName = ships[s.shipId].name;
    let buttons;
    if (t.mode === 'result') {
      // capture/loot resolved — the ship is spent
      buttons = `<button data-action="close">Continue</button>`;
    } else if (t.mode === 'captured') {
      // seized — choose its fate
      const full = escorts.length >= MAX_ESCORTS;
      buttons =
        `<button data-action="take">Take command</button>` +
        `<button data-action="escort"${full ? ' disabled title="Your fleet is full"' : ''}>Add to your fleet</button>`;
    } else {
      const canLoot = (s.booty || 0) !== 0;
      buttons =
        `<button data-action="capture">Capture vessel (~${Math.round(100 * captureOdds(s))}% chance)</button>` +
        (canLoot
          ? `<button data-action="loot">Loot the hold</button>`
          : `<button disabled title="You are repelled — nothing to plunder">Nothing to loot</button>`) +
        `<button data-action="close">Leave it be</button>`;
    }
    const say =
      t.said ||
      `You board the disabled ${shipName}. Your crew ${playerCrew()} vs theirs ${ships[s.shipId].Crew || 1}.`;
    body = html`<img class="commpic" src="evassets/graphics/PICT_${5300 + (s.shipId - 128)}.png" onerror="this.remove()">
      <h3>${shipName}</h3>
      <div class="who">${govtName} · <span style="color:#e06c75">DISABLED</span></div>
      <div class="say">${say}</div>
      ${raw(buttons)}`;
    return body;
  }
  if (t.kind === 'ship') {
    const s = t.obj;
    const govtName = s.govt >= 128 && govts[s.govt] ? govts[s.govt].name : 'Independent';
    if (t.said == null) t.said = shipGreeting(s); // first-time greeting
    const label = s.bounty ? 'Bounty Hunter' : govtName;
    const tag = s.disabled
      ? ' · <span style="color:#e06c75">DISABLED</span>'
      : s.hostile
        ? ' · <span style="color:#e06c75">HOSTILE</span>'
        : '';
    const offering = shipOffering(s);
    let buttons;
    if (t.mode === 'fuel') {
      buttons = `<button data-action="payFuel" data-arg="1">Pay ${FUEL_PRICE.toLocaleString('en-US')} cr for fuel</button>
        <button data-action="payFuel" data-arg="0">Offer ${Math.round(FUEL_PRICE / 2).toLocaleString('en-US')} cr</button>
        <button data-action="mainMode">Never mind</button>`;
    } else if (t.mode === 'mercy') {
      buttons = `<button data-action="bribe">Pay ${t.bribe.toLocaleString('en-US')} cr to be spared</button>
        <button data-action="mainMode">Never mind</button>`;
    } else {
      buttons =
        (offering
          ? `<button data-action="acceptMisn">Accept mission</button>
                     <button data-action="declineMisn">Decline</button>`
          : '') +
        `<button data-action="assist">Request assistance</button>` +
        (s.hostile ? `<button data-action="beg">Beg for mercy</button>` : '') +
        `<button data-action="surrender"${s.disabled ? '' : ' disabled'}>Demand surrender / plunder</button>`;
    }
    // classic ship comm portrait: PICT 5300 + ship index
    body = html`<img class="commpic" src="evassets/graphics/PICT_${5300 + (s.shipId - 128)}.png" onerror="this.remove()">
      <h3>${s.misnName || ships[s.shipId].name}</h3>
      <div class="who">${label}${raw(tag)}</div>
      <div class="say">“${t.said}”</div>
      ${offering && t.mode !== 'fuel' && t.mode !== 'mercy' ? shipOfferPanel(s) : ''}
      ${raw(buttons)}
      <button data-action="close">Close channel</button>`;
  } else {
    const p = t.obj,
      m = p.$sem || {};
    const greet = t.said || (pickFrom(3002, 0, 4) || 'Channel open to ') + p.name + '.';
    const dom = dominated.has(p.id);
    body = html`<h3>${p.name}</h3>
      <div class="who">${m.govt || 'Independent'}${dom ? ' · paying tribute' : ''}</div>
      <div class="say">“${greet}”</div>
      <button data-action="info">Request information</button>
      <button data-action="tribute"${p.Govt < 128 ? ' disabled' : ''}>Demand tribute</button>
      <button data-action="close">Close channel</button>`;
  }
  return body;
}

/* Route the hail buttons (data-action=…) through the shared Dialog delegation. */
const hailActions = {
  close: () => {
    hailClick();
    closeHail();
  },
  take: () => takeCapturedShip(),
  escort: () => escortCapturedShip(),
  capture: () => captureVessel(),
  loot: () => lootVessel(),
  payFuel: (arg) => payFuel(arg === '1'),
  mainMode: () => {
    S.hailTarget.mode = 'main';
    renderHail();
  },
  bribe: () => payBribe(S.hailTarget.obj),
  acceptMisn: () => acceptShipMission(S.hailTarget.obj),
  declineMisn: () => declineShipMission(S.hailTarget.obj),
  assist: () => requestAssistance(S.hailTarget.obj),
  beg: () => begForMercy(S.hailTarget.obj),
  surrender: () => demandSurrender(S.hailTarget.obj),
  info: () => {
    hailClick();
    hailSay(pickFrom(3002, 15, 24) || 'They have nothing to tell you.');
  },
  tribute: () => {
    hailClick();
    demandTribute(S.hailTarget.obj);
  },
};

/* The hail modal, driven by the DOM-only Dialog base (render + mount/refresh/hide
 * + data-action delegation). openHail/closeHail (06-interaction) show and hide
 * it; renderHail re-renders in place when the target's mode changes. */
export const hailDialog = new Dialog('hail', 'hailCard', hailBody, hailActions);
export function renderHail() {
  hailDialog.refresh();
}
