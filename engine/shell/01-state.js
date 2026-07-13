/*
 * engine/shell/01-state.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
import { Wallet } from './wallet.js';
import { LegalRecord } from './legal.js';
import { MissionLog } from './mission-log.js';
import { html, raw } from './ui/html.js'; // the html`` primitive lives in the UI leaf now
/* ---------------- configuration ---------------- */

export const params = new URLSearchParams(location.search);

/* S — the single bag of cross-module mutable game state (credits, fuel, targets,
 * shots, jump, …). ES-module imports are read-only bindings, so state reassigned
 * from more than one module lives here on a shared object instead of as free
 * `let`s; every read/write is S.x. (Module-local mutable state stays a plain
 * `let` in its module.) This is the groundwork for splitting the shell into
 * real ES modules. */
export const S = {};

// Transient status line (bottom-left). A base UI helper — kept here so every
// module can call it without a back-edge to the interaction module.
export let msgTimer = null,
  lastMsg = '';
export function showMsg(text) {
  lastMsg = text;
  const el = document.getElementById('msg');
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => {
    el.style.opacity = 0;
  }, 3500);
}

/* ---- persistence (spec: "Persistence") ----
 * The pilot auto-saves on landing and takeoff (classic saved when you
 * landed) and restores on load. Any gameplay-affecting test param puts
 * the session in test mode: no restore, no saving — your pilot is safe
 * from headless screenshot runs. ?new=1 starts a fresh pilot. */
export const TEST_MODE = [
  'new',
  'syst',
  'ship',
  'x',
  'y',
  'heading',
  'ff',
  'land',
  'exchange',
  'outfitter',
  'shipyard',
  'map',
  'dest',
  'jump',
  'tab',
  'nav',
  'fire',
  'bar',
  'computer',
  'allmissions',
].some((k) => params.has(k));
/* Single source of truth for the pilot save (the localStorage roster; see the
 * "multi-pilot storage" block below). capture() snapshots the live game state
 * into the save schema; fresh() builds a brand-new pilot; the storage methods own
 * the roster/slots + v-tag handshake. The field list living in one place is why
 * savePilot/createPilot no longer each hand-roll the blob. (Method bodies read
 * state declared below — they only run later, at save/create time, so forward
 * references are fine.) */
