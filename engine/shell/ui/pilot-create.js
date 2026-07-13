/*
 * engine/shell/ui/pilot-create.js — the New Pilot creation flow (name dialog).
 *
 * The two-step "name yourself, christen your ship" dialog and its helpers, split
 * out of 01-state.js — DOM/presentation that doesn't belong in the state leaf.
 * It reads state (S/ships) and the Save facade to create the pilot, and the
 * ambient NAMES/DATA globals for the suggested defaults; the dialog markup uses
 * the html`` tag. Triggered from the title menu (ui/title.js). esbuild bundles
 * it (entry: main.js). Normative: ENGINE_SPEC "New pilot".
 */
import { html, raw } from './html.js';
import { S, ships, Save, showMsg } from '../01-state.js';

/* ---- New Pilot creation (spec: "New pilot") ---- */
export const nameSuggest = (kind) => {
  // a random default, from the app's STR# 128 or a generic
  const list = NAMES && NAMES[kind];
  if (list && list.length) return list[Math.floor(Math.random() * list.length)];
  return kind === 'pilots' ? 'New Pilot' : 'Star Voyager';
};
export const shipLongName = () =>
  (DATA.strings[5002] && DATA.strings[5002].list[S.playerShipId - 128]) ||
  (ships[S.playerShipId] && ships[S.playerShipId].name) ||
  'ship';
/* Two-step New Pilot flow, echoing the original: name yourself (with the
 * Strict Play permadeath option), then christen the starting Shuttlecraft. */
export function startNewPilot() {
  openNameDialog({
    prompt: "What's your name, pilot?",
    value: nameSuggest('pilots'),
    strict: true,
    onOk: (name, strict) =>
      openNameDialog({
        prompt: `Christen your new ${shipLongName()}:`,
        value: nameSuggest('ships'),
        strict: false,
        onOk: (ship) =>
          createPilot(
            name.trim() || nameSuggest('pilots'),
            ship.trim() || nameSuggest('ships'),
            strict,
          ),
      }),
  });
}
export function createPilot(name, ship, strict) {
  if (!Save.create(Save.fresh(name, ship, strict))) {
    showMsg('Could not create the pilot — browser storage is unavailable.');
    return;
  }
  try {
    sessionStorage.setItem('ve_newpilot', '1');
  } catch {} // jump past the splash after reload
  location.reload(); // reload restores the new pilot
}
export function openNameDialog(cfg) {
  const el = document.getElementById('npilot');
  const strictHtml = cfg.strict
    ? `<label class="npstrict"><input type="checkbox" id="npStrict"><b>Strict Play</b></label>
       <div class="npnote">Permadeath: if this pilot dies, it's gone for good — no restoring from a save.</div>`
    : '';
  el.querySelector('.card').innerHTML = html`<div class="nprow">
       <img class="npicon" src="evassets/graphics/PICT_${5000 + (S.playerShipId - 128)}.png" onerror="this.style.display='none'">
       <div class="npmsg">${cfg.prompt}</div>
     </div>
     <input type="text" id="npName" maxlength="63" spellcheck="false" autocomplete="off">
     ${raw(strictHtml)}
     <div class="npbtns"><button id="npCancel">Cancel</button><button id="npOk" class="primary">OK</button></div>`;
  el.style.display = 'flex';
  const input = document.getElementById('npName');
  input.value = cfg.value; // set as a property, not an HTML attribute — no quote/markup injection
  input.focus();
  input.select();
  const close = () => {
    el.style.display = 'none';
  };
  const ok = () => {
    const v = input.value,
      s = document.getElementById('npStrict');
    close();
    cfg.onOk(v, s ? s.checked : false);
  };
  document.getElementById('npOk').onclick = ok;
  document.getElementById('npCancel').onclick = close;
  // keep typing from reaching the title's global key-swallow
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') ok();
    else if (e.key === 'Escape') close();
  };
}
