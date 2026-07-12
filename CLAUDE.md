# CLAUDE.md

**Vₑ** (`V_e`, "vee-sub-e") — clean-room reimplementation of Escape
Velocity (Ambrosia, classic Mac). The name is the physics symbol for
escape velocity, and EV backwards.
Browser-first engine (DOM-free flight core in pure JS). The engine is ours;
the game data is not — see "Data hygiene" below. (An old C++/SDL port was
dropped to focus on the browser; it's preserved on the unmerged `sdl-port`
branch.)

## Git workflow

- Create a new branch for each piece of work; never commit directly to main.
- Commit as Misha (`Misha Nasledov <misha@nasledov.com>`). Do NOT add
  Co-authored-by tags or any AI attribution.
- Review feedback on a branch goes in separate commits — don't amend or
  squash the commits under review.
- Stacked branches are **rebased on top of each other, never merged** —
  keep history linear. When an earlier branch in the stack gains commits
  (e.g. review fixes), rebase each later branch onto the new tip, in
  stack order.

## Commands

Run `npm install` once (dev dependency: esbuild, which bundles the ES-module
engine core and shell). A top-level `Makefile` wraps the common ones: `make`
builds flight.html (bundling both `engine/core.bundle.js` and
`engine/shell.bundle.js` first), plus `make galaxy`/`data`/`assets`/`schemas`/
`selftest`/`verify`/`clean` (`make help` lists targets). The raw commands are below.

```sh
npm install                                              # esbuild devDependency
make engine/core.bundle.js engine/shell.bundle.js        # esbuild the ES modules
node evrsrc.js selftest                                  # resource-fork lib sanity
node tmpl2schema.js "EV_data/EV Data.rsrc" -o schemas/   # regenerate schemas (rarely needed)
node evexport.js "EV_data/EV Data.rsrc" -o evdata.json --semantic   # game DB
node evexport.js "EV_data/EV Data.rsrc" --map galaxy.html            # galaxy viewer
node evexport.js "EV_data/EV Data.rsrc" --flight flight.html         # THE GAME (browser)
./evconvert.sh EV_data evassets   # PICT/snd → PNG/WAV (needs resource_dasm, ImageMagick)
./evsprites.sh evassets           # composite sprite+mask → transparent sheets
node loader/verify.js             # check the loader's in-browser decoders vs native
```

Headless UI verification: `firefox --headless --screenshot out.png
"file://…/flight.html?<params>"`. Test affordances are URL params:
`?map=1 ?dest= ?jump=1 ?land=1 ?exchange=1 ?outfitter=1 ?shipyard=1 ?tab=1
?nav=1 ?ff=N ?syst= ?ship= ?x/y/heading`.

## Architecture

- `evrsrc.js` — zero-dep resource-fork library (MacBinary/AppleDouble/raw),
  MacRoman handling, schema-driven record decode, fork *writing* (buildFork,
  reserved for pilot files). Everything else builds on it.
- `schemas/*.json` — GENERATED from the TMPL resources inside EV's own data
  file by tmpl2schema.js. Never hand-edit; regenerate.
- `semantics.js` — meaning for raw fields (flag bits, enums, ID conventions),
  sourced from the EV Resource Bible (local copy in EV_data/). Facts, not
  copyrighted expression → committed.
- `evexport.js` — full DB → evdata.json (`--semantic` adds `$sem`
  annotations); also builds galaxy.html / flight.html by placeholder
  injection into the *_template.html files.
- `engine/ENGINE_SPEC.md` — **normative** flight/AI/game rules, implemented by
  `engine/core.js`, a DOM-free **ES module** (importable in node). Any behavior
  change: spec first, then the core.
- `engine/core.bundle.js`, `engine/shell.bundle.js` — GENERATED (gitignored):
  esbuild bundles the ES modules into IIFEs. core.bundle.js exposes its exports
  as the browser global `EV`; shell.bundle.js is the shell payload. Built by
  `make` and shipped in releases; the in-browser loader fetches them, so a deploy
  must build them first. Never hand-edited.
- `flight_template.html` — browser shell HTML/CSS + a script with `/*__ENGINE__*/`
  (core.bundle.js) and `/*__SHELL__*/` (shell.bundle.js) placeholders; the built
  `flight.html` injects both bundles and the game DATA/MANIFEST/NAMES into it.
  The shell bundle reads DATA/MANIFEST/NAMES and the global `EV` from the
  enclosing template `<script>` (they stay ambient globals, not imports).
- `engine/shell/*.js` — the flight shell (canvas render, DOM dialogs, game
  state/UI), **real ES modules** split by domain (state, spawning, sound, combat,
  …); entry `main.js` lists them in load order and esbuild bundles them. Each
  module exports what others use and imports what it needs. `01-state.js` is the
  **leaf** (imports nothing from other shell modules) and holds `S`, the shared
  mutable-state object — cross-module reassigned state lives on `S` because ES
  imports are read-only bindings. Keep 01 a leaf so it initializes first.
- Per-ship PICTs (index = shïp−128): target schematic 3000+i, hail comm
  portrait 5300+i, shipyard detail 5000+i, outfit detail 6000+i.
- Asset conventions (spec "Sprite ID conventions"): ship spïn = shïp ID,
  stellar spïn = 300+Type, landscape PICT = 10000+Type (CustPicID
  overrides), shop art PICT 5000+i/6000+i, menu sheets 5100/6100, sidebar
  panel PICT 128 in Titles. evconvert.sh writes suffix-free PICT_<id>.png
  aliases — ID-based lookups rely on them.

## Data hygiene (legal)

`EV_data/`, `evdata.json`, `evassets/`, `galaxy.html`, `flight.html` are
copyrighted Ambrosia content or contain it — gitignored, never commit,
never host. The repo must stay data-free (NovaJS/Kestrel posture). See
README "Legal shape of the project" and "Distribution".

## Known approximations (flagged for verification)

- Physics conversions (Speed/100 px/frame, Accel/9000 px/frame², Maneuver
  °/frame) are tuned for feel, not measured against the original. The sim
  runs at 60Hz: per-frame values were tuned at 30Hz, but the tick rate was
  doubled so real-time pace matches the original (30Hz was half-speed — it
  only matched with the 2× pill held).
- Commodity price multipliers 0.80/1.00/1.25 are community values; the
  bible names levels only. Ship trade-in (25% of hull+upgrades) IS from
  the bible.
- Homing turn rate (3°/frame) and warship AI distance bands (260/120 px)
  are approximations; the damage formula itself is bible-exact.
- Legal-record spread constants (`SPREAD_PROB` ≈¼, `SPREAD_FRAC` 0.4 in
  `13-legal.js`) are tuned: classic EV scatters a legal change randomly
  across the affected govt's systems (calibrated from real save diffs —
  ~26% of Confed / ~31% of enemy systems moved), but the exact per-system
  magnitude/probability isn't documented. The per-system storage, the
  enemy-inversion sign, and the current-system-always rule ARE from the data.

## Gotchas

- The sandbox used for development wipes everything outside mounted dirs
  between shell calls; resource_dasm lives outside the repo (build it
  locally; evconvert.sh expects it on PATH or $RESOURCE_DASM).
