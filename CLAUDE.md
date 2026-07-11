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
engine core). A top-level `Makefile` wraps the common ones: `make` builds
flight.html, plus `make galaxy`/`data`/`assets`/`schemas`/`selftest`/`verify`/
`clean` (`make help` lists targets). The raw commands are below.

```sh
npm install                                              # esbuild devDependency
node_modules/.bin/esbuild engine/core.js --bundle --format=iife --global-name=EV \
  --footer:js='globalThis.EV=EV;' --outfile=engine/core.bundle.js   # engine → global EV
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
- `engine/core.bundle.js` — GENERATED (gitignored): esbuild bundles core.js into
  an IIFE that exposes the exports as the browser global `EV`. Built by `make` /
  `npm run build:engine` and shipped in releases; the in-browser loader fetches
  it, so a deploy must build it first. Never hand-edited. First step of an
  in-progress move to esbuild-bundled ES modules for the shell too.
- `flight_template.html` — browser shell HTML/CSS + a script with `/*__ENGINE__*/`
  (core.bundle.js) and `/*__SHELL__*/` placeholders; the built `flight.html`
  injects the engine bundle, the shell, and the game DATA/MANIFEST into it.
- `engine/shell/*.js` — the flight shell (canvas render, DOM dialogs, game
  state/UI), split by domain (state, spawning, sound, combat, input, …) for
  readability. `evexport --flight` and the loader **concatenate them in
  `engine/shell/order.json` order into one `<script>`**, so they share a single
  scope — edit them as one file split across files, not as ES modules (order
  matters: later files may reference earlier top-level declarations).
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
  °/frame @30Hz) are tuned for feel, not measured against the original.
- Commodity price multipliers 0.80/1.00/1.25 are community values; the
  bible names levels only. Ship trade-in (25% of hull+upgrades) IS from
  the bible.
- Homing turn rate (3°/frame) and warship AI distance bands (260/120 px)
  are approximations; the damage formula itself is bible-exact.

## Gotchas

- The sandbox used for development wipes everything outside mounted dirs
  between shell calls; resource_dasm lives outside the repo (build it
  locally; evconvert.sh expects it on PATH or $RESOURCE_DASM).
