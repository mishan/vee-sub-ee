# evrsrc — Escape Velocity data extraction pipeline

Zero-dependency Node.js tooling for reading classic Escape Velocity data
files and plugins on Linux. This is stage 1–2 of an engine reimplementation:
get the game's declarative data out of its Classic Mac OS container formats
and into structures a modern engine can consume.

## Usage

```sh
node evrsrc.js selftest                        # round-trip sanity check
node evrsrc.js info    "EV Data.bin"           # container + resource census
node evrsrc.js list    "EV Data.bin" ship      # IDs, sizes, names per type
node evrsrc.js extract "EV Data.bin" -o out/   # dump raw resources to disk
node evrsrc.js decode  "EV Data.bin" ship 128 --schema schemas/ship.json
node evrsrc.js strings "EV Data.bin" 200       # decode a STR# string list

node tmpl2schema.js "EV_data/EV Data.rsrc" -o schemas/   # regenerate schemas
node evexport.js "EV_data/EV Data.rsrc" -o evdata.json   # full game DB → JSON
node evexport.js "EV_data/EV Data.rsrc" --map galaxy.html # interactive galaxy map
```

Add `--semantic` to evexport to annotate records with `$sem` objects —
decoded flag bits, enums, and resolved cross-references from
`semantics.js` (sourced from the EV Resource Bible, verified against the
classic data; local bible copy in `EV_data/`).

## Flight demo

```sh
./evsprites.sh evassets                                      # composite sprite+mask → transparent PNGs
node evexport.js "EV_data/EV Data.rsrc" --flight flight.html # build the demo
```

