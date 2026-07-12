/*
 * engine/shell/ui/active-missions.js — the "Currently active missions" dialog
 * (press I in flight). Replicates the original EV window: a scrollable list of
 * accepted missions, the selected mission's briefing on the right, and Abort /
 * Done buttons. Mission *logic* (records, abort side-effects) stays in
 * 08-missions.js; this is just the flight-time modal around it.
 *
 * Built on the DOM-only Dialog base (ui/dialog.js). While it's open the sim is
 * paused (09-step checks S.missionsOpen) and 05-input swallows hotkeys, exactly
 * like the galaxy map.
 */
import { Dialog } from './dialog.js';
import { missionLog, S, showMsg } from '../01-state.js';
import { html } from './html.js';
import {
  misns,
  misnName,
  descText,
  abortMission,
  formatDate,
  stelName,
  spobById,
  systOfSpob,
} from '../08-missions.js';

function detailFor(A) {
  const m = misns[A.id];
  // The short "what to do now" text — QuickBrief in the original, BriefText as a
  // fallback for missions that only carry the longer briefing.
  const text =
    descText(m.QuickBrief, A) || descText(m.BriefText, A) || 'No further details are recorded.';
  const facts = [];
  const destId = A.travelStel != null ? A.travelStel : A.returnStel;
  if (destId != null) {
    const sys = systOfSpob(spobById(destId));
    facts.push(
      html`<div class="msub">Destination: ${stelName(destId)}${sys ? ` (${sys.name} system)` : ''}</div>`,
    );
  }
  if (A.cargoName && A.cargoQty)
    facts.push(html`<div class="msub">Cargo: ${A.cargoQty}t ${A.cargoName}</div>`);
  if (A.shipsLeft > 0) facts.push(html`<div class="msub">Ships remaining: ${A.shipsLeft}</div>`);
  if (A.timeLimit > 0) {
    const left = Math.max(0, A.timeLimit - (S.gameDay - A.accepted));
    const by = A.deadline != null ? A.deadline : A.accepted + A.timeLimit;
    facts.push(
      html`<div class="msub">Time left: ${left} day${left === 1 ? '' : 's'} (by ${formatDate(by)})</div>`,
    );
  }
  return html`<div>${text}</div>${facts}`;
}

export function renderActiveMissions() {
  const list = missionLog.list;
  // Keep the selection valid as missions are aborted/completed.
  if (S.selActiveMisn == null || !list.some((a) => a.id === S.selActiveMisn))
    S.selActiveMisn = list.length ? list[0].id : null;

  const rows = list.map(
    (a) =>
      html`<div class="mrow${a.id === S.selActiveMisn ? ' sel' : ''}" data-action="selMisn" data-arg="${a.id}">
        ${misnName(misns[a.id], a)}
      </div>`,
  );
  const A = S.selActiveMisn != null ? missionLog.find(S.selActiveMisn) : null;
  const canAbort = A && misns[A.id].CanAbort !== 0;

  return html`<h2>Currently active missions:</h2>
    <div class="mcols">
      <div class="mlist">
        ${rows.length ? rows : html`<div class="msub">You have no active missions.</div>`}
      </div>
      <div class="mdetail">
        ${A ? detailFor(A) : html`<div class="msub">Select a mission to see its details.</div>`}
      </div>
    </div>
    <div class="mbtns">
      <button data-action="abort"${canAbort ? '' : ' disabled'}>Abort Mission</button>
      <button data-action="done">Done</button>
    </div>`;
}

const actions = {
  selMisn: (id) => {
    S.selActiveMisn = +id;
    activeMissionsDialog.refresh();
  },
  abort: () => {
    const A = S.selActiveMisn != null ? missionLog.find(S.selActiveMisn) : null;
    if (!A) return;
    const m = misns[A.id];
    if (m.CanAbort === 0) {
      showMsg('This mission cannot be abandoned.');
      return;
    }
    if (!confirm(`Abandon "${misnName(m, A)}"?`)) return;
    abortMission(A.id); // handles reversal penalty, ship cleanup, and the message
    if (!missionLog.count) closeActiveMissions();
    else activeMissionsDialog.refresh();
  },
  done: () => closeActiveMissions(),
};

export const activeMissionsDialog = new Dialog(
  'missions',
  'missionsCard',
  renderActiveMissions,
  actions,
);

export function openActiveMissions() {
  if (!missionLog.count) {
    showMsg('No active missions.');
    return;
  }
  S.missionsOpen = true;
  activeMissionsDialog.open();
}

export function closeActiveMissions() {
  S.missionsOpen = false;
  activeMissionsDialog.close();
}
