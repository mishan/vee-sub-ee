# Scoping: EV plugin support

**Verdict:** very feasible, and a natural fit. Classic EV/Override plugins are
just resource forks that override or add resources by `(type, ID)` — and this
project already parses resource forks and builds everything from a
type→records model. The bulk of the work is one small **merge layer** plus
wiring it into the two build paths (CLI and the browser loader); the *engine
needs essentially no changes*. Estimated ~2–4 focused days for solid classic-EV
plugin support, most of it in the loader UI and asset plumbing rather than
anything hard.

## How EV plugins work

From the Override Resource Bible:

> Any resources in an Override plugin file automatically replace same-numbered
> resources in Override's main files.

So the rule is simply:

- A plugin resource with the **same type and ID** as a base resource
  **overrides** it (e.g. retune ship 128's `Cost`, rewrite mission 200).
- A plugin resource with a **new ID adds** content (a new ship, system,
  outfit, storyline).
- With multiple plugins, **last loaded wins** on a conflict (classic loads them
  in folder/alphabetical order).

A plugin file is a single resource fork that can carry *any* resource type at
once — `shïp`/`sÿst`/`mïsn` game records **and** the `PICT`/`spïn`/`snd `
graphics and sound that go with them. (New ships need a `shïp` record, a `spïn`
pointing at sprite+mask `PICT` IDs, and those PICTs — all merged by ID.)

Containers are the same ones we already handle: MacBinary / AppleDouble / raw
fork (and a plugin can itself arrive inside a `.sit`).

## Why this repo is well-positioned

- `evrsrc.parseFork()` already turns any fork into
  `[{ typeName, typeHex, resources: [{ id, name, data() }] }]`. Parsing plugins
  is **free**.
- `evexport`/`evbuild` build the game DB from that structure; the engine reads
  `DATA.types.ship[id]`, `MANIFEST.spins[id]`, and `evassets/*` by ID. Merge the
  resources upstream and **overrides/additions flow through untouched** — no
  engine or spec changes for the common case.
- `evrsrc.buildFork()` can *write* forks, so we can synthesize tiny test plugins
  for the verifier.

## Design

One new primitive, reused everywhere:

```
mergeTypes(baseTypes, ...pluginTypesInLoadOrder) → mergedTypes
```

Group by `typeHex`; within a type, key resources by `id`; a later fork's
resource replaces an earlier one at the same ID, new IDs append. ~50–80 lines in
`evrsrc.js` (dual-mode, so Node + browser share it).

Because a plugin fork mixes everything, the merge feeds three buckets, routed by
resource type:

| bucket | types | consumed by |
|---|---|---|
| game database | shïp, sÿst, mïsn, oütf, … + STR# | `buildData` |
| graphics | PICT, spïn | `buildManifest` + asset render |
| sounds | snd | sound asset render |

The main plumbing change is that `buildData` / `buildManifest` / `produceAssets`
should take **already-parsed, merged `types`** instead of a single raw fork, so
plugin resources are already folded in.

**Two delivery paths:**

- **CLI** — `evexport … --plugin A.rsrc --plugin B.rsrc` (repeatable, in load
  order). Small change; good for scripting and for the verifier.
- **Browser loader** — after the base `.sit`, let the user drop one or more
  plugin files; classify each plugin's resources into the three buckets, merge,
  and build as normal. This is where most of the UI/UX work lives: an ordered
  plugin list (drag to reorder = load order), per-plugin toggle, and folding the
  plugin set into the first-run-cache key so a changed plugin list rebuilds.

## What works, what's partial, what's out of scope

**Just works** (no engine change): value-tuning plugins (EV Tuner–style), new
ships/outfits/weapons, new systems/planets, new missions and storylines — as
long as they use the record types and fields the engine already implements.

**Partial:**

- Plugins that touch resource types we don't model yet (e.g. `chär` starting
  scenarios, `crön`-style timed events, `bööm` explosion mappings) merge fine
  but their effect is ignored until those systems exist. Worth listing the
  supported vs ignored types in the UI so expectations are clear.
- Add-a-new-start plugins won't change the hardcoded New Pilot start (Levo /
  Shuttlecraft) until `chär` is wired in.

**Out of scope (for now):**

- **EV Nova** plugins — Nova added `rlëD` RLE sprites (we decode `PICT` sheets,
  not `rlëD`) and a control-bit scripting layer beyond classic. Classic
  EV/Override is the target; Nova is a separate, much larger effort.
- Plugin-supplied QuickTime `MooV` mission movies (`deqt`).

## Phased plan

1. **Merge core + CLI** — ✅ **done.** `evrsrc.mergeTypes()` (override/add by
   `(type, ID)` in load order); `evexport --plugin <file>` (repeatable);
   `evbuild.buildData(fork, schemas, pluginForks)`. Locked in by a synthesized
   override+add plugin (buildFork) in `loader/verify.js` (`plugin: 5/5`), with
   the no-plugin path still byte-identical to before. *(Graphics/sound merge is
   Phase 2 — this phase merges game records + STR#.)*
2. **Loader plumbing** — ✅ **done.** `evbuild.routeAssets()` splits a plugin
   fork by type into graphics/titles/sounds buckets (spïn + new PICT → graphics,
   title-overriding PICT → titles, snd → sounds); `buildData`/`buildManifest`/
   `produceAssets` take `pluginForks`; `buildAndCache(forks, spinSchema, plugins,
   …)` threads them through; `evrsrc.unwrapFork()` reads a plugin fork from bytes
   in the browser. A basic add-plugin file picker + list is wired in the loader.
   Tests in `verify.js`: `plugin-assets: 7/7` routing + manifest, and the
   no-plugin build is still byte-identical.
3. **Loader UX** — drag-to-reorder plugin list (currently add-order), per-plugin
   remove (done) + toggle, and a clearer summary of what each plugin
   overrides/adds and which of its types are unsupported.
4. **Polish** — larger real-plugin testing, `chär` starting-scenario support if
   we want new-start plugins, and a note in loader/README. *(as needed)*

## Testing

- The bundled `EV_data/EV Plug-Ins/EV Tuner.rsrc` is, in this copy, a degraded
  fork (only `vers` survived — its resource fork was stripped in transit), so
  it's not a useful content test on its own.
- Better: **synthesize** a minimal plugin with `buildFork` — e.g. a `shïp` 128
  that changes `Cost`, and a new `shïp` 200 — and assert in `loader/verify.js`
  that `buildData` shows the override at 128 and the addition at 200. That locks
  the merge semantics in without shipping copyrighted plugin content.
- Then a real, intact classic plugin (retrieved with its resource fork intact,
  e.g. via `unar` from a `.sit`) for an end-to-end loader check.

## Decisions (v1)

- **Scope**: value-tuning + new content in existing systems (new
  ships/outfits/weapons/systems/planets/missions). `chär` starting-scenario
  plugins (new-game starts) are **deferred** past v1.
- **Load order**: **drag-to-reorder** plugin list in the loader; last wins.
- **Distribution/legal**: plugins are third-party copyrighted content too, so
  same posture as the base data — user supplies their own, nothing hosted. The
  loader already keeps everything client-side, so this falls out for free.