Open `flight.html` (file:// works; it loads sprites from `evassets/`).
It's grown past a demo: you start in **Levo** (the classic start) with
10,000 credits and a Shuttlecraft. **M** opens the galaxy map — fog of
war: explored systems in full detail, adjacent ones labeled and clickable,
the rest anonymous dots. **J** engages the jump autopilot (100 fuel/jump;
landing refuels). **L** lands: the planet screen shows the landscape (when
the spöb has one), landing text, and a working commodity exchange — six
commodities, prices from the spöb's flag nibbles × STR# 4004 base prices
(low/med/high = 80/100/125%), constrained by cargo tons (shïp `Holds`) and
credits. The planet screen's Outfitter and Shipyard are live, in the
original grid-plus-detail layout: thumbnails sliced from the classic menu
sheets (PICT 5100 ships / 6100 outfits, 8×32px columns), 100×100 dialog
art (PICT 5000+i / 6000+i), tech-gated lists from the real oütf/shïp
records, outfit effects applied to your stats (FreeMass-limited,
negative-mass expansions included), ship trade-in at the bible's 25% of
hull + upgrades. (evconvert.sh writes suffix-free `PICT_<id>.png` aliases
for named PICTs so ID-based lookups always resolve.) Targeting: **L** selects
the nearest landable planet (green
brackets; press again in range + slow to land — denials explain
themselves), **N** cycles planets, **Tab** cycles ships (yellow brackets +
radar highlight); cycling past the farthest target clears it. **Y** hails
the target — ship hails pull from the govt-specific STR# greeting lists
(7000+govt), planets from the stellar comm strings (3002). The HUD is the
original sidebar art (PICT 128 "Game Panel" from EV Titles, box geometry
measured from the asset): square radar, shield/fuel bars in the panel's
own slots, message box, hyperspace strip, target display with the
target's live sprite, and the credits/cargo box. Dev/test URL params: `?map=1`, `?dest=<syst>`,
`?jump=1`, `?land=1`, `?exchange=1`, `?tab=1`, `?nav=1`, `?ff=<frames>`,
`?syst=`, `?ship=`, `?x/y/heading`.

**Engine spec:** flight physics and AI behavior are normatively documented
in `engine/ENGINE_SPEC.md` and implemented twice: `engine/core.js` (DOM-free,
injected into flight.html at build, `require`-able in node) and the free
functions in `cpp/main.cpp`. `node engine/check_traces.js` (or `make trace`
in cpp/) runs both against `engine/scenario.json` and requires agreement
within 1e-6 — change behavior in the spec first, then both legs, and the
trace keeps everyone honest.
The same demo also exists natively: `cd cpp && make && ./evflight --root ..`
(needs only `libsdl2-dev` — PNG loading, JSON, and the HUD font are
vendored single-header libs: stb_image, nlohmann/json, font8x8).
`make test` renders 90 frames headless (`SDL_VIDEODRIVER=dummy`) and dumps
a PNG. Same flags as the browser URL params: `--syst --ship --x --y
--heading`. The physics and entity logic are a line-for-line port of the
browser leg — evdata.json, manifest.json, and the sprite PNGs are the
shared layer; keep the two implementations in sync via the constants at
the top of each.
One-system flight: 30Hz fixed-step physics driven by the raw shïp record
(Speed/Accel/Maneuver), 36-frame rotation sprites, AI traders spawned from
the system's düde table flying planet-to-planet, IFF radar, and landing
(L near a landable spob) with the real landing description. URL params:
`?syst=129&ship=133&x=0&y=300&heading=0` — fly a Frigate anywhere.
Physics unit conversions are approximations flagged in the template for
tuning against original-engine timings.

`galaxy.html` is self-contained (data inlined): pan/zoom canvas of all 108
systems, hyperlink graph, govt coloring, and per-system detail panel with
planets and landing descriptions. `galaxy_viewer.html` is the data-free
template — it also accepts a dropped `evdata.json`, keeping the
no-shipped-data posture intact.

Also usable as a library: `require('./evrsrc.js')` exports `loadFork`,
`parseFork`, `decodeRecord`, `buildFork`, etc. `buildFork` means you can
also *write* resource forks — useful later for pilot-file editing or
converting plugins.

## Container formats handled

| Format | How it arrives | Detection |
|---|---|---|
| MacBinary (.bin) | Most downloaded plugins | Header sanity at bytes 0/74/82 + fork lengths |
| AppleDouble (`._foo`, `__MACOSX/`) | Files zipped on macOS | `0x00051607` magic |
| Raw resource fork | Extracted `.rsrc` | Header offset/length consistency |

`.sit`/`.cpt` StuffIt/Compact Pro archives must be expanded first — `unar`
(from unarchiver/XADMaster) handles both on Linux.

## Format notes for the engine work

- **Resource types** use MacRoman accented characters (Apple reserved
  all-ASCII types): `shïp` is bytes `73 68 95 70`. The CLI accepts ASCII
  aliases (`ship`, `spob`, `syst`, `weap`, `misn`, `dude`, `govt`, `spin`,
  `desc`, ...), literal UTF-8, or `hex:XXXXXXXX`.
- **IDs start at 128** by Mac convention; EV resources reference each other
  by these IDs (a `düde` points at `shïp` IDs, a `sÿst` at `spöb` and `düde`
  IDs, etc.), so the ID graph *is* the game database schema.
- **Record layouts** are plain big-endian structs. Layouts live in JSON
  schemas (`schemas/`). These are **generated, not hand-written**: EV's own
  data file ships ResEdit `TMPL` resources for all 17 game record types, and
  `tmpl2schema.js` converts them directly. Every generated schema's fixed
  size matches the observed record sizes exactly (shïp 74B, sÿst 72B,
  spöb 32B, wëap 30B, ...). The decoder still warns if schema and record
  length disagree. EV's templates use only six TMPL codes:
  DWRD/DLNG (signed 16/32), HWRD/HLNG (hex 16/32), RECT (4×i16),
  CSTR (variable NUL-terminated MacRoman text — the `dësc` body).
- **Classic EV/Override vs Nova**, the differences that matter for an engine:
  - Sprites: classic uses `spïn` resources pointing at PICT sprite-sheet +
    mask pairs; Nova added `shän` animation descriptors and `rlëD`
    (run-length-encoded) sprite data.
  - Nova hugely expanded records (`shïp`, `wëap`, `oütf`) and added a
    scripting layer via Nova Control Bits (test/set expressions embedded in
    mission fields) — classic EV has simple numeric mission bits.
  - The Windows port of Nova abandoned resource forks for BurgerLib `.rez`
    containers; same records, different envelope.
- **Don't reimplement QuickDraw.** For PICT and `snd ` decoding, feed the
  extracted resources to `resource_dasm` (fuzziqersoftware), which converts
  them to PNG/WAV. Reserve your effort for the game engine.

## Graphics pipeline

`./evconvert.sh EV_data evassets` runs the whole thing (needs
`resource_dasm`, ImageMagick, node): every PICT/cicn/ppat → PNG, every
`snd ` → WAV, then `evatlas.js` decodes the `spïn` records and writes
`evassets/manifest.json` — per-sprite PNG paths, frame size, tile grid,
frame count, each verified against actual PNG dimensions. Ship sprites are
6×6 sheets of 36 rotation frames + white-silhouette masks. Sounds are
8-bit/11kHz mono PCM. Notes: resource_dasm's default output is BMP (hence
the ImageMagick step) and it fails on paths containing spaces, so the
script stages files under simple names. `evassets/` is converted game data
— local artifact, not distributable.

## Authoritative layout references

1. The **Nova Bible** (`Nova Bible.txt`) and the classic **EV Bible** — the
   community-archived field-by-field docs, mirrored at
   escape-velocity.games/docs.
2. **EVNEW source** (same site) — C structs for all three games' records,
   battle-tested by the Windows plugin editor.
3. **ResForge** (github.com/andrews05) — maintained editor with TMPL
   definitions; also `vasi/evnova-utils` for pilot-file formats.

## Legal shape of the project

Engine: clean-room, yours. Scenario data (art, text, universe): still
copyrighted — the engine should load user-supplied original data files and
ship none of them, the same posture NovaJS and Kestrel take.

### Distribution (browser build)

`flight.html` as built here inlines evdata.json and reads `evassets/` —
that's Ambrosia's copyrighted content, so **don't host that file or the
assets publicly**. Ambrosia's dissolution didn't release the rights;
"abandonware" has no legal meaning, and archive.org's preservation
posture doesn't extend to us. What *can* be hosted: the engine with no
data (this whole repo minus `EV_data/`, `evdata.json`, `evassets/`,
`galaxy.html`, `flight.html`). The intended path is a loader page that
accepts a user-supplied asset bundle: the user runs the pipeline against
their own copy of EV (`evexport.js` + `evconvert.sh` → a zip of
evdata.json + evassets) and drops it into the hosted page, which caches
it client-side (IndexedDB/OPFS). Their data never touches the server.
Longer-term, a community-made free data pack would allow a fully
hostable demo. (Not legal advice.)
