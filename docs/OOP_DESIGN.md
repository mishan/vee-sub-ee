# Toward an object-oriented Vₑ — a design proposal

Status: **implemented.** What began as a proposal has shipped: the four-layer
target below is in place, every migration phase (1–5) and every UI slice landed
on its own branch, and `npm test` stays green. This document is now a record of
the design and its rationale rather than a plan. The one open thread —
*testability of the procedural shell* — is scoped in "Testability — next" at the
end.

## Why

The engine grew as *functions over plain records*. `engine/core.js` exposes
`makeShip`, `thrust`, `steerToward`, `stepWarship`, `stepShot`, … that take a
ship/shot object and mutate it. The shell stores entities as bare objects
(`player`, `S.aiShips[]`, `escorts[]`, `S.shots`) and drives them from one long
loop in `09-step.js` that branches on flags (`s.hostile`, `s.escId`, `s.target`)
to decide which core function to call. State lives in a single mutable bag `S`
plus a few module-level arrays.

This has served well and is well-tested, but the seams show:

- **Behavior is dispatched by flag-checking**, not by type. Adding an AI kind
  means another branch in the step loop and another flag on the record.
- **State is ambient.** `S` is reached from every module; what's allowed to
  mutate what isn't expressed anywhere.
- **The DOM bridge leaks globals.** Inline `onclick="doAcceptMission(3)"`
  handlers force every dialog action to be a global function name (the
  `Object.assign(globalThis, …)` bridge in `main.js`).

OOP won't fix everything, but it gives us three things that map directly onto
those pain points: **polymorphism** (type-dispatched behavior instead of flag
branches), **encapsulation** (an object owns its state and invariants), and
**clear ownership** (a `World` owns entities; a `Screen` owns its DOM + handlers).

## Non-goals

- **Not** a rewrite. The flight math in `ENGINE_SPEC.md` stays normative and
  byte-for-byte unchanged; this is a refactor of *how* the code is organized,
  not *what* it computes. Every phase keeps `npm test` green.
- **Not** a framework. No dependency injection containers, no decorator
  metaprogramming — just plain ES classes, which esbuild already bundles.
- **Not** "classes everywhere." Pure helpers (`norm`, `bearing`, `rad`) stay
  functions. Data records loaded from JSON stay data.

## The shape of the target

Four layers, from the DOM-free core outward.

### 1. Core entities (`engine/core.js`)

Give the flight core a small class hierarchy whose methods *are* today's
functions. `makeShip(rec, x, y, h)` becomes `new Ship(rec, x, y, h)`;
`thrust(s)` becomes `ship.thrust()`; `stepShot(shot, target)` becomes
`shot.step(target)`.

```js
// sketch — not final
class Body {                    // shared kinematics
  constructor(x, y, heading) { this.x = x; this.y = y; this.heading = norm(heading); this.vx = this.vy = 0; }
  integrate() { this.x += this.vx; this.y += this.vy; }
  steerToward(deg) { /* … today's steerToward, returns aligned:boolean */ }
}
class Ship extends Body {
  constructor(rec, x, y, heading) { super(x, y, heading); this.rec = rec;
    this.maxSpeed = maxSpeedOf(rec); this.accel = accelOf(rec); this.turn = turnOf(rec); }
  thrust() { /* today's thrust(this) */ }
  takeDamage(weapon) { /* today's applyDamage → 'shielded'|'hit'|'disabled'|'destroyed' */ }
}
class Projectile extends Body { step(target) { /* today's stepShot */ } }
```

The core stays DOM-free and importable in Node, so the unit tests keep working
— they just call `ship.thrust()` instead of `EV.thrust(ship)`. Because the
methods hold the exact same math, the existing assertions in
`test/core.test.mjs` port mechanically.

### 2. AI as strategies (shell)

The `stepWarship` / `stepTrader` / `stepFlee` branching in `09-step.js` becomes
a small strategy hierarchy. AI needs shell context (targets, `fire()`,
spawning), so it lives in the shell, not the DOM-free core.

