/*
 * engine/shell/01-state.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- configuration ---------------- */

const params = new URLSearchParams(location.search);

// Escape untrusted game-data strings interpolated into innerHTML by the html``
// tag. Escapes quotes as well as &<> because the tag is also used inside quoted
// HTML attributes (onclick, style, …), where an unescaped quote would break out
// of the attribute. (Quote-escaping stops attribute breakout, not script
// injection — inline JS handler attributes must still never take untrusted
// values.) Lives here (an early module) so later modules can call it.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Auto-escaping HTML template tag. `html`...`` escapes every ${interpolation}
// unless it is trusted markup — the result of another html`` (below) or wrapped
// in raw(). An array interpolates each element the same way and joins them, so a
// list of html`` fragments composes without escaping while a stray plain string
// in the array is still escaped. Since data values default to escaped, dialogs
// can't be XSS'd by a modified data fork, and nested fragments never re-escape.
class SafeHtml { constructor(s) { this.value = s; } toString() { return this.value; } }
function raw(s) { return new SafeHtml(s == null ? '' : String(s)); }   // opt out: trust this markup
function html(strings, ...values) {
  const render = v => v instanceof SafeHtml ? v.value
    : Array.isArray(v) ? v.map(render).join('')
    : escapeHtml(v == null ? '' : v);
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/* ---- persistence (spec: "Persistence") ----
 * The pilot auto-saves on landing and takeoff (classic saved when you
 * landed) and restores on load. Any gameplay-affecting test param puts
 * the session in test mode: no restore, no saving — your pilot is safe
 * from headless screenshot runs. ?new=1 starts a fresh pilot. */
const TEST_MODE = ['new', 'syst', 'ship', 'x', 'y', 'heading', 'ff', 'land',
  'exchange', 'outfitter', 'shipyard', 'map', 'dest', 'jump', 'tab', 'nav',
  'fire', 'bar', 'computer', 'allmissions'].some(k => params.has(k));
/* Single source of truth for the pilot save (localStorage 've_pilot').
 * capture() snapshots the live game state into the save schema; fresh() builds a
 * brand-new pilot; load/write/clear own the storage + v-tag handshake. The field
 * list living in one place is why savePilot/createPilot no longer each hand-roll
 * the blob. (Method bodies read state declared below — they only run later, at
 * save/create time, so forward references are fine.) */
const Save = {
  KEY: 've_pilot',
  capture(spobId) {
    return {
      v: 1, syst: SYSTEM_ID, spob: spobId, ship: playerShipId,
      credits, cargo, outfits, explored: [...explored],
      bits: [...missionBits.keys()].filter(b => missionBits[b]),
      day: gameDay, born: pilotBorn, rep: reputation, kills, missions: activeMissions,
      dominated: [...dominated], name: pilotName, shipName, strict: strictPlay,
      escorts, persDone: [...persDone], persGrudge: [...persGrudge],
    };
  },
  fresh(name, ship, strict) {
    return {
      v: 1, syst: 128, spob: null, ship: 128, credits: 10000,
      cargo: Object.fromEntries(COMMODITIES.map(c => [c, 0])), outfits: {},
      explored: [128], bits: [], day: 0, born: Date.now(),
      rep: {}, kills: 0, missions: [], dominated: [], escorts: [],
      name, shipName: ship, strict: !!strict,
    };
  },
  write(obj) {
    const blob = JSON.stringify(obj);
    try { localStorage.setItem(this.KEY, blob); return localStorage.getItem(this.KEY) === blob; }
    catch { return false; }   // trust nothing on file://
  },
  load() {
    try { const p = JSON.parse(localStorage.getItem(this.KEY)); return p && p.v === 1 ? p : null; }
    catch { return null; }
  },
  clear() { try { localStorage.removeItem(this.KEY); } catch {} },
};

const SAVED = TEST_MODE ? null : Save.load();

let SYSTEM_ID = SAVED ? SAVED.syst : +(params.get('syst') || 128); // Levo — the classic start
let playerShipId = SAVED ? SAVED.ship : +(params.get('ship') || 128); // Shuttlecraft

/* player economy state (spec: "Trading") — the pilot file's contents */
const COMMODITIES = ['food', 'industrial', 'medical', 'luxury', 'metal', 'equipment'];
const PRICE_MULT = { low: 0.80, medium: 1.00, high: 1.25 };
let credits = SAVED ? SAVED.credits : 10000;
const cargo = Object.fromEntries(COMMODITIES.map(c => [c, (SAVED && SAVED.cargo[c]) || 0]));
const explored = new Set(SAVED ? SAVED.explored : []);

/* mission state (spec: "Missions") — also part of the pilot file. 512 flags:
 * set/clear codes address bits 0–511 (0–511 set, 1000–1511 clear), and përs
 * MissionBit likewise ranges 0–511, so the store must span the full range. */
const missionBits = new Uint8Array(512);
if (SAVED && SAVED.bits) for (const b of SAVED.bits) missionBits[b] = 1;
let gameDay = SAVED ? (SAVED.day || 0) : 0;
// Real-world epoch the pilot was created, so the displayed in-game date is
// stable across sessions (legacy saves without it fall back to now).
let pilotBorn = SAVED && SAVED.born ? SAVED.born : Date.now();
// Pilot & ship names (set at New Pilot) and Strict Play (permadeath) flag.
let pilotName = SAVED && SAVED.name || '';
let shipName = SAVED && SAVED.shipName || '';
let strictPlay = SAVED ? !!SAVED.strict : false;
/* legal record per govt (spec: "Legal record") — negative = evil, positive
 * = good; defaults to each govt's InitialRec. Missions and combat move it. */
const reputation = SAVED && SAVED.rep ? { ...SAVED.rep } : {}; // govtId -> record
let kills = SAVED ? (SAVED.kills || 0) : 0; // total crew destroyed → combat rating
const dominated = new Set(SAVED ? SAVED.dominated : []); // spob ids subdued for tribute
// përs (named characters) that have been "spent" — a one-shot character whose
// mission you accepted (deactivateAfterLinkMission) won't reappear.
const persDone = new Set(SAVED && SAVED.persDone ? SAVED.persDone : []);
// përs who hold a grudge (you attacked them): they won't offer you work again.
const persGrudge = new Set(SAVED && SAVED.persGrudge ? SAVED.persGrudge : []);
/* active missions: resolved, live copies (not the raw records) */
let activeMissions = SAVED && SAVED.missions ? SAVED.missions.map(m => ({ ...m })) : [];
/* player-owned escorts (spec: "Escorts") — allied ships that follow the
 * player, fight the player's enemies, and persist across jumps/landings.
 * Saved as {id, shipId, name}; the live AI entity is respawned each system. */
// Declared here (before the save/load helpers that reference it); the
// hull-existence filter is deferred until after `const ships` exists, since
// `ships` is a const declared later in this module — reading it here would hit
// the temporal dead zone and throw when loading a saved pilot that has escorts.
let escorts = SAVED && SAVED.escorts ? SAVED.escorts.map(e => ({ ...e })) : [];
let escNextId = escorts.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;

let storageWarned = false;
function savePilot(spobId) {
  if (TEST_MODE) return;
  if (!Save.write(Save.capture(spobId)) && !storageWarned) {
    storageWarned = true;
    showMsg('Warning: browser storage unavailable — your pilot will not be saved.');
  }
}
function newPilot() { // abandon the current pilot → back to the title
  Save.clear();
  location.href = location.pathname;
}
/* ---- New Pilot creation (spec: "New pilot") ---- */
const nameSuggest = kind => { // a random default, from the app's STR# 128 or a generic
  const list = NAMES && NAMES[kind];
  if (list && list.length) return list[Math.floor(Math.random() * list.length)];
  return kind === 'pilots' ? 'New Pilot' : 'Star Voyager';
};
const shipLongName = () => (DATA.strings[5002] && DATA.strings[5002].list[playerShipId - 128])
  || (ships[playerShipId] && ships[playerShipId].name) || 'ship';
/* Two-step New Pilot flow, echoing the original: name yourself (with the
 * Strict Play permadeath option), then christen the starting Shuttlecraft. */
function startNewPilot() {
  openNameDialog({
    prompt: "What's your name, pilot?", value: nameSuggest('pilots'), strict: true,
    onOk: (name, strict) => openNameDialog({
      prompt: `Christen your new ${shipLongName()}:`,
      value: nameSuggest('ships'), strict: false,
      onOk: ship => createPilot(name.trim() || nameSuggest('pilots'),
                                ship.trim() || nameSuggest('ships'), strict),
    }),
  });
}
function createPilot(name, ship, strict) {
  if (!Save.write(Save.fresh(name, ship, strict))) {
    showMsg('Could not create the pilot — browser storage is unavailable.'); return;
  }
  try { sessionStorage.setItem('ve_newpilot', '1'); } catch {} // jump past the splash after reload
  location.reload(); // reload restores the new pilot
}
function openNameDialog(cfg) {
  const el = document.getElementById('npilot');
  const strictHtml = cfg.strict
    ? `<label class="npstrict"><input type="checkbox" id="npStrict"><b>Strict Play</b></label>
       <div class="npnote">Permadeath: if this pilot dies, it's gone for good — no restoring from a save.</div>`
    : '';
  el.querySelector('.card').innerHTML =
    html`<div class="nprow">
       <img class="npicon" src="evassets/graphics/PICT_${5000 + (playerShipId - 128)}.png" onerror="this.style.display='none'">
       <div class="npmsg">${cfg.prompt}</div>
     </div>
     <input type="text" id="npName" maxlength="63" spellcheck="false" autocomplete="off">
     ${raw(strictHtml)}
     <div class="npbtns"><button id="npCancel">Cancel</button><button id="npOk" class="primary">OK</button></div>`;
  el.style.display = 'flex';
  const input = document.getElementById('npName');
  input.value = cfg.value; // set as a property, not an HTML attribute — no quote/markup injection
  input.focus(); input.select();
  const close = () => { el.style.display = 'none'; };
  const ok = () => { const v = input.value, s = document.getElementById('npStrict'); close(); cfg.onOk(v, s ? s.checked : false); };
  document.getElementById('npOk').onclick = ok;
  document.getElementById('npCancel').onclick = close;
  // keep typing from reaching the title's global key-swallow
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') ok(); else if (e.key === 'Escape') close(); };
}

const ships = DATA.types.ship;
// Deferred from the escorts init above (needs `ships`): drop saved escorts whose
// hull this data set no longer defines.
escorts = escorts.filter(e => ships[e.shipId]);
const dudes = DATA.types.dude;
const systs = DATA.types.syst;

const SHIP_SPIN_BASE = 128, STELLAR_SPIN_BASE = 300;
const spinOfShip = shipId => SHIP_SPIN_BASE + (shipId - 128);
const spinOfSpob = p => STELLAR_SPIN_BASE + p.Type;

/* ---------------- sprites ---------------- */

const sprites = new Map(); // spinId -> {img, meta, ready}
function preloadSprites(spinIds) {
  for (const id of spinIds) {
    const meta = MANIFEST.spins[id];
    if (!meta || sprites.has(+id)) continue;
    const img = document.createElement('img');
    img.src = 'evassets/sprites/spin_' + id + '.png';
    img.style.display = 'none';
    document.body.appendChild(img);
    const entry = { img, meta, ready: img.complete };
    img.onload = () => { entry.ready = true; };
    sprites.set(+id, entry);
  }
}
function drawSpin(ctx, spinId, x, y, headingDeg) {
  const s = sprites.get(spinId);
  if (!s || !s.ready) return;
  const { frameW, frameH, xTiles, frames } = s.meta;
  const fi = EV.frameIndex(headingDeg, frames);
  ctx.drawImage(s.img, (fi % xTiles) * frameW, Math.floor(fi / xTiles) * frameH,
    frameW, frameH, x - frameW / 2, y - frameH / 2, frameW, frameH);
}
/* Plain single-image PICT cache (target pics 3000+, etc.), drawn fit to a
 * box centred on (cx, cy). */
const gfxCache = new Map();
function gfxImg(pictId) {
  let e = gfxCache.get(pictId);
  if (!e) {
    const img = new Image();
    img.src = 'evassets/graphics/PICT_' + pictId + '.png';
    e = { img, ready: img.complete };
    img.onload = () => { e.ready = true; };
    img.onerror = () => { e.bad = true; };
    gfxCache.set(pictId, e);
  }
  return e;
}
function drawGfxFit(ctx, pictId, cx, cy, maxW, maxH) {
  const e = gfxImg(pictId);
  if (!e.ready || e.bad || !e.img.naturalWidth) return false;
  const s = Math.min(maxW / e.img.naturalWidth, maxH / e.img.naturalHeight, 1);
  const w = e.img.naturalWidth * s, h = e.img.naturalHeight * s;
  ctx.drawImage(e.img, cx - w / 2, cy - h / 2, w, h);
  return true;
}

/* ---------------- world (per-system state) ---------------- */

let syst, spobs, aiShips, systEpoch = 0;

function spinsNeededFor(systId) {
  const s = systs[systId];
  const need = new Set([spinOfShip(playerShipId)]);
  for (const [id, p] of Object.entries(DATA.types.spob))
    if (p.System === +systId) need.add(spinOfSpob(p));
  for (let i = 1; i <= 4; i++) {
    const d = dudes[s['DudeTypes' + i]];
    if (d) for (let j = 1; j <= 4; j++)
      if (d['ShipTypes' + j] >= 128) need.add(spinOfShip(d['ShipTypes' + j]));
  }
  return need;
}

function loadSystem(systId) {
  SYSTEM_ID = +systId;
  syst = systs[SYSTEM_ID];
  explored.add(SYSTEM_ID);
  systEpoch++;
  spobs = Object.entries(DATA.types.spob)
    .filter(([, p]) => p.System === SYSTEM_ID)
    .map(([id, p]) => ({ id: +id, x: p.xPos, y: p.yPos, ...p }));
  aiShips = [];
  shots = []; beams = []; explosions = [];
  navTarget = null; shipTarget = null;
  alertGrace = 45; prevHostiles = 0; // don't red-alert the ambient population
  preloadSprites(spinsNeededFor(SYSTEM_ID));
  // Landscapes for this system's spobs (default 10000+Type and custom),
  // so the planet screen never shows without its picture.
  for (const p of spobs)
    for (const id of [10000 + p.Type, p.CustPicID].filter(v => v >= 0)) {
      if (document.getElementById('scape' + id)) continue;
      const img = document.createElement('img');
      img.id = 'scape' + id;
      img.src = 'evassets/titles/PICT_' + id + '.png';
      img.style.display = 'none';
      img.onerror = () => img.remove();
      document.body.appendChild(img);
    }
  const n = Math.min(Math.max(syst.AvgShips, 2), 8);
  for (let i = 0; i < n; i++) spawnAI(false);
  // NB: the player's escorts are spawned by the *caller*, after it has placed
  // the player (arrival edge / launch pad) — see spawnEscorts(). Spawning here
  // would use the player's stale pre-arrival coordinates.
  // missions: AvailRandom rerolls per arrival; place this system's ships;
  // mark observe goals satisfied when we arrive in the right system.
  availRandom = {};
  resolvedOffers = {}; // fresh mission destinations/cargo/deadlines per system
  for (const A of activeMissions) {
    maybeSpawnMissionShips(A);
    if (A.shipGoal === 4 && !A.observed) {
      const sys = A.shipSyst;
      if ((sys >= 128 && sys === SYSTEM_ID) ||
          (A.travelStel && spobById(A.travelStel) && spobById(A.travelStel).System === SYSTEM_ID)) {
        A.observed = true;
        showMsg(`${misnName(misns[A.id], A)}: target observed — return for payment.`);
      }
    }
  }
  maybeSpawnPers(); // a named character may be here with a job (after AvailRandom reset)
}

