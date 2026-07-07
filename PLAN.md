# Vₑ (Escape Velocity engine) — project plan

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

- **Milestone: combat** (both legs, spec'd + golden-traced). Bible-exact
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
  behavior, replacing an incorrect message mirror). Golden trace now
  covers shots, damage, kick, and regen: 959 values, worst Δ 6.75e-13.
  Deferred: fighter bays (g99), BlastRadius area damage, boarding,
  friendly-fire between AI ships, bööm/öops sounds.

- **Milestone: audio, browser leg** (SDL deferred per Misha). Spec'd
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
  completable subset. Mission bits (256, persisted), day counter (advances
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

## Next

1. **Distribution loader** (deferred per Misha; see README "Distribution"):
   data-free hosted page that accepts a user-built asset bundle (zip of
   evdata.json + evassets), cached client-side. Add `evexport --bundle`.
2. **Also open**: SDL parity catch-up (audio, combat UI, missions),
   real Mac pilot-file read/write via `buildFork`, title screen + music.

## Notes

- `EV_1.0.5/Escape Velocity.rsrc` (the app itself) holds UI resources and
  possibly more TMPLs (dsïg, spït came from EV Data) — mine when needed.
- `EV Plug-Ins/EV Tuner.rsrc` is a tiny real plugin — good regression input.
- Legal posture unchanged: engine ships zero Ambrosia data; `galaxy.html`
  and `evdata.json` are local build artifacts, not distributables.
