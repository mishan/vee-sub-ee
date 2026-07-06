# EV engine spec

The normative description of flight physics and entity behavior shared by
every implementation (currently `engine/core.js` for the browser and
`cpp/main.cpp` for SDL). If an implementation disagrees with this file, the
implementation is wrong; if this file is wrong, fix it and both
implementations in the same commit. `engine/scenario.json` +
`engine/check_traces` enforce agreement mechanically (golden trace).

## Units and coordinate system

- Logic runs at a fixed **30 Hz** (classic EV's frame rate). All rates are
  per logic frame unless noted.
- Positions are pixels. **y grows downward** (screen space, both legs).
- **Heading 0° points up (−y); degrees increase clockwise.** Stored
  normalized to [0, 360).
- Sprite sheets: frame 0 faces up, frames advance clockwise.
  `frameIndex = round(heading / (360 / frames)) mod frames` (round, not
  floor — headings midway between frames pick the nearer one; negative
  results wrap by adding `frames`).

## Ship stat conversions (raw shïp record → engine values)

| engine value | formula | Shuttlecraft (Speed 275, Accel 435, Maneuver 4) |
|---|---|---|
| maxSpeed (px/frame) | `Speed / 100` | 2.75 (82.5 px/s) |
| accel (px/frame²) | `Accel / 9000` | 0.0483 (~1.9 s to max) |
| turn (deg/frame) | `Maneuver` | 4 (120°/s) |

These are **approximations chosen for feel**; if original-engine timing
measurements ever contradict them, change them here first.

## Flight model

- `thrust`: add `(sin(heading), −cos(heading)) · accel` to velocity, then
  clamp speed: if `|v| > maxSpeed`, scale `v` to `maxSpeed`. Sets the
  `thrusting` flag (render-only).
- `steerToward(desired)`: signed shortest angular difference, clamped to
  ±turn, added to heading. Returns `aligned = |diff| < 1.5 · turn`.
- `retrograde` = `atan2(−vx, vy)` in degrees, normalized — the heading that
  faces opposite the velocity vector. (Down-arrow autopilot steers to it.)
- Integration order per frame: **controls/AI first (may change heading and
  velocity), then `x += vx; y += vy`.** One integration per entity per
  frame, no half-steps.
- There is no drag: velocity persists forever (classic EV inertia).

## Player controls (per frame while held)

left/right: heading ∓/± turn. down: `steerToward(retrograde)`.
up: `thrust`. All simultaneous holds allowed; heading changes apply before
the thrust vector is computed (i.e. thrust uses the post-turn heading).

## AI trader state machine

States: CRUISE → BRAKE → LANDING. Deterministic given a fixed target
(spawn-time randomness — dude/ship/target selection — lives outside the
core; see "Spawning").

- `stopDist = |v|² / (2 · accel) + 40`  (kinematic stopping distance + pad)
- CRUISE: steer toward target; if `dist > stopDist` and aligned, thrust;
  if `dist ≤ stopDist`, → BRAKE.
- BRAKE: steer toward retrograde; if `|v| > 0.15`, thrust when aligned;
  else if `dist < 60` → LANDING, otherwise → CRUISE (overshot; go around).
- LANDING: fade −= 0.02 per frame (no motion changes); at fade ≤ 0 the
  entity despawns (shell schedules a respawn).

## Landing (player)

Eligible: nearest spob with `$sem.canLand`, distance < 60 px, and
`|v| ≤ 0.9 px/frame`. On takeoff the player is placed at
`(spob.x, spob.y − 40)`, heading 0, velocity `(0, −0.4)`.
Landing refuels the ship to capacity (see Hyperjump).

## Hyperjump

- Fuel: raw shïp `Fuel` field; **one jump costs 100** (classic: 100 = one
  jump). Shuttlecraft carries 400 → 4 jumps. Landing refills to capacity.
- Destinations: the current sÿst's `Con1..Con16` fields with values ≥ 128
  that name existing systems.
- Jump sequence (shell drives it, constants normative):
  1. Player selects a linked destination (map). Requires fuel ≥ 100.
  2. Engage: autopilot steers toward the destination system's map bearing
     (`atan2(dx, −dy)` on galaxy-map coordinates) and forces thrust.
  3. When aligned within one frame-step of turn and at ≥ 95% maxSpeed, the
     ship "enters hyperspace": 30-frame outbound streak effect, then the
     world switches to the destination system.
  4. Arrival: player is placed 700 px from the system center on the
     bearing back toward the origin system, same heading, velocity =
     maxSpeed along the inbound bearing; fuel −= 100. (700 keeps arrival
     within sight of the inner planets; was 1800, which felt stranded.)

## Map knowledge (fog of war)

The player starts in **Levo (sÿst 128)** knowing only that system. Each
arrival adds the system to the explored set. On the map: explored systems
render with govt color and full detail; systems linked to the current one
are labeled and clickable (you can jump into the unknown); everything else
is a dim, unlabeled dot (position only). Links render when either endpoint
is explored. (Classic's `VisBit` conditional visibility: deferred.)

## Trading (game rules, not flight core)

Six commodities, in flag-nibble order: food, industrial, medical, luxury,
metal, equipment. Base prices come from STR# 4004 ("Base Prices":
120/240/600/420/180/360). A spöb trades a commodity iff its price nibble
is nonzero; unit price = round(base × multiplier) with **low = 0.80,
medium = 1.00, high = 1.25** (community-established values — the bible
names the levels but not the multipliers; revisit if original-engine
measurements disagree). Buy and sell use the same price at a given spöb.
Cargo capacity = raw shïp `Holds`; starting credits **10,000**.

## Outfitter and shipyard

Availability gate for both: item `TechLevel ≤ spöb.TechLevel`, or an exact
match against `SpecialTech1..3`; items with `MissionBit ≥ 0` are hidden
until the mission system exists. Outfits: `Cost`/`Mass`/`Max` from the
oütf record; outfit Mass consumes the hull's `FreeMass` (negative Mass —
e.g. Mass Expansion — frees space); effects applied per ModType (semantics
.js): cargoSpace→Holds, fuelCapacity→Fuel, shieldCapacity/armor/accelBoost
/speedBoost/turnBoost→the corresponding shïp stat, recomputed through the
standard stat conversions. Outfits sell back at full cost at any
outfitter. Ships (bible, shïp Cost): "the cost of buying a ship is always
the cost of the new ship minus **25% of the original cost of your current
ship and upgrades**"; outfits do not transfer (they're part of the
trade-in); cargo must fit the new hull; fuel arrives full.

