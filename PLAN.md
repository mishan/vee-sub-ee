# Escape Velocity engine — project plan

Goal: clean-room engine that plays classic EV from user-supplied original
data files. Data layer stays engine-agnostic JSON; platform (C++/SDL vs
browser) deliberately undecided until sprites are on screen.

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

- **Milestone: flight demo, browser leg of the platform spike**
  (`flight_template.html` → `evexport --flight flight.html`, sprites via
  `evsprites.sh`): one-system flight with 30Hz fixed-step physics from raw
  shïp stats, 36-frame rotation sprites, retrograde autopilot (↓, like the
  original), AI traders from the düde table, IFF radar, landing overlay
  with real dësc text. Verified headless (deterministic first frame).
  Physics conversions (Speed/100 px/frame, Accel/10 px/s², Maneuver as
  °/frame) are approximations — tune against original-engine timings.

- **Milestone: platform spike, both legs.** `cpp/` holds the C++/SDL2 demo
  (single main.cpp + vendored stb_image/nlohmann-json/font8x8; only dep is
  libsdl2-dev). Line-for-line port of the browser leg's physics and entity
  logic; same CLI knobs as the URL params; `make test` renders headless
  via the dummy video driver. Verified: rotation frames, AI traders,
  radar, landing prompt all match the browser leg pixel-for-concept.
  Both legs consume identical artifacts: evdata.json + manifest.json +
  composited sprite PNGs — the data pipeline is the shared layer.

- **Decision: browser-first**, SDL kept alive as a port (easier sharing won).
- **Milestone: shared engine spec.** `engine/ENGINE_SPEC.md` is normative;
  `engine/core.js` (injected into flight.html at build, require-able in
  node) and `cpp/main.cpp`'s free functions implement it. Golden trace:
  `engine/scenario.json` + `check_traces.js` — 645 values over 420 frames
  (controls script + full AI state machine), agreement within 1e-6
  (measured worst Δ 6.75e-13).
- **Milestone: hyperjump + map** (browser leg). M = galaxy map overlay
  (all systems, links, current/destination rings, linked systems
  clickable), J = jump autopilot (align → accelerate → 30-frame streak →
  arrival 1800 px out on the inbound bearing). 100 fuel per jump, landing
  refuels. Headless-verified: map overlay, mid-jump, and post-arrival
  (Sol → Centauri, fuel 400→300). SDL port of jump/map is pending — the
  core pieces (stepJumpEngage/placeAtArrival) are spec'd and in core.js.

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

- **Milestone: SDL parity.** cpp/main.cpp rewritten to match the browser
  shell: Game Panel HUD, targeting/hails/brackets, fog-of-war map with
  click-to-select destinations, hyperjump, landing screen with landscape,
  exchange + grid-layout outfitter/shipyard, full economy state. Same
  test flags as the browser URL params; golden trace still green
  (worst Δ 6.75e-13). Gotcha for posterity: nlohmann's const operator[]
  asserts on missing keys ($sem.prices omits untraded commodities) — all
  lookups go through find()-based helpers now.

## Next

1. **Combat**: wëap stats + shïp Weap slots are decoded, the target
   display already shows shields — projectiles, damage model (shield →
   armor → disabled/boom via bööm/öops), düde warship AI, and the
   outfitter's weapons becoming real. This is the big one.
2. **Distribution loader** (see README "Distribution"): data-free hosted
   page that accepts a user-built asset bundle (zip of evdata.json +
   evassets), cached client-side. Add an `evexport --bundle` command.
3. **Then**: missions (mïsn + mission bits, bar) → persistence (pilot
   file read/write via `buildFork` — credits, cargo, outfits, explored
   set all live in player state now).

## Notes

- `EV_1.0.5/Escape Velocity.rsrc` (the app itself) holds UI resources and
  possibly more TMPLs (dsïg, spït came from EV Data) — mine when needed.
- `EV Plug-Ins/EV Tuner.rsrc` is a tiny real plugin — good regression input.
- Legal posture unchanged: engine ships zero Ambrosia data; `galaxy.html`
  and `evdata.json` are local build artifacts, not distributables.
