/*
 * engine/shell/ui/title.js — the title + splash screens (presentation).
 *
 * The classic EV boot chrome: the loading splash (PICT 131), the title menu
 * (PICT 8000) with its rotating ship and pilot summary, and the About / Open
 * Pilot dialogs. Split from 11-title.js per OOP_DESIGN.md's "Separating UI from
 * logic" (slice 5): this module owns the screens' DOM — how the splash/title are
 * painted, the canvas pilot summary, the dialogs, prefs, pilot import, and the
 * menu's own hotspot bindings. The intro *state machine* (the splashShown/
 * titleShown flags, introUp, and the showSplash/advanceSplash/showTitle/enterGame
 * transitions that the boot sequence and input driver drive) stays in 11-title.js,
 * which calls the render helpers here. The dependency stays one-way (logic → ui):
 * 11-title imports from here; this module never imports 11-title.
 *
 * esbuild bundles the shell modules (entry: main.js). Normative: ENGINE_SPEC.md.
 */

import { S, SAVED, Save, pilotName, shipName, ships, showMsg, startNewPilot } from '../01-state.js';
import { html } from './html.js';
import { startTitleMusic, stopTitleMusic } from '../03-sound.js';
import { combatRating, legalStatus } from '../13-legal.js';
import { formatDate } from '../08-missions.js';
import { Dialog } from './dialog.js';
import {
  decodePilotFile,
  downloadPilotFile,
  looksLikeJSON,
  parsePilotJSON,
} from './pilot-import.js';

export const titleEl = document.getElementById('title');
export const splashEl = document.getElementById('splash');

/* ---------------- splash screen (PICT 131) render helpers ----------------
 * Pure DOM manipulation, called by 11-title's showSplash/advanceSplash so the
 * flags and audio stay on the logic side. paintSplash shows the "press any key"
 * prompt; setSplashLoading swaps it to "Loading…"; fadeSplashAway fades the
 * splash out over 700 ms (mirroring the original) then invokes `done`. */
export function paintSplash() {
  splashEl.style.display = 'flex';
  document.getElementById('splashPrompt').textContent = 'Press any key to continue';
}
export function setSplashLoading() {
  document.getElementById('splashPrompt').textContent = 'Loading…';
}
export function fadeSplashAway(done) {
  splashEl.classList.add('fade');
  setTimeout(() => {
    splashEl.style.display = 'none';
    splashEl.classList.remove('fade');
    if (done) done();
  }, 700);
}

/* ---------------- title menu (PICT 8000) render helpers ----------------
 * showTitleMenu reveals the menu overlay with its one-shot fade/scale-in, draws
 * the pilot summary once layout settles, and keeps it sized on resize;
 * hideTitleMenu tears that down. The flags/audio around them live in 11-title. */
export function showTitleMenu() {
  titleEl.style.display = 'flex';
  titleEl.classList.add('intro'); // one-shot fade/scale-in, cleared after
  setTimeout(() => titleEl.classList.remove('intro'), 1100);
  // Open Pilot always works now — it lists the roster and can import a pilot.
  document.getElementById('hotOpen').style.opacity = '';
  // draw the pilot summary once layout settles, and keep it sized on resize
  requestAnimationFrame(renderTitleSummary);
  setTimeout(renderTitleSummary, 200); // fonts/bg may lag a frame
  titleSummaryResize = () => renderTitleSummary();
  addEventListener('resize', titleSummaryResize);
}
export function hideTitleMenu() {
  titleEl.style.display = 'none';
  if (titleSummaryResize) {
    removeEventListener('resize', titleSummaryResize);
    titleSummaryResize = null;
  }
}

