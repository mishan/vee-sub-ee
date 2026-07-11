# Browser loader

Play Vₑ from your own copy of Escape Velocity with **no command line and no
external tools**. Drop the original `.sit` onto a web page and everything — the
StuffIt unpacking, resource decoding, QuickDraw graphics, sound, and building
the engine — happens in your browser. Nothing is uploaded; your data never
leaves the device. This is the "pure-web" path described in the top-level README
under "Distribution".

## Using it

Serve the repo over http (a service worker needs a secure context — `localhost`
counts) and open `loader/`:

```sh
python3 -m http.server      # from the repo root
# → http://localhost:8000/loader/
```

Drop your `Escape Velocity … .sit`. The loader shows a live gallery — composited
ship sprites, the title art, decoded ship/system/character counts, a playable
sound — and **▶ Launch the game** builds the engine from your data and plays it
in the same tab.

The bundled *installer* (`EV_Installer_1.0.5.bin`) is Installer VISE (`SVCT`),
a proprietary format with no maintained open tooling — use the `.sit`, which is
a StuffIt 5 archive of the installed game folder.

## How it works

```
.sit ─▶ parseSit / extractFork ─▶ resource forks ─▶ evrsrc/evbuild  (game DATA)
 (StuffIt 5, evsit.js)                        └────▶ evpict/evsnd/evsprite (assets)
                                                          │
   assemble flight.html (DATA + MANIFEST + core.js) ◀─────┘
   → cache assets + engine in Cache Storage → service worker serves them
   → navigate to game/flight.html   (the engine runs unmodified)
```

Every step is pure JavaScript, replacing the whole CLI toolchain — StuffIt
Expander / The Unarchiver, `resource_dasm`, and ImageMagick — that the native
build (`evconvert.sh` + `evsprites.sh` + `evexport.js`) uses.

### Files

| file | role |
|---|---|
| `evsit.js` | parse a StuffIt 5 archive; decompress its forks (method 13, "LZ+Huffman") |
| `evpict.js` | QuickDraw PICT → RGBA |
| `evsnd.js` | classic-Mac `snd ` → PCM |
| `evsprite.js` | composite a sprite PICT + mask PICT into one transparent sheet |
| `evbuild.js` | browser `evexport`/`evatlas`: build the engine `DATA` + sprite `MANIFEST` |
| `launch.js` | render assets to PNG/WAV in Cache Storage, assemble `flight.html`, register the SW, launch |
| `sw.js` | service worker: serve the cached game subtree |
| `nodeshim.js` | tiny `Buffer` shim so `evrsrc.js`/`semantics.js` (used by the CLI build too) run unchanged in the browser |
| `index.html` | the loader page (drag-and-drop, gallery, launch) |
| `verify.js` | check the decoders/decompressor against the reference output (Node) |

The engine is loaded verbatim: `launch.js` injects the built `DATA`/`MANIFEST`
and `engine/core.js` into `flight_template.html` exactly as `evexport --flight`
does, so `flight.html` never knows it came from the loader. Its relative
`evassets/*` requests are served by the service worker out of Cache Storage.

## Verification

`node loader/verify.js` (needs the local, gitignored `EV_data/` + `evassets/`,
and ImageMagick's `convert` only to read the reference images) checks each stage
against the native pipeline's output:

- **PICT** — 471/471 (100%) pixel-exact vs the `resource_dasm` reference PNGs.
- **snd** — 59/59 (100%) byte-exact vs the reference WAVs.
- **sprite** — 79/81 byte-exact incl. alpha, 80/81 ≥99% (the two differ only in
  sub-pixel edge alpha on masked sprites, imperceptible).
- **`.sit`** — 5/5 game forks decompress byte-exact vs the engine's resource
  forks (~200 ms for the whole ~8 MB archive).

Beyond `verify.js`: `buildData` is byte-identical to `evexport`, and the
in-browser-assembled `flight.html` boots a full playable game against the real
assets (both checked with headless screenshots). The service worker's cached
serving is verified cross-instance. (One caveat: a single headless screenshot of
the entire build→SW→boot in one shot is defeated by headless firefox only
flushing storage to disk when idle, so killing it mid-build loses the cache —
this is a test-harness limitation, not a defect; a live tab persists normally.)

## Format notes

- **PICT** (`evpict.js`): v1 (byte opcodes) and v2 (word opcodes, word-aligned).
  Preamble ops skipped: version, `0x0C00` header, `0x0001` clip region,
  `0x00A0`/`0x00A1` comments. Image ops: PackBitsRect/BitsRect (`0x0098`/`0x0090`)
  and their region variants (`0x0099`/`0x0091`, mask region skipped) for indexed
  PixMaps (1/2/4/8-bit) and 1-bit BitMaps; DirectBitsRect/Rgn (`0x009A`/`0x009B`)
  for direct color (16-bit RGB555, 32-bit planar packType 4, alpha dropped).
  PackBits per-row RLE (row byte-count is `u8` when `rowBytes ≤ 250`, else
  `u16`). Four gotchas that cost the most time: the color table is indexed **by
  position**, not by its `value` field (EV's tables often store `value = 0`);
  output must be **clipped to the picture frame** (as `resource_dasm` does), not
  the padded PixMap bounds; a picture can carry **several image ops** (tiled
  bitmaps) that must all be composited; and 32-bit direct color is stored
  **planar** (all R, then G, then B per row). An unmodelled opcode stops
  decoding and sets `unhandled` on the result.
- **snd** (`evsnd.js`): Format 1/2 command list → the `bufferCmd`/`soundCmd`
  offset → SoundHeader. Standard header = 8-bit unsigned mono PCM (all of EV's
  effects); extended header (8/16-bit, multi-channel) handled; compressed
  (`cmpSH`) reported, unused by EV. Sample rate is Fixed 16.16.
- **StuffIt 5 method 13** (`evsit.js`): "LZ+Huffman" — an LZSS window (64 KB)
  with canonical Huffman codes (shortest code = zeros) matched over an
  LSB-first bitstream. EV's forks all use the *dynamic-table* variant (block
  header high-nibble 0), whose code lengths are RLE-encoded via a fixed
  meta-code, so the large static Huffman tables are not needed. Forks are stored
  as StuffIt entry-tree records; the resource fork precedes the data fork.

## First-run caching

The first launch builds the engine and renders every asset into Cache Storage,
and that build persists — so a **return visit plays instantly without
re-importing the `.sit`**. On load the page checks for a completion marker
(`game/_built.json`); if a complete, current build is present it shows a green
**▶ Play — already loaded on this device** banner that just re-registers the
service worker and navigates. The marker is written *last* and deleted at the
start of every build, so it can never make a half-finished cache look ready, and
it carries a `BUILD_VERSION` (in `launch.js`) — **bump it whenever the engine or
decoders change** so returning visitors rebuild rather than play a stale cache.
Re-importing a different copy overwrites the cache as usual.

## Remaining polish

- **PWA install + export bundle**: with the build already cached, an offline
  install prompt and an "export bundle" button are natural next steps.
- **Name suggestions**: the loader passes `NAMES = null` (generic New-Pilot
  defaults); optionally read STR# 128 from the "Escape Velocity" app in the
  `.sit` for the original suggestions.
- **Two masked sprites** with sub-pixel edge-alpha differences vs ImageMagick
  (cosmetic).

## Credits

The StuffIt-5 method-13 format was reimplemented from the description in
XADMaster / The Unarchiver (`XADStuffIt13Handle`, `XADPrefixCode`,
`XADStuffIt5Parser`) — the format and its constants, not their code.