```js
class AI { step(ship, world) {} }              // base
class WarshipAI extends AI { /* engage nearest hostile, fire in range */ }
class TraderAI  extends AI { /* cruise → brake → land */ }
class EscortAI  extends AI { /* guard player, fight player's enemies */ }
class FleeAI    extends AI { /* run for the nearest jump point */ }
```

Each AI ship carries `ship.ai = new WarshipAI()` instead of `s.hostile` +
`s.escId` flags, and the step loop becomes `for (const s of world.ships)
s.ai.step(s, world)` — no branching. New behavior = new subclass, touched in
one place.

### 3. The `World` / `System` (shell)

The current system owns three loose arrays (`S.aiShips`, `S.shots`, `escorts`)
and the loop that advances them. Wrap that as one object.

```js
class World {
  ships = []; projectiles = []; player;
  step() {                       // replaces the body of step() in 09-step.js
    this.player.control(input);
    for (const s of this.ships) s.ai.step(s, this);
    for (const p of this.projectiles) if (!p.step(p.target)) this.remove(p);
    this.collide();              // projectile ↔ ship
  }
  spawn(ship) {…}  remove(e) {…}  nearestHostileTo(ship) {…}
}
```

This gives collision, spawning, and targeting one owner and makes the 30 Hz
tick a single readable method.

### 4. Shell screens (`engine/shell/…`)

We already have a `View` class (`07-trade.js`) — a render function plus
mount/refresh/hide. Generalize it into a `Screen`/`Dialog` base that also owns
its event handlers, so dialog buttons bind through `addEventListener` instead of
global `onclick="fn()"` strings. That lets us retire most of the
`Object.assign(globalThis, …)` bridge — the biggest structural win in the shell.

```js
class Dialog {
  render() {}                        // returns SafeHtml (unchanged)
  onMount(root) {}                   // root.querySelector('.accept').onclick = …
  open() { mount(this); this.onMount(this.root); }
}
class MissionBoard extends Dialog { … }   // the module we just split out
class HireBoard    extends Dialog { … }
```

`GameState` (a class replacing the `S` bag) can come last and incrementally —
move fields onto it a cluster at a time, each with real getters/methods
(`state.canAfford(n)`, `state.spend(n)`), so the invariants live with the data.

## Separating UI from logic (the presentation layer)

Layer 4 above is about *class* shape; this section is about *file* shape — where
the dialog HTML and canvas drawing physically live. The two reinforce each
other, but the file split can happen first and independently, and it's the
natural continuation of the mission-board extraction.

### Where UI lives today

A quick census of the shell (counting `html\`\`` templates, `document.` access,
canvas `ctx.` calls, and inline `onclick=` handlers) sorts the modules into
three groups:

- **Already UI-free logic** — `02-spawning`, `03-sound`, `04-combat`,
  `08-missions`, `12-boarding`, `13-legal`, `15-pers`. Nothing to do.
- **Already presentation** — `10-render` (canvas: ~115 `ctx.` calls),
  `16-missionboard` (the split we just did), most of `11-title` and
  `14-landing`.
- **Still mixed** — `07-trade` (trade/outfit/buy logic + three shop render
  functions), `06-interaction` (targeting/hail logic + a hail dialog with ~22
  inline handlers). These are the real targets.

Plus one cross-cutting item: the `html` / `SafeHtml` / `escapeHtml` template
tag lives in `01-state.js` (the state leaf), even though it's a pure UI
primitive used everywhere.

### Target: an `engine/shell/ui/` subfolder