## Spawning (shell responsibility, not core)

AI count target: `clamp(syst.AvgShips, 2, 8)`. Each spawn: pick düde from
the system's `DudeTypes1..4` weighted by `Prob1..4`; pick ship from the
düde's `ShipTypes1..4` weighted by its `Prob1..4`; skip IDs < 128 or
missing records. Position: angle uniform in [0, 2π), radius 2400 (edge
spawn) or 400 + rand·1200 (initial population). Target: uniform over the
system's spobs. Despawned traders respawn after a delay (browser: 2–8 s
timer; SDL: 1% chance per frame — intentionally loose, not part of the
golden trace).

## Sprite ID conventions (from the EV bible, see semantics.js)

ship spïn = 128 + (shïp − 128); stellar spïn = 300 + spöb.Type;
weapons 200–263, explosions 400–402. Landing landscape: PICT
(10000 + spöb.Type) in EV Titles (34 landscapes, one per stellar type),
overridden by `CustPicID` when ≥ 0; fall back to the standard if the
custom PICT is missing from the data.

## Golden trace

`engine/scenario.json` defines ships-by-stats (self-contained — no data
files needed), initial states, per-frame control scripts, an AI entity
with a fixed target, and sample points. Runners:

    node engine/run_trace.js engine/scenario.json      # JS core
    cpp/evflight --trace engine/scenario.json          # C++ port

Both emit `{samples: [{frame, entities: [{x, y, vx, vy, heading}]}]}`.
`node engine/check_traces.js` runs both and requires agreement within
**1e-6 px / deg** at every sample (both use IEEE-754 doubles; only libm vs
V8 transcendental ulps differ).
