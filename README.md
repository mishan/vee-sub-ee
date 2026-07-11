# Vₑ — a clean-room Escape Velocity engine

**Vₑ** ("vee-sub-e" — the physics symbol for escape velocity, and *EV*
backwards) is a from-scratch reimplementation of Ambrosia Software's classic
*Escape Velocity* (Mac, 1996). It runs in the browser, and ships **no game content**
— you play it with your own copy of the original.

## Play it

The easiest way needs no command line and no tools. Serve the repo over http
(a service worker needs a secure context; `localhost` counts) and open the
loader:

```sh
python3 -m http.server        # from the repo root
# → http://localhost:8000/loader/
```

Drop your original `Escape Velocity … .sit` onto the page. Everything — StuffIt
unpacking, resource decoding, QuickDraw graphics, sound, and building the
engine — happens **in your browser**. Nothing is uploaded; your data never
leaves the device. See [`loader/README.md`](loader/README.md) for how the
in-browser pipeline works.

Prefer the command line? `make` builds `flight.html` from a local copy of the
data (see [Building](#building-from-source)).

## What works

It's a real game, not a tech demo. From a fresh pilot in **Levo** you can:

- **Fly and fight** — 30 Hz inertial flight from the ship's own stats, warship
  and trader AI, the bible-exact damage model, projectiles/beams/ammo, escape
  pods and disintegration.
- **Explore** — a galaxy map with fog of war, hyperjump with fuel, and landing
  on planets with their real landscape art and description text.
- **Trade and outfit** — the six-commodity exchange, plus a tech-gated
  outfitter and shipyard in the original grid-and-detail layout.
- **Take missions** — cargo runs, destroy/disable/board/escort/rescue jobs, and
  branching storylines, offered at the spaceport bar and mission computer; a
  legal record and combat rating gate what you're offered and draw bounty
  hunters when you turn criminal.
- **Board, capture, and command** — loot or capture disabled ships, keep
  captures (or hired escorts) as a fleet, get work from named characters, and
  carry fighters in bays.

Rounding it out: the original title screen and music, positional audio, pilot
saves, and touch controls for phones and tablets.

## How it's built

The game's declarative data lives in Classic Mac resource forks; a small
zero-dependency toolchain lifts it into plain JSON that the engine consumes:

- `evrsrc.js` — reads resource forks (MacBinary / AppleDouble / raw).
- `schemas/*.json` — record layouts, **generated** from the `TMPL` resources
  inside EV's own data file by `tmpl2schema.js` (authoritative, not guessed).
- `semantics.js` — meaning for the raw fields (flag bits, enums, ID
  conventions), sourced from the EV Resource Bible. Facts, not expression.
- `evexport.js` — assembles the game database and builds `galaxy.html` /
  `flight.html`; `evconvert.sh` + `evsprites.sh` turn PICT/`snd ` resources into
  PNG/WAV sprite sheets.

The flight rules live once, normatively, in
[`engine/ENGINE_SPEC.md`](engine/ENGINE_SPEC.md), implemented by the DOM-free
`engine/core.js`. The browser UI around it — canvas rendering, dialogs, input,
game state — is the *shell*: real ES modules under `engine/shell/*.js`, split by
domain, with `main.js` as the entry point. [esbuild](https://esbuild.github.io)
bundles `core.js` into `engine/core.bundle.js` and the shell into
`engine/shell.bundle.js`; the build injects both bundles, with the game data,
into `flight_template.html`. (The bundles are generated and gitignored; a
release ships them, and the browser loader builds them on demand.)

The **browser loader** in `loader/` is a second, dependency-free
implementation of that whole pipeline (StuffIt decompression, PICT/`snd `/sprite
decoders, the database builder) so the game can be assembled client-side from a
dropped `.sit`. `node loader/verify.js` checks its decoders against the native
tools' output byte-for-byte.

## Building from source

You need a local copy of the game's data in `EV_data/` (never committed — see
[Legal](#legal)). A top-level `Makefile` wraps the common tasks:

```sh
make            # build flight.html (the browser game)
make galaxy     # build the galaxy map viewer
make verify     # check the loader's decoders against the native tools
make help       # list all targets
```

The build is driven by placeholder injection: esbuild bundles `engine/core.js`
and the `engine/shell/*.js` modules (entry `main.js`) into
`engine/core.bundle.js` and `engine/shell.bundle.js`, then `evexport.js` slots
those two bundles, the game database, and the sprite manifest into
`flight_template.html`.
Dev/test hooks are URL params on `flight.html` — e.g. `?syst=`, `?ship=`,
`?x=&y=&heading=`, `?map=1`, `?land=1` — handy for jumping straight into a
scenario.

## Legal

The engine is clean-room and yours to use. The scenario — art, text, sounds,
and the universe itself — is still Ambrosia's copyrighted work. Vₑ ships none
of it: `EV_data/`, `evdata.json`, `evassets/`, `galaxy.html`, and `flight.html`
are gitignored build inputs/outputs and must never be committed or hosted. This
is the same posture NovaJS and Kestrel take. The browser loader is designed
around it — your data is decoded on your device and never touches a server.
(This isn't legal advice; "abandonware" has no legal standing, and Ambrosia's
closure didn't release the rights.)

## References

Field-by-field record docs live in the community-archived **EV/Nova Bibles**
and the **EVNEW** source (mirrored at escape-velocity.games/docs);
[ResForge](https://github.com/andrews05/ResForge) is a maintained editor with
`TMPL` definitions. The project roadmap and status are in
[`PLAN.md`](PLAN.md).
