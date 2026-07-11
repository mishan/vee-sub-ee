# Vₑ (Escape Velocity engine) — project plan

Goal: clean-room engine that plays classic EV from user-supplied original
data files. Browser-first; the data layer is engine-agnostic JSON and the
flight core is DOM-free JavaScript.

## Done

- **Stage 1–2, extraction** (`evrsrc.js`): MacBinary / AppleDouble / raw fork
  → resource map → raw resources. Round-trip `buildFork` for later
  pilot-file editing.
- **Stage 3, layouts** (`tmpl2schema.js`): schemas generated from the TMPL
  resources inside `EV Data.rsrc` itself — authoritative, not reconstructed.
  All 17 record types; every fixed size matches observed records exactly.
- **Stage 4, database** (`evexport.js`): full decode to `evdata.json` —
  1,486 records + 66 STR# lists, zero length warnings. Integrity checked:
  278/278 hyperlinks resolve, 107/107 spobs reference valid systems, every
  spob has a landing dësc at the matching ID.
- **Milestone: galaxy map** (`galaxy_viewer.html` / `galaxy.html`): pan/zoom
  canvas, hyperlink graph, govt coloring, per-system panel with planets and
  landing text.
- **Milestone: graphics pipeline** (`evconvert.sh` + `evatlas.js`): all
  PICT/cicn/ppat → PNG (574 images), all `snd ` → WAV (63), sprite atlases
  joined from `spïn` records into `evassets/manifest.json` — 81/81 spïns
  resolved, every sheet's dimensions match its tile grid. Visually
  verified (ship rotation sheets, masks, landing landscapes).
- **Milestone: semantic layer** (`semantics.js`, sourced from Matt Burch's
  EV Resource Bible — local copy in `EV_data/`): spöb/gövt/mïsn/përs flag
  bits, commodity price nibbles, wëap guidance + oütf ModType + AI enums,
  spïn ID conventions (ships 128+, weapons 200+, stellars 300+, explosions
  400+), STR# roles. `evexport --semantic` adds `$sem` annotations with
  resolved cross-references; the galaxy viewer shows services/prices.
  Verified against classic data (107/107 spöb flag values conform; fighter
  bays resolve to the right ships). Classic delta found: wëap Guidance 2 is
  a second homing type (Missiles/Seeker Drones vs Torpedos at 1), though
  Override's bible calls it unused.

- **Milestone: flight demo**
  (`flight_template.html` → `evexport --flight flight.html`, sprites via
  `evsprites.sh`): one-system flight with 30Hz fixed-step physics from raw
  shïp stats, 36-frame rotation sprites, retrograde autopilot (↓, like the
  original), AI traders from the düde table, IFF radar, landing overlay
  with real dësc text. Verified headless (deterministic first frame).
  Physics conversions (Speed/100 px/frame, Accel/10 px/s², Maneuver as
  °/frame) are approximations — tune against original-engine timings.

- **Decision: browser-first.** The DOM-free `engine/core.js` is the flight
  core, injected into `flight.html` at build and require-able in node. (An
  early C++/SDL port was kept in lockstep — same logic, a golden-trace check
  enforcing agreement — for much of development, then dropped to focus on the
  browser, which is the interesting part. It's preserved on the unmerged
  `sdl-port` branch, revivable from there or from git history.)
- **Milestone: engine spec.** `engine/ENGINE_SPEC.md` is the normative
  description of flight physics and AI behavior; `engine/core.js` implements
  it. Change behavior in the spec first, then the core.
- **Milestone: hyperjump + map** (browser leg). M = galaxy map overlay
  (all systems, links, current/destination rings, linked systems
  clickable), J = jump autopilot (align → accelerate → 30-frame streak →
  arrival 1800 px out on the inbound bearing). 100 fuel per jump, landing
  refuels. Headless-verified: map overlay, mid-jump, and post-arrival
  (Sol → Centauri, fuel 400→300).

