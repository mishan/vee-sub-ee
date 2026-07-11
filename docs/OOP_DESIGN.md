# Toward an object-oriented Vₑ — a design proposal

Status: **proposal / for discussion.** Nothing here is implemented yet. This
scopes a direction and a migration path; the intent is to agree on the target
and the first slice before writing code.

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
- **The bundle/global bridge.** Screens that self-bind handlers reduce globals,
  but some inline handlers may remain during the transition; that's fine — the
  bridge and `addEventListener` can coexist per-dialog.

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
   (just split out) to self-bound handlers; shrink the global bridge.
5. **`GameState`** — fold `S` onto a class cluster by cluster (credits/cargo,
   legal record, missions), adding methods that guard invariants.

Phases 1–2 are pure internal structure and reversible. 3–5 change real seams
and each deserves its own branch + Copilot review, in the usual stacked order.

## Recommended first slice

**Phase 1 only**, on its own branch: introduce `Ship` and `Projectile` in
`engine/core.js`, delegate the free functions to the methods, and port the unit
tests. It's small, it's fully covered by `npm test`, it proves the "methods hold
the exact same math" claim, and it sets the pattern for everything else — with
zero shell or DOM risk. If it feels right, we proceed to `World`.

## Decisions & open questions

- **Timing (decided):** stay a proposal for now — no implementation yet.
  Revisit when we're ready to start Phase 1.
- **Compatibility layer (decided):** do **not** keep the old `EV.thrust(ship)`
  function exports long-term. Migrate call sites to methods and delete the free
  functions, so there's one way to do each thing and no dead API.
- **Open — `GameState` shape:** one class, or a few focused ones (Wallet,
  LegalRecord, MissionLog) composed together? (I lean toward a few focused ones.)
