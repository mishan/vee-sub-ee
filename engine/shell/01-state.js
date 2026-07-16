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
import { Hold } from './hold.js';
import { Outfits } from './outfits.js';
import { PilotStore } from './save.js'; // localStorage roster/slots (leaf); Save composes it
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
  'fuel',
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
  'firesec',
  'bar',
  'computer',
  'allmissions',
].some((k) => params.has(k));
/* The pilot save facade. capture() snapshots the live game state into the save
 * schema and fresh() builds a brand-new pilot — both read the state declared
 * below (they only run later, at save/create time, so the forward references are
 * fine). The roster/slot/localStorage machinery lives in the PilotStore leaf
 * (save.js) and is spread in here, so callers keep one `Save` object
 * (Save.capture, Save.load, Save.remove, …). The field list living in one place
 * is why savePilot/createPilot no longer each hand-roll the blob. */
export const Save = {
  capture(spobId) {
    return {
      v: 2,
      syst: S.SYSTEM_ID,
      spob: spobId,
      ship: S.playerShipId,
      credits: wallet.credits,
      cargo: hold.toJSON(),
      outfits: outfits.toJSON(),
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
      // Whether the new-pilot intro (launch graphic + story crawl) has played —
      // it runs once, the first time a brand-new pilot is flown. Preserved here so
      // a later land/takeoff save doesn't reset it and replay the intro. tutorial/
      // tutSeen track the onboarding hint banners the same way.
      introSeen,
      tutorial: tutorialActive,
      tutSeen: [...tutSeen],
      // Carry the stashed source file forward (set by the pilot importer) so the
      // pilot can be exported back to an original-EV file byte-faithfully.
      origin: SAVED && SAVED.origin,
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
  ...PilotStore, // migrateV1 + the roster/slot/localStorage methods (save.js)
};

export const SAVED = TEST_MODE ? null : Save.load();

S.SYSTEM_ID = SAVED ? SAVED.syst : +(params.get('syst') || 128); // Levo — the classic start
S.playerShipId = SAVED ? SAVED.ship : +(params.get('ship') || 128); // Shuttlecraft

/* player economy state (spec: "Trading") — the pilot file's contents */
export const COMMODITIES = ['food', 'industrial', 'medical', 'luxury', 'metal', 'equipment'];
export const PRICE_MULT = { low: 0.8, medium: 1.0, high: 1.25 };
export const wallet = new Wallet(SAVED ? SAVED.credits : 10000);
export const hold = new Hold(COMMODITIES, SAVED && SAVED.cargo);

export const outfits = new Outfits(SAVED && SAVED.outfits); // outf id -> count
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
// Whether the one-time new-pilot intro has played for this pilot (see 11-title's
// intro sequence). markIntroSeen() flips it and persists immediately.
export let introSeen = SAVED ? !!SAVED.introSeen : false;
export function markIntroSeen() {
  introSeen = true;
  Save.patch({ introSeen: true });
}
/* New-pilot onboarding tutorial (spec: "New-pilot intro"): a few one-time hint
 * banners. `tutorialActive` is armed only for pilots that played the intro, so
 * established pilots never see them; `tutSeen` records which steps have shown. */
export let tutorialActive = SAVED ? !!SAVED.tutorial : false;
export const tutSeen = new Set(SAVED && SAVED.tutSeen ? SAVED.tutSeen : []);
export function armTutorial() {
  tutorialActive = true;
  Save.patch({ tutorial: true });
}
export function markTutorialStep(step) {
  tutSeen.add(step);
  Save.patch({ tutSeen: [...tutSeen] });
}
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
// The New Pilot creation flow (the name dialog + nameSuggest/shipLongName/
// startNewPilot/createPilot/openNameDialog) moved to ui/pilot-create.js — DOM
// presentation doesn't belong in the state leaf. It's triggered from the title.

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

// The sprite/PICT image caches + canvas drawing (sprites/preloadSprites/drawSpin,
// gfxCache/gfxImg/drawGfxFit) moved to ui/sprites.js — presentation doesn't
// belong in the state leaf. The spin-id conventions (spinOfShip/spinOfSpob) stay
// above, as data, since half the shell needs them without touching the canvas.

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