- **Milestone: landing UI + trading** (browser). Planet screen with
  landscape PICT (CustPicID), landing text, services line, and a working
  commodity exchange: prices = spöb nibbles × STR# 4004 base × 80/100/125%
  (spec'd; multipliers are community values, flagged for verification),
  constrained by credits and cargo tons. Player state started: 10,000 cr,
  cargo hold, fuel. Also: arrival distance 1800→700, start system → Levo
  (classic), map fog of war (explored set; adjacent systems labeled +
  clickable, unexplored = anonymous dots). All headless-verified.

- **Milestone: outfitter + shipyard** (browser). Service-dialog framework
  on the planet screen (exchange/outfitter/shipyard share it). Outfitter:
  tech-gated oütf list (STR# 5000 names), FreeMass/Max/credit limits,
  ModType effects recomputed into live player stats (cargo, fuel, shield,
  armor, accel, speed, turn — negative-mass Mass Expansion works). Ship
  purchases per the bible: trade-in = 25% of hull + upgrades, outfits
  don't transfer, cargo must fit. Also: targeting UX round 2 — Esc clears
  ship then nav target in flight; takeoff clears the landing target.

- **Milestone: combat** (spec'd). Bible-exact
  damage model (shields up: Mass/4+Energy; down: Mass+Energy/4; min 1;
  disabled at ⅓ armor, flag 0x10 → 10%), shield regen (1%/ShieldRe
  frames), projectiles with inherited velocity (unguided/turret/quadrant/
  homing @3°/frame/freefall/rocket), beams, ammo pools (AmmoType), stock
  loadouts + outfitter weapons/ammo, Impact knockback, ExplodType
  explosions (spïns 400-402), DeathDelay disintegration, warship AI
  (charge/fly-by/fire-in-range), trader flee/brave reactions, govt
  hostility (xenophobic/alwaysAttacksPlayer) + player grudges, player
  death + restart. Panel: real shield bar, target shields %/DISABLED,
  secondary weapon pane (name + ammo available/capacity — classic
  behavior, replacing an incorrect message mirror).
  Deferred: BlastRadius area damage, friendly-fire between AI ships,
  bööm/öops sounds. (Fighter bays landed later — see below.)

- **Milestone: audio** (browser). Spec'd
  ("Audio"): weapon fire snd 200+Sound per volley w/ distance attenuation
  (1 − d/1200), Warp Up/Out on jump, Med/HeavyExplosion on impacts,
  ShipBreaksUp + ShipExplodes on kills, target beeps, shield-collapse
  Klaxxon, planet ambient loops from CustSndID (Thunder/Seagull/
  Sandpiper are real!). No thrust sound — classic flight is silent
  (review finding: snd 223 "Engine" is the Forklift's weapon sound,
  200+Sound 23; the name fooled a first pass).
  V toggles, ?mute=1. Plain Audio elements — file:// safe, unlocked by
  first keypress. snd_<id>.wav aliases added to evconvert.sh. Title
  music (30000+) waits for a title screen.

- **Milestone: persistence** (browser). Classic pilot behavior: auto-save
  on landing and takeoff (localStorage `ve_pilot`: system, docked spöb,
  ship, credits, cargo, outfits, explored). Load restores you docked
  where you last saved; death offers R (return to last landing) or N
  (new pilot); `?new=1` resets. Test params suppress both restore and
  save so headless runs can't clobber a real pilot. Also on these
  branches: master volume ([ / ] keys, persisted as `ve_volume`).
  Note: the real Mac pilot-file format (via evrsrc buildFork) remains a
  future compatibility goal; this is the gameplay-persistence layer.

- **Milestone: missions** (browser). The mïsn resource — a faithful,
  completable subset. Mission bits (512, persisted), day counter (advances
  per jump), availability (AvailStel incl. govt codes, AvailBitSet/Clr,
  AvailRandom rerolled per arrival, ship-type Flags 0x2000/0x4000). Bar +
  Mission-BBS boards on the landing screen with briefing text, accept/
  decline. Goals: cargo delivery (pickup/dropoff modes, hold accounting),
  destroy/chase-off/observe special ships (spawned from ShipDude, reuse
  combat), plain go-to. Completion at ReturnStel pays PayVal (credits /
  outfit grants / cash-%), sets CompBitSet, adjusts reputation; failure on
  time-limit expiry. I-key briefing, <DST>/<RST> text substitution,
  persistence of the whole mission state. Classic-vs-Nova gotcha:
  classic misn lacks CompBitSet4/FailBitSet2/AvailShipType (Nova fields);
  missing fields treated as −1.

- **Milestone: mission display fixes + plot branching** (browser). Review
  fixes: random fields (special stellar codes like 20000+g, ±50% cargo,
  deadlines) are resolved ONCE per offer and cached, so briefings show the
  real destination/cargo/date instead of "stellar 20002"/"−10t"/blank;
  full token substitution in briefs and mission NAMES ("Ferry Passengers
  to <DST>" → "…to Sirius Station"); fixed a double-subst bug. Then the
  remaining goal types — board (B key on a disabled target), disable,
  escort (protect to destination), rescue (board a pre-disabled ship) —
  which is what unblocks the storyline: the Astex opener at Diphidia II
  now runs its full chain (Investigate Dumping → Observe Antares →
  Capture Ore Sample → Destroy Freighters → Escape Astex) via CompBitSet→
  AvailBitSet gating. 49 chaining bits over 72 gated missions in the data;
  no new machinery beyond bit gating — the goals just all had to work.
  Deferred: ship-offered missions (AvailLoc 2), aux ships, combat-rating/
  legal-record gates.

- **Milestone: legal record & encounters** (browser). Per-govt legal
  record (persisted, InitialRec default) with STR# 134 status labels
  scaled by CrimeTol (bible App. II); combat rating from crew killed
  (STR# 138 / App. I). Combat consequences: disable/board/kill penalties
  off the victim govt (+half to allies), enemy-kill rewards, and a
  local-govt bonus for killing xenophobic pirates (so hunting pirates
  raises standing). Criminals (record < −CrimeTol) draw hostile govt
  warships; when criminal in-system, bounty hunters hyperspace in
  (named STR# 10008, capped by notoriety). Map shows the selected
  system's legal status + your combat rating; target panel labels bounty
  hunters. Verified: status ladder (Offender→Fugitive), map display,
  bounty-hunter encounter. NOTE: built on mission-polish, which was NOT
  actually merged to main (only mission-plot / PR #8 was) — merge
  mission-polish before this branch.

- **Milestone: mission rating/record gates** (browser). `AvailRating`
  (combat rating ≥) and `AvailRecord` (legal record with the spöb's govt:
  ≥ positive / ≤ negative / −32000 = dominated) now gate mission
  availability against the tracked rating/record — 43 rating-gated and 32
  record-gated missions were previously mishandled (rating-gated ones were
  always hidden; record-gated ones unchecked). Verified across all cases.

- **Milestone: title screen + music** (browser). Boot sequence echoes the
  original: a loading splash (PICT 131) with "Press any key to continue" →
  first gesture unlocks/starts the theme → brief hold → fade to the classic
  PICT 8000 menu (which fades in). Menu is a full-screen overlay; sim paused
  and gameplay hotkeys swallowed while splash/title is up. Transparent
  hotspots over the baked labels (New/Open Pilot, Enter Ship, Set Prefs,
  About, Quit); player ship rotates in the centre viewscreen; STR# 20000
  intro text behind About. Title theme (snd 30000, music/ set) loops from
  the splash gesture, race-safe on stop so it never bleeds into flight.
  Test params skip the intro; `?title`/`?splash` force the splash,
  `?titlemenu` the menu. Spec: "Title screen". Verified via headless
  screenshots + a scripted flow harness (key-swallow, gesture-started music,
  splash→title advance, sim paused, enter stops music).

- **Milestone: boarding** (browser). Boarding a disabled non-mission ship
  now opens a dialog (Capture / Loot / Leave) instead of instant credits.
  Loot follows the dude `Booty` flags (bible): commodities into free hold +
  money from the hull `Cost`; `Booty==0` ⇒ repelled; looted ships stay
  disabled but unboardable. Capture rolls a crew-ratio (`Crew` + Marines
  ModType 25, an approximation) — success takes command of the stock hull
  (old ship/outfits abandoned), failure self-destructs the prize; both apply
  `BoardPenalty`. Added the missing oütf ModTypes 23–26 to semantics. Spec:
  "Boarding". Verified via a scripted harness (loot credits/cargo + looted
  flag + unboardable, capture success→ship switch, failure→self-destruct)
  and a dialog screenshot.

- **Milestone: mobile / touch support** (browser). Viewport meta + touch
  detection (`?mobile=1/0` to force); landscape-only with a rotate nudge in
  portrait. Floating left-thumb joystick (absolute-heading steer + push-to-
  thrust) that synthesizes the same left/right/thrust booleans as the keyboard
  — flight core untouched. Fire button (clear of the sidebar
  panel) and an always-on top-centre mini bar (Target/Nav/Land/Board/Hail/Map/
  Jump/Missions/sound) wired to the existing handlers; joystick+fire hide on
  the galaxy map so canvas taps pick a destination; keyboard-hint bar hidden on
  touch. Controls show only while flying. Spec: "Touch controls". Verified via
  headless landscape/portrait screenshots + a scripted harness (steer→heading,
  push→thrust/speed, fire hold, bar actions, map hide).

- **Milestone: escorts, ship-offered missions, fighter bays** (browser; merged
  to main, PRs #24–#27). Player escorts: captured ships kept as companions
  (take command vs add to the fleet) and hire-for-fee escorts in the spaceport
  bar, both with follow/fight AI, per-jump upkeep, and persistence. Ship-offered
  missions (AvailLoc 2): eligible përs characters spawn in their `LinkSyst`
  systems and hail to offer work, with accept/refuse and the përs done/grudge
  bookkeeping; mission-bit store widened to the full 0–511 range so every
  `MissionBit` can gate a character. Fighter bays (weapon g99): launch and recall
  carried fighters, tracked as per-bay ammo, auto-recalled on jump; HUD bay
  count. Spec'd + headless-verified in the same branches.

- **Milestone: browser loader** (`loader/`) — the pure-web distribution path
  from README "Distribution", and better than the planned asset-bundle: the
  user drops their own Escape Velocity **`.sit`** on a page and it decodes and
  **plays entirely in the browser** — no command line, no external tools. Every
  native step is reimplemented in dependency-free JS: `evsit.js` parses the
  StuffIt 5 archive and decompresses its method-13 ("LZ+Huffman") forks (5/5
  byte-exact, ~200 ms for the ~8 MB archive; reimplemented from XADMaster's
  format, not code); `evpict.js` QuickDraw PICT → RGBA (471/471 pixel-exact vs
  `resource_dasm` — v1/v2, PackBits/BitsRect + region variants, DirectBits
  16/32-bit, tiled multi-op pictures); `evsnd.js` `snd ` → PCM (59/59
  byte-exact); `evsprite.js` sprite+mask → transparent sheet (79/81 byte-exact
  incl. alpha). `evbuild.js` builds the engine `DATA` (byte-identical to
  `evexport`) + sprite `MANIFEST`; `launch.js` renders every asset to a PNG/WAV
  in Cache Storage, assembles `flight.html` (inject `DATA`/`MANIFEST` +
  `core.js`, exactly like `evexport --flight`), and a **service worker**
  (`sw.js`) serves `evassets/*` so the **unmodified engine** runs. `nodeshim.js`
  (a tiny `Buffer` shim) + dual-mode guards let `evrsrc.js`/`semantics.js` serve
  both the Node build and the browser. The bundled installer is Installer VISE
  (`SVCT`, proprietary, no open tooling) — the `.sit` is the source. Verified:
  `node loader/verify.js` checks every stage against the native pipeline; the
  in-browser-assembled `flight.html` boots a full playable game against real
  assets (headless screenshot); the SW's cached serving is verified
  cross-instance. **First-run caching** is in: a versioned completion marker in
  Cache Storage lets a return visit replay the built game without re-importing
  the `.sit`. Format notes + credits in `loader/README.md`. Remaining polish:
  PWA install + an "export bundle" button, read name suggestions from the app's
  STR# 128, 2 cosmetic edge-alpha sprites.

## Next

1. **Distribution loader — polish** (core + first-run caching delivered; see the
   loader milestone and `loader/README.md`): PWA install + an "export bundle"
   button, and optional original name suggestions (STR# 128 from the app inside
   the `.sit`).
2. **Also open**: real Mac pilot-file read/write via `buildFork` (import/export
   original EV pilots); BlastRadius area damage and other deferred combat bits.

## Notes

- `EV_1.0.5/Escape Velocity.rsrc` (the app itself) holds UI resources and
  possibly more TMPLs (dsïg, spït came from EV Data) — mine when needed.
- `EV Plug-Ins/EV Tuner.rsrc` is a tiny real plugin — good regression input.
- The old C++/SDL port lives on the unmerged `sdl-port` branch if it's ever
  wanted again (with its golden-trace harness); dropped to keep focus on the
  browser build.
- Legal posture unchanged: engine ships zero Ambrosia data; `galaxy.html`
  and `evdata.json` are local build artifacts, not distributables.