Presentation modules move under `engine/shell/ui/`, so the logic/UI boundary is
visible in the directory tree rather than implied by a comment. Logic modules
keep their `NN-*.js` names and load-order role; UI modules are named by domain
(they're mostly pure `render() → SafeHtml` with no init-order side effects, so
they don't need the numeric prefix).

```
engine/shell/
  01-state.js … 17-main.js         # game logic + state + the tick
  ui/
    html.js         # html`` / SafeHtml / escapeHtml (new leaf, imports nothing)
    dialog.js       # the View/Dialog base + openService/close registry
    shops.js        # renderExchange / renderOutfitter / renderShipyard / shopGrid
    missionboard.js # moved from 16-missionboard.js
    hail.js         # hail dialog, extracted from 06-interaction
    landing.js      # planet landing screen, extracted from 14-landing
    title.js        # title + splash screens, extracted from 11-title
    render.js       # the canvas HUD/scene renderer (was 10-render.js)
```

Each UI module imports the logic it presents; the logic module no longer
imports its own render function. Where a logic-side registry needs a render
function (e.g. `07-trade`'s `SERVICE_VIEWS` pointing at `renderExchange`), it
imports it from `ui/` — the same forward-reference across the module graph that
already works for `renderBar`/`renderComputer` today (hoisted function
declarations resolve regardless of file load order).

### Boundaries, concretely

- **`07-trade` → `ui/shops.js`.** Move `renderExchange`, `renderOutfitter`,
  `renderShipyard`, `shopGrid`, `walletHtml`. Keep `trade`, `buyOutfit`,
  `buyShip`, `techAvailable`, and the stock/price helpers in `07-trade`. The
  `View` class, `openService`, `closeService`, and `SERVICE_VIEWS` move to
  `ui/dialog.js` (they're the dialog framework, shared by every screen).
- **`06-interaction` → `ui/hail.js`.** Move the hail dialog markup + its
  handlers; keep target cycling, hail eligibility, and interaction state.
- **`14-landing` → `ui/landing.js`**, **`11-title` → `ui/title.js`**,
  **`10-render` → `ui/render.js`** — mostly relocations, since these are
  already presentation-dominant.
- **`html` primitive → `ui/html.js`.** New leaf that imports nothing; every
  current `import { html } from './01-state.js'` becomes
  `from './ui/html.js'`. Mechanical but wide; do it in its own commit.

### Load order & the global bridge

`main.js` keeps importing logic modules in their existing order (`01-state`
stays the first leaf), then imports the `ui/` modules after them. UI modules
must avoid top-level side effects that other init depends on; the one current
example — `S.selMisnId = null` in the mission board — moves onto the state
initializer instead. The `Object.assign(globalThis, …)` bridge still exposes UI
handlers for now; retiring it is Layer-4 work (self-binding `Dialog`s), which
this file split sets up but doesn't require.

### Migration path (each slice ships green)

Independent of the class work; each is one branch, verified with lint,
`npm test`, and headless-boot screenshots of the affected screen:

1. `ui/shops.js` — extract the three shop renderers from `07-trade` (mirrors
   the mission-board split). **Done** — `renderExchange`/`renderOutfitter`/
   `renderShipyard` + `shopGrid`/`walletHtml` moved; shop selection (`selOutfitId`/
   `selShipId`) folded onto `S`; `07-trade` keeps the trade/buy logic and imports
   the renderers back for `SERVICE_VIEWS`.
2. `ui/dialog.js` — lift the `View`/`openService` framework out of `07-trade`;
   move `16-missionboard.js` under `ui/`. **Done** — the base (`View`/
   `activeView`/`refreshView`) went into the import-free leaf `ui/dialog.js` so
   any dialog can construct at init; the concrete registry (`openService`/
   `closeService`/`SERVICE_VIEWS` + the button actions, which need the renderers
   and their logic) went into a new `ui/services.js`; `16-missionboard.js` moved
   to `ui/missionboard.js`. `07-trade` now holds only trade/outfit/shipyard
   logic.
3. `ui/hail.js` — extract from `06-interaction`. **Done** — the dialog body
   (ship / boarding / planet variants + `shipOfferPanel`), the `hailActions`
   map, and `hailDialog`/`renderHail` moved; 06-interaction keeps the
   interaction logic/state (openHail/closeHail/hailOpen, target cycling, the
   comm outcomes) and imports `hailDialog`/`renderHail` back. (The buttons were
   already `data-action`, not inline handlers, so no global-bridge churn.)
4. `ui/html.js` — relocate the template primitive; rewire every importer.
   **Done** — `html`/`raw`/`escapeHtml`/`SafeHtml` moved to the import-free leaf
   `ui/html.js`; the 8 importers now take them from there, and 01-state imports
   `html`/`raw` from it too (for its new-pilot dialog). `ui/html.js` is now the
   first leaf, loaded before 01-state.
5. `ui/landing.js`, `ui/title.js`, `ui/render.js` — relocations. `ui/render.js`
   **done** — the canvas HUD/scene renderer (`10-render.js`) moved under `ui/`
   wholesale (it's pure drawing) with its importers rewired. `ui/landing.js`
   **done** — a split, as expected: the landing *screen* (the `landedBody`
   markup, its `landedDialog`, `renderPlanetScreen`, and the `missionNotes` it
   shows) moved to `ui/landing.js`; `14-landing.js` keeps the flight-side logic
   (`tryLand`/`takeOff`) and imports the dialog + a `setMissionNotes` setter
   back, so the dependency stays one-way (logic → ui) with no cycle.
   `ui/title.js` **done** — the same split as landing: the screens (splash/title
   markup + render helpers, the canvas pilot summary, the About/Open Pilot
   dialogs, prefs, pilot import) moved to `ui/title.js`; `11-title.js` keeps the
   intro *state machine* (the `splashShown`/`titleShown` flags read by the sim,
   `introUp`, and the `showSplash`/`advanceSplash`/`showTitle`/`enterGame`
   transitions + title-music orchestration), delegating the DOM to the render
   helpers it imports back. The one gameplay entry point (the Enter Ship binding)
   stays on the logic side, like the Take Off button. Dependency is one-way
   (logic → ui); with `10-render`/`14-landing`/`11-title` all under `ui/`, slice 5
   is complete.

Do the file separation first; the `Dialog`-class conversion (Layer 4) then
lands cleanly on top, one screen at a time.

## Tradeoffs and risks

- **Testability.** The core's purity is its greatest asset; classes must not
  cost us that. Mitigation: core classes stay DOM-free and construct cleanly in
  Node, and methods keep the same signatures-of-effect as today's functions, so
  tests port one-to-one. We keep the spec as the source of truth.
- **Per-frame allocation.** Methods are fine, but we should avoid allocating new
  objects every tick (e.g. don't return fresh `{aligned, dist}` in hot paths if
  it shows up in profiles). Current code already returns such objects; no
  regression, but worth watching.
- **Inheritance depth.** Keep it shallow (`Body → Ship`, `AI → WarshipAI`).
  Prefer composition (`ship.ai`, `ship.weapons`) over deep trees.
- **Churn vs. review.** A big-bang refactor is unreviewable and risks silent
  behavior drift. Everything below is incremental and individually verifiable
  with the existing harness (lint + `npm test` + headless boot screenshots).
- **The bundle/global bridge.** Screens that self-bind handlers reduce globals.
  (Resolved: all handlers are self-bound now and the `Object.assign(globalThis, …)`
  bridge has been retired — see phase 4 below.)

## Migration path (each phase ships green)

1. **Core `Ship`/`Projectile` classes**, methods delegating to the existing
   pure functions; keep the old function exports as thin wrappers so nothing
   downstream breaks. Port `test/core.test.mjs` to method calls. *(Isolated,
   low-risk, high signal.)*
2. **`World` object** wrapping `S.aiShips`/`S.shots`/`player` and owning
   `step()` — move the loop body out of `09-step.js` unchanged.
3. **AI strategies** — replace the `stepWarship/stepTrader` branch with
   `ship.ai.step(ship, world)`, one subclass per current branch.
4. **`Dialog` base** for the service screens; migrate `MissionBoard`/`HireBoard`
   (just split out) to self-bound handlers; shrink the global bridge. **Done** —
   every dialog already routed its buttons through the `Dialog` data-action
   delegation (self-bound); the last consumers of the `Object.assign(globalThis,…)`
   bridge were three inline `onclick`s in the flight chrome (Take Off, ◀
   Back, the 2× pill). Those now `addEventListener` in their owning modules
   (14-landing, ui/services, 05-input), so **the global bridge is retired** — no
   shell export is exposed as a global (EV/DATA/MANIFEST/NAMES stay ambient from
   the flight.html `<script>`).
5. **`GameState`** — fold `S` onto a class cluster by cluster (credits/cargo,
   legal record, missions), adding methods that guard invariants. **Effectively
   done** — `Wallet` (credits), `LegalRecord`, `MissionLog`, `Hold` (the cargo
   hold), `Outfits` (the outfit inventory) and `Fuel` (level + tank + jump cost)
   are extracted as focused, DOM-free classes with their own tests. What remains
   on the `S` bag is the transient per-frame/session glue — targets, the jump
   state machine, the landed/paused flags, the live entity arrays — which is
   coordination state, not an owned invariant, so it stays on `S`.

Phases 1–2 are pure internal structure and reversible. 3–5 change real seams
and each deserves its own branch + Copilot review, in the usual stacked order.

## Recommended first slice

**Phase 1 only**, on its own branch: introduce `Ship` and `Projectile` in
`engine/core.js`, delegate the free functions to the methods, and port the unit
tests. It's small, it's fully covered by `npm test`, it proves the "methods hold
the exact same math" claim, and it sets the pattern for everything else — with
zero shell or DOM risk. If it feels right, we proceed to `World`.

## Decisions & open questions

- **Timing (done):** implemented in stacked branches, Phase 1 first, each
  shipping green — exactly as recommended.
- **Compatibility layer (done):** the old `EV.thrust(ship)`-style free exports
  were **not** kept; call sites use methods and the free functions are gone, so
  there's one way to do each thing and no dead API.
- **UI/logic separation (done):** presentation lives in `engine/shell/ui/`; the
  first slice was `ui/shops.js` and the rest followed.
- **`GameState` shape (done):** a few focused classes rather than one big
  `GameState`. `Wallet`, `LegalRecord`, `MissionLog`, `Hold`, `Outfits` and
  `Fuel` are each their own DOM-free, unit-tested class; the `S` bag keeps the
  transient glue.

## Testability — next

The migration cleaned up the two layers it set out to clean: the DOM-free core
(`engine/core.js`) and the *state invariants* (the focused `Wallet`/`Hold`/… 
classes). Both are Node-importable and unit-tested. It deliberately left the
**procedural shell** alone, and that's where the remaining mess — and the
remaining untestability — lives.

The tell: the big shell modules (`08-missions`, `07-trade`, `04-combat`,
`09-step`, `06-interaction`, `13-legal`, `02-spawning`) can't even be *imported*
in Node — `import('./engine/shell/08-missions.js')` throws `location is not
defined`, because they read ambient globals (`DATA`/`document`/`EV`) at
module-eval time. That import barrier quarantines the *pure* logic living inside
them. `08-missions` alone holds ~10 pure functions (`missionAvailable`,
`resolveStel`, `availStelMatch`, `goalSupported`, `govtAllies/Enemies`, the
bit-set helpers, `formatDate`) that take records and return values — untestable
only because line 30 evaluates `DATA.types.misn` on load.

**Plan:** extend the pattern already proven by `mission-cargo.js` — lift the
pure rules out of each procedural module into a DOM-free sibling that both the
shell and a test import, passing the data records in as arguments instead of
reaching for the `DATA` global. In priority order:

1. **Mission rules → `missions-rules.js`.** Highest value: the most branching
   logic in the shell, the area where the cargo/accept bugs surfaced, and
   currently zero unit coverage.
2. **Trade / pricing.** `priceAt`, `techAvailable`, `tradeInValue`, `refuelCost`
   — self-contained math, an easy win.
3. **Legal spread (`13-legal`).** The spread constants are already flagged as
   tuned/approximate; a pure, tested function pins down the reverse-engineered
   behavior.
4. **AI strategies + targeting (`09-step`).** Most valuable behaviorally but
   highest effort — the decision math is entangled with the live entity arrays,
   so it needs a small entity stub. Do this one last.

A cheaper alternative — a Node harness that stubs `DATA`/`EV`/`document` so the
existing modules import unchanged — was considered and rejected: it tests
against a fake `DATA` and leaves the ambient-global coupling in place. The
extraction path is the one already proven here and matches this document's
philosophy (a DOM-free core that owns its logic), so it wins.