export const Save = {
  capture(spobId) {
    return {
      v: 2,
      syst: S.SYSTEM_ID,
      spob: spobId,
      ship: S.playerShipId,
      credits: wallet.credits,
      cargo,
      outfits,
      explored: [...explored],
      bits: [...missionLog.bits.keys()].filter((b) => missionLog.bits[b]),
      day: S.gameDay,
      born: pilotBorn,
      rep: legal.records,
      kills: legal.kills,
      missions: missionLog.list,
      dominated: [...dominated],
      name: pilotName,
      shipName,
      strict: strictPlay,
      escorts,
      persDone: [...persDone],
      persGrudge: [...persGrudge],
    };
  },
  fresh(name, ship, strict) {
    return {
      v: 2,
      syst: 128,
      spob: null,
      ship: 128,
      credits: 10000,
      cargo: Object.fromEntries(COMMODITIES.map((c) => [c, 0])),
      outfits: {},
      explored: [128],
      bits: [],
      day: 0,
      born: Date.now(),
      rep: {},
      kills: 0,
      missions: [],
      dominated: [],
      escorts: [],
      name,
      shipName: ship,
      strict: !!strict,
    };
  },
  // v1 stored the legal record per government; v2 stores it per system. Expand
  // each govt's value onto the systems it controls so an old pilot keeps its
  // standing under the per-system model.
  migrateV1(p) {
    const rep = {};
    const syst = (DATA.types && DATA.types.syst) || {};
    for (const [id, s] of Object.entries(syst)) {
      const g = s && s.Govt >= 128 ? s.Govt : 128;
      if (p.rep && p.rep[g] != null) rep[id] = p.rep[g];
    }
    return { ...p, v: 2, rep };
  },

  /* ---- multi-pilot storage ----
   * Each pilot lives under its own key `ve_pilot:<id>`; `ve_roster` is the index
   * (light summaries for the Open Pilot list) and `ve_active` names the loaded
   * pilot. The old single `ve_pilot` blob is migrated into a roster slot once. */
  ROSTER: 've_roster',
  ACTIVE: 've_active',
  LEGACY: 've_pilot',
  slot: (id) => 've_pilot:' + id,
  _get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  _set(k, v) {
    try {
      const b = JSON.stringify(v);
      localStorage.setItem(k, b);
      return localStorage.getItem(k) === b;
    } catch {
      return false; // trust nothing on file://
    }
  },
  _summary(id, p) {
    return {
      id,
      name: p.name || 'Pilot',
      shipName: p.shipName || '',
      ship: p.ship,
      credits: p.credits,
      day: p.day || 0,
      strict: !!p.strict,
    };
  },
  // Absorb a stray single `ve_pilot` blob into the roster as a new active slot —
  // both the old single-save format and a pilot dropped in by `evpilot.js import`
  // (localStorage.setItem('ve_pilot', …)). Runs on every load, so it doubles as a
  // simple import drop-box even once you already have a roster.
  _migrateLegacy() {
    const legacy = this._get(this.LEGACY);
    if (!legacy) return;
    const id = this._newId();
    if (this._set(this.slot(id), legacy)) {
      const r = this._get(this.ROSTER) || [];
      r.push(this._summary(id, legacy));
      this._set(this.ROSTER, r);
      this._set(this.ACTIVE, id);
      try {
        localStorage.removeItem(this.LEGACY);
      } catch {}
    }
  },
  _newId() {
    return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  },
  roster() {
    this._migrateLegacy();
    return this._get(this.ROSTER) || [];
  },
  activeId() {
    this._migrateLegacy();
    return this._get(this.ACTIVE);
  },
  // Read any pilot's stored save by id, exactly as it sits in localStorage
  // (no v1→v2 migration — the raw on-disk shape is what a JSON export/bug
  // report wants). null if the slot is missing or unparseable.
  read(id) {
    return this._get(this.slot(id));
  },
  // Load the currently active pilot (v1→v2 migrated), or null.
  load() {
    this._migrateLegacy();
    const id = this._get(this.ACTIVE);
    if (!id) return null;
    let p = this._get(this.slot(id));
    if (!p) return null;
    if (p.v === 1) p = this.migrateV1(p);
    return p && p.v === 2 ? p : null;
  },
  // Save the active pilot in place (used by savePilot). With no active pilot
  // yet, fall back to creating a slot.
  write(obj) {
    const id = this._get(this.ACTIVE);
    if (!id) return this.create(obj) != null;
    const ok = this._set(this.slot(id), obj);
    if (ok) {
      const r = this._get(this.ROSTER) || [];
      const i = r.findIndex((e) => e.id === id);
      if (i >= 0) r[i] = this._summary(id, obj);
      else r.push(this._summary(id, obj));
      this._set(this.ROSTER, r);
    }
    return ok;
  },
  // Add a new pilot slot and make it active (New Pilot / import). Returns its id.
  create(obj) {
    const id = this._newId();
    if (!this._set(this.slot(id), obj)) return null;
    const r = this._get(this.ROSTER) || [];
    r.push(this._summary(id, obj));
    this._set(this.ROSTER, r);
    this._set(this.ACTIVE, id);
    return id;
  },
  select(id) {
    this._set(this.ACTIVE, id);
  },
  remove(id) {
    try {
      localStorage.removeItem(this.slot(id));
    } catch {}
    const r = (this._get(this.ROSTER) || []).filter((e) => e.id !== id);
    this._set(this.ROSTER, r);
    if (this._get(this.ACTIVE) === id) this._set(this.ACTIVE, r.length ? r[r.length - 1].id : null);
  },
  // Abandon the active pilot (deselect, keep the roster) → back to the title.
  clear() {
    this._set(this.ACTIVE, null);
  },
};

export const SAVED = TEST_MODE ? null : Save.load();

S.SYSTEM_ID = SAVED ? SAVED.syst : +(params.get('syst') || 128); // Levo — the classic start
S.playerShipId = SAVED ? SAVED.ship : +(params.get('ship') || 128); // Shuttlecraft

/* player economy state (spec: "Trading") — the pilot file's contents */
export const COMMODITIES = ['food', 'industrial', 'medical', 'luxury', 'metal', 'equipment'];
export const PRICE_MULT = { low: 0.8, medium: 1.0, high: 1.25 };
export const wallet = new Wallet(SAVED ? SAVED.credits : 10000);
export const cargo = Object.fromEntries(
  COMMODITIES.map((c) => [c, (SAVED && SAVED.cargo[c]) || 0]),
);

export const outfits = {}; // outf id -> count (pilot inventory)
if (SAVED && SAVED.outfits) Object.assign(outfits, SAVED.outfits);
export const explored = new Set(SAVED ? SAVED.explored : []);

/* mission state (spec: "Missions") — also part of the pilot file. 512 flags:
 * set/clear codes address bits 0–511 (0–511 set, 1000–1511 clear), and përs
 * MissionBit likewise ranges 0–511, so the store must span the full range. */
S.gameDay = SAVED ? SAVED.day || 0 : 0;
// Real-world epoch the pilot was created, so the displayed in-game date is
// stable across sessions (legacy saves without it fall back to now).
export const pilotBorn = SAVED && SAVED.born ? SAVED.born : Date.now();
// Pilot & ship names (set at New Pilot) and Strict Play (permadeath) flag.
export const pilotName = (SAVED && SAVED.name) || '';
export const shipName = (SAVED && SAVED.shipName) || '';
export const strictPlay = SAVED ? !!SAVED.strict : false;
/* legal record per system (spec: "Legal record") — negative = evil, positive
 * = good; a system with no stored record defaults to its govt's InitialRec.
 * Missions and combat move it (see 13-legal.js applyGovtDelta). */