// The About panel is a Dialog over this pure render: its Close button carries
// data-action="close" (routed to aboutActions) rather than an inline onclick.
function aboutBody() {
  // STR# 20000 is the intro crawl; show it as flavour + a clean-room note.
  const intro = ((DATA.strings[20000] && DATA.strings[20000].list) || [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return html`
    <h2>Vₑ — Escape Velocity, recreated</h2>
    <p>${intro}</p>
    <p style="color:#6f7c94;margin-top:12px">A clean-room reimplementation of
    Ambrosia Software’s Escape Velocity. Engine by Misha Nasledov.
    Game data is the original publisher’s and is not distributed.</p>
    <button data-action="close">Close</button>`;
}
export const aboutDialog = new Dialog('about', 'aboutCard', aboutBody, {
  close: () => aboutDialog.close(),
});
export function titleAbout() {
  startTitleMusic();
  aboutDialog.open();
}
export function titlePrefs() {
  S.soundOn = !S.soundOn;
  if (!S.soundOn) stopTitleMusic();
  else startTitleMusic();
  showMsg('Sound ' + (S.soundOn ? 'on' : 'off'));
}

/* The title viewscreen shows a summary of the current pilot's game (as the
 * original does), drawn on the canvas so it scales with the framed art. */
export function gameDate() {
  // Classic EV starts the calendar at the pilot's creation date + 250 years and
  // advances it one day per hyperspace jump (gameDay). formatDate does the work;
  // this is just "the current day".
  return formatDate(S.gameDay);
}
export function renderTitleSummary() {
  const cv = document.getElementById('titleView');
  const w = cv.clientWidth,
    h = cv.clientHeight;
  if (!w || !h) return; // not laid out yet
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  if (!SAVED) {
    // nothing to summarize until a pilot is opened/created
    const words = ['No', 'Pilot', 'file', 'loaded'];
    const m = Math.round(cv.width * 0.08),
      aw = cv.width - m * 2;
    let fs = Math.round(cv.height / 7);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const longest = () => Math.max(...words.map((wd) => g.measureText(wd).width));
    g.font = `bold ${fs}px monospace`;
    while (fs > 7 && longest() > aw) {
      fs -= 1;
      g.font = `bold ${fs}px monospace`;
    }
    const lines = [];
    let line = '';
    for (const wd of words) {
      const t = line ? line + ' ' + wd : wd;
      if (line && g.measureText(t).width > aw) {
        lines.push(line);
        line = wd;
      } else line = t;
    }
    if (line) lines.push(line);
    const lh = fs * 1.35;
    let y = (cv.height - lines.length * lh) / 2;
    g.fillStyle = '#6f9f80';
    for (const ln of lines) {
      g.fillText(ln, cv.width / 2, y);
      y += lh;
    }
    g.textAlign = 'left';
    return;
  }
  const shipTypeName = ships[S.playerShipId] ? ships[S.playerShipId].name : 'Shuttlecraft';
  const fields = [
    ['Pilot', pilotName || 'Pilot'],
    ['Ship name', shipName || shipTypeName],
    ['Ship type', shipTypeName],
    ['Legal status', legalStatus(S.SYSTEM_ID)],
    ['Combat rating', combatRating()],
    ['Date', gameDate()],
  ];
  const pad = Math.round(cv.width * 0.07);
  const avail = cv.width - pad * 2;
  const lh = cv.height / (fields.length * 2 + 0.5); // label+value per field
  const labelSz = Math.max(6, Math.round(lh * 0.72));
  const valueSz = Math.max(7, Math.round(lh * 0.92));
  g.textBaseline = 'top';
  let y = pad * 0.6;
  for (const [label, val] of fields) {
    g.fillStyle = '#3f8f63';
    g.font = `${labelSz}px monospace`;
    g.fillText(label + ':', pad, y);
    y += lh * 0.95;
    // shrink the value to fit the narrow viewscreen if needed
    let vs = valueSz;
    g.font = `bold ${vs}px monospace`;
    while (vs > 6 && g.measureText(val).width > avail) {
      vs -= 1;
      g.font = `bold ${vs}px monospace`;
    }
    g.fillStyle = '#86ffb6';
    g.fillText(val, pad, y);
    y += lh * 1.05;
  }
}
// re-render on resize while the title is up (the canvas is sized from layout)
export let titleSummaryResize = null;

// Enter Ship needs a loaded pilot; otherwise nudge toward New Pilot / Open Pilot.
export const needPilot = () => {
  showMsg('No pilot loaded — choose New Pilot or Open Pilot to begin.');
};

/* Open Pilot: pick a saved pilot from the roster, delete one, or import an
 * original EV Classic pilot file (which lands as a new roster slot). Selecting or
 * importing sets the active pilot and reloads to boot it. */
function openPilotBody() {
  const list = Save.roster();
  const active = Save.activeId();
  const rows = list.length
    ? list.map(
        // Each row is a flex container of separate real <button>s (pick + the
        // export/JSON/delete controls), not a <button> with nested <span>s:
        // nested interactive elements are invalid HTML and unreachable by
        // keyboard, whereas real buttons are focusable and fire on Enter/Space
        // for free (the delegated click handler then routes their data-action).
        (p) => html`<div
          class="pilotrow"
          style="display:flex;align-items:center;gap:6px;margin:4px 0"
        >
          <button
            type="button"
            class="svc"
            data-action="pick"
            data-arg="${p.id}"
            style="flex:1 1 auto;min-width:0;text-align:left"
          >
            ${p.id === active ? '▶ ' : ''}${p.name}${p.strict ? ' ⚠' : ''} —
            ${ships[p.ship] ? ships[p.ship].name : 'ship'} ·
            ${(p.credits || 0).toLocaleString('en-US')} cr
          </button>
          <button
            type="button"
            class="svc"
            data-action="export"
            data-arg="${p.id}"
            title="Export to an original-EV pilot file (.rsrc)"
            style="flex:0 0 auto;color:#7aa"
          >
            ⤓ EV
          </button>
          <button
            type="button"
            class="svc"
            data-action="json"
            data-arg="${p.id}"
            title="Export as a native Vₑ JSON save"
            style="flex:0 0 auto;color:#6bb6ff"
          >
            ⤓ JSON
          </button>
          <button
            type="button"
            class="svc"
            data-action="del"
            data-arg="${p.id}"
            title="Delete pilot"
            style="flex:0 0 auto;color:#d67"
          >
            ✕
          </button>
        </div>`,
      )
    : html`<p style="color:#6f7c94">No saved pilots yet — start a New Pilot or import one.</p>`;
  return html`<h2>Open Pilot</h2>
    ${rows}
    <div style="margin-top:14px">
      <button data-action="import">Import Pilot…</button>
      <button data-action="close">Close</button>
    </div>`;
}
/* Download a pilot's stored save as a native Vₑ .json file. This is the
 * engine's own on-disk shape (cargo map, missions, ship, outfits, legal record,
 * …) — distinct from the EV Classic pilot-file export — so a bug report can
 * carry the exact state that triggered it (e.g. a mission cargo-space dispute). */
function exportPilotJSON(id) {
  const save = Save.read(id);
  if (!save) {
    showMsg('Could not read that pilot from storage.');
    return;
  }
  const base = String(save.name || 'pilot').replace(/[^\w.-]+/g, '_') || 'pilot';
  const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = base + '.ve.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const openPilotActions = {
  pick: (id) => {
    Save.select(id);
    try {
      sessionStorage.setItem('ve_newpilot', '1'); // skip the splash → title
    } catch {}
    location.reload();
  },
  del: (id) => {
    if (confirm('Delete this pilot permanently?')) {
      Save.remove(id);
      openPilotDialog.refresh();
    }
  },
  json: (id) => exportPilotJSON(id),
  export: (id) => {
    const save = Save.read(id);
    if (!save) return showMsg('Could not read that pilot.');
    try {
      downloadPilotFile(save, DATA);
    } catch (err) {
      // A non-Error throw (e.g. a string) has no .message — fall back to its
      // string form so the user always sees something meaningful.
      showMsg('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  },
  import: () => document.getElementById('pilotFile').click(),
  close: () => openPilotDialog.close(),
};
export const openPilotDialog = new Dialog(
  'openpilot',
  'openPilotCard',
  openPilotBody,
  openPilotActions,
);
// Decode a chosen pilot file into a new roster slot, then boot it. Accepts both
// an EV Classic pilot (.rsrc/.bin, binary) and a native Vₑ save (.json, from the
// "⤓ JSON" export). The format is sniffed from the bytes, not the extension, so a
// misnamed file still works: a JSON save begins with '{' (past an optional BOM /
// whitespace), while a pilot fork starts with binary magic.
document.getElementById('pilotFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // let the same file be re-picked later
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const save = looksLikeJSON(bytes)
      ? parsePilotJSON(new TextDecoder().decode(bytes))
      : decodePilotFile(buf, file.name, DATA);
    if (!Save.create(save)) {
      showMsg('Could not save the imported pilot — browser storage is unavailable.');
      return;
    }
    try {
      sessionStorage.setItem('ve_newpilot', '1');
    } catch {}
    location.reload();
  } catch (err) {
    showMsg('Import failed: ' + err.message);
  }
});

// Menu hotspots that stay on the presentation side (their targets are all UI:
// dialogs, prefs, new-pilot, the quit note). "Enter Ship" is the one gameplay
// entry point and its binding lives with the transition logic in 11-title.js.
document.getElementById('hotOpen').onclick = () => openPilotDialog.open();
document.getElementById('hotNew').onclick = () => startNewPilot();
document.getElementById('hotAbout').onclick = titleAbout;
document.getElementById('hotPrefs').onclick = titlePrefs;
document.getElementById('hotQuit').onclick = () =>
  showMsg('This is the browser edition — just close the tab to quit.');
