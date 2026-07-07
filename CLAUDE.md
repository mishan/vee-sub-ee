# CLAUDE.md

**Vₑ** (`V_e`, "vee-sub-e") — clean-room reimplementation of Escape
Velocity (Ambrosia, classic Mac). The name is the physics symbol for
escape velocity, and EV backwards.
Browser-first engine with an SDL port kept in lockstep. The engine is ours;
the game data is not — see "Data hygiene" below.

## Git workflow

- Create a new branch for each piece of work; never commit directly to main.
- Commit as Misha (`Misha Nasledov <misha@nasledov.com>`). Do NOT add
  Co-authored-by tags or any AI attribution.
- Review feedback on a branch goes in separate commits — don't amend or
  squash the commits under review.

## Commands

```sh
node evrsrc.js selftest                                  # resource-fork lib sanity
node tmpl2schema.js "EV_data/EV Data.rsrc" -o schemas/   # regenerate schemas (rarely needed)
node evexport.js "EV_data/EV Data.rsrc" -o evdata.json --semantic   # game DB
node evexport.js "EV_data/EV Data.rsrc" --map galaxy.html            # galaxy viewer
node evexport.js "EV_data/EV Data.rsrc" --flight flight.html         # THE GAME (browser)
./evconvert.sh EV_data evassets   # PICT/snd → PNG/WAV (needs resource_dasm, ImageMagick)
./evsprites.sh evassets           # composite sprite+mask → transparent sheets
node engine/check_traces.js       # golden trace: JS core vs C++ port (MUST pass)
cd cpp && make && make test       # SDL leg build + headless render test
```

Headless UI verification: `firefox --headless --screenshot out.png
"file://…/flight.html?<params>"` (browser) and `SDL_VIDEODRIVER=dummy
./evflight --root .. --frames N --screenshot out.png <flags>` (SDL).
Test affordances are mirrored: URL params `?map=1 ?dest= ?jump=1 ?land=1
?exchange=1 ?outfitter=1 ?shipyard=1 ?tab=1 ?nav=1 ?ff=N ?syst= ?ship=
?x/y/heading` ↔ SDL flags `--map --dest --jump --land --exchange
--outfitter --shipyard --tab --nav --frames --syst --ship --x/y/heading`.

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
- `engine/ENGINE_SPEC.md` — **normative** flight/AI/game rules. Implemented
  twice: `engine/core.js` (injected into flight.html at build; require-able)
  and the `ev*` free functions in `cpp/main.cpp`. Any behavior change:
  spec first, then BOTH legs in the same branch, then `check_traces.js`
  must pass (tolerance 1e-6; typically agrees to ~1e-13).
- `flight_template.html` — browser shell (canvas render, DOM dialogs).
  `cpp/main.cpp` — SDL shell, a deliberate port of the same logic.
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
- Audio is browser-only for now (spec "Audio"); the SDL leg is also
  behind on combat-adjacent UI — sync at the next parity checkpoint.

## C++ gotchas

- nlohmann const `operator[]` asserts on missing keys; `$sem.prices` omits
  untraded commodities. Use the find()-based helpers in GameData.
- The sandbox used for development wipes everything outside mounted dirs
  between shell calls; resource_dasm lives outside the repo (build it
  locally; evconvert.sh expects it on PATH or $RESOURCE_DASM).