export const legal = new LegalRecord(
  SAVED && SAVED.rep ? { ...SAVED.rep } : {},
  SAVED ? SAVED.kills || 0 : 0,
);
export const dominated = new Set(SAVED ? SAVED.dominated : []); // spob ids subdued for tribute
// përs (named characters) that have been "spent" — a one-shot character whose
// mission you accepted (deactivateAfterLinkMission) won't reappear.
export const persDone = new Set(SAVED && SAVED.persDone ? SAVED.persDone : []);
// përs who hold a grudge (you attacked them): they won't offer you work again.
export const persGrudge = new Set(SAVED && SAVED.persGrudge ? SAVED.persGrudge : []);
/* active missions: resolved, live copies (not the raw records) */
export const missionLog = new MissionLog(
  SAVED && SAVED.missions ? SAVED.missions.map((m) => ({ ...m })) : [],
  (SAVED && SAVED.bits) || [],
);
/* player-owned escorts (spec: "Escorts") — allied ships that follow the
 * player, fight the player's enemies, and persist across jumps/landings.
 * Saved as {id, shipId, name}; the live AI entity is respawned each system. */
// Declared here (before the save/load helpers that reference it); the
// hull-existence filter is deferred until after `const ships` exists, since
// `ships` is a const declared later in this module — reading it here would hit
// the temporal dead zone and throw when loading a saved pilot that has escorts.
export let escorts = SAVED && SAVED.escorts ? SAVED.escorts.map((e) => ({ ...e })) : [];
S.escNextId = escorts.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;

export let storageWarned = false;
export function savePilot(spobId) {
  if (TEST_MODE) return;
  if (!Save.write(Save.capture(spobId)) && !storageWarned) {
    storageWarned = true;
    showMsg('Warning: browser storage unavailable — your pilot will not be saved.');
  }
}
export function newPilot() {
  // abandon the current pilot → back to the title
  Save.clear();
  location.href = location.pathname;
}
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

export const ships = DATA.types.ship;
// Deferred from the escorts init above (needs `ships`): drop saved escorts whose
// hull this data set no longer defines.
escorts = escorts.filter((e) => ships[e.shipId]);
export const dudes = DATA.types.dude;
export const systs = DATA.types.syst;

export const SHIP_SPIN_BASE = 128,
  STELLAR_SPIN_BASE = 300;
export const spinOfShip = (shipId) => SHIP_SPIN_BASE + (shipId - 128);
export const spinOfSpob = (p) => STELLAR_SPIN_BASE + p.Type;

/* ---------------- sprites ---------------- */

export const sprites = new Map(); // spinId -> {img, meta, ready}
export function preloadSprites(spinIds) {
  for (const id of spinIds) {
    const meta = MANIFEST.spins[id];
    if (!meta || sprites.has(+id)) continue;
    const img = document.createElement('img');
    img.src = 'evassets/sprites/spin_' + id + '.png';
    img.style.display = 'none';
    document.body.appendChild(img);
    const entry = { img, meta, ready: img.complete };
    img.onload = () => {
      entry.ready = true;
    };
    sprites.set(+id, entry);
  }
}
export function drawSpin(ctx, spinId, x, y, headingDeg) {
  const s = sprites.get(spinId);
  if (!s || !s.ready) return;
  const { frameW, frameH, xTiles, frames } = s.meta;
  const fi = EV.frameIndex(headingDeg, frames);
  ctx.drawImage(
    s.img,
    (fi % xTiles) * frameW,
    Math.floor(fi / xTiles) * frameH,
    frameW,
    frameH,
    x - frameW / 2,
    y - frameH / 2,
    frameW,
    frameH,
  );
}
/* Plain single-image PICT cache (target pics 3000+, etc.), drawn fit to a
 * box centred on (cx, cy). */
export const gfxCache = new Map();
export function gfxImg(pictId) {
  let e = gfxCache.get(pictId);
  if (!e) {
    const img = new Image();
    img.src = 'evassets/graphics/PICT_' + pictId + '.png';
    e = { img, ready: img.complete };
    img.onload = () => {
      e.ready = true;
    };
    img.onerror = () => {
      e.bad = true;
    };
    gfxCache.set(pictId, e);
  }
  return e;
}
export function drawGfxFit(ctx, pictId, cx, cy, maxW, maxH) {
  const e = gfxImg(pictId);
  if (!e.ready || e.bad || !e.img.naturalWidth) return false;
  const s = Math.min(maxW / e.img.naturalWidth, maxH / e.img.naturalHeight, 1);
  const w = e.img.naturalWidth * s,
    h = e.img.naturalHeight * s;
  ctx.drawImage(e.img, cx - w / 2, cy - h / 2, w, h);
  return true;
}

/* ---------------- world (per-system state) ---------------- */

S.systEpoch = 0;

export function spinsNeededFor(systId) {
  const s = systs[systId];
  const need = new Set([spinOfShip(S.playerShipId)]);
  for (const p of Object.values(DATA.types.spob)) if (p.System === +systId) need.add(spinOfSpob(p));
  for (let i = 1; i <= 4; i++) {
    const d = dudes[s['DudeTypes' + i]];
    if (d)
      for (let j = 1; j <= 4; j++)
        if (d['ShipTypes' + j] >= 128) need.add(spinOfShip(d['ShipTypes' + j]));
  }
  return need;
}
