# Vₑ engine spec

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

## Combat

Sources: wëap/shïp sections of the resource bible. Deterministic parts
live in the core and are golden-traced; randomness (Inaccuracy roll, AI
jitter) is rolled by the shell and passed in.

**Weapon stats** (wëap record): `Reload` frames between shots; `Count`
shot lifetime in frames; shot speed = `Speed/100` px/frame; `AmmoType`
−1 = unlimited, 0–63 = draws from weapon 128+n's ammo pool; `Graphic` →
spïn 200+n; `Inaccuracy` = uniform ±n° at launch; `Sound` → snd 200+n
(audio milestone); `Impact` = velocity kick to the victim, applied along
the shot heading as `Impact / (10 · victim Mass)` px/frame
(approximation — bible says only "inversely proportional to mass");
`ExplodType` −1 none / 0 small / 1 big / 2 huge → explosion spïns
400/401/402; `ProxRadius` detonation distance (0 = contact);
`MiscFlags` 0x0002 = secondary-trigger weapon.

**Shot kinematics.** All shots inherit the shooter's velocity at launch
(freefall bombs inherit 80% and add no muzzle velocity). Muzzle velocity
`Speed/100` is added along the launch heading. Launch heading: shooter
heading for guidance −1/5/6; aim-at-target for 4 (turret) and 1/2
(homing); quadrant turrets 7/8 clamp the aim to ±45° of the nose/tail.
Per frame after controls: homing shots (1/2) steer toward the target at
**3°/frame** (approximation; classic's homing rate is unrecorded) and fly
at full speed along their heading (no inertia); rockets (6) hold heading
and accelerate along it by `Speed/100/15` per frame up to max; everything
else flies ballistically. `life` decrements each frame; the shot expires
at 0. A shot hits a ship (never its shooter) when
`dist < max(ProxRadius, half the ship sprite)`.

**Beams** (guidance 0, 3): no projectile — a ray of length `Speed` px
(beam reuses the field) from the shooter's nose along its heading
(turreted beams aim at the target), lasting `Count` frames per trigger
pull, applying damage each frame to the first ship within 8 px of the
ray. `Graphic` is a color code (−2 red, −3 green, −4 blue, −5 cyan,
−6 magenta, −7 yellow).

**Damage** (bible, exact): shields up → `MassDmg/4 + EnergyDmg` off
shields; shields down (≤0) → `MassDmg + EnergyDmg/4` off armor; always
at least 1. Shield overflow does not carry into armor. **Disabled** at
armor ≤ ⅓ of max (shïp flag 0x0010 lowers this to 10% — honored when
present): AI stops, engines dead, still targetable. **Destroyed** at
armor ≤ 0: the ship disintegrates for `DeathDelay` frames (drawn
flickering), then explodes — spïn 401 fireball, or 402 + sparks when
DeathDelay ≥ 60 ("huge"). **Shield regen**: +1% of max shields every
`ShieldRe` frames.

**Warship AI** (AIType 3/4 when hostile): steer toward the enemy; thrust
while `dist > 260` px and aligned; inside 120 px keep thrusting (fly-by,
classic's charge-past behavior); fire all ready weapons whose range
(`Speed/100 · Count`) covers the distance whenever within `2·turn`
degrees of the firing solution. Traders under fire: wimpy (1) flees —
steer to the attack bearing + 180° and thrust; brave (2) turns warship
against its attacker. **Hostility**: govt flag `alwaysAttacksPlayer` →
hostile to the player on sight; `xenophobic` → hostile to everyone
except allies (approximated: everyone); any ship the player damages —
and every same-govt ship in the system — holds a grudge for the session.

**Player loadout**: the shïp record's stock `WeapType/WeapCount/AmmoLoad
1–4` plus outfitter weapons (ModType 1; ModType 3 adds ammo to the
matching weapon). Space fires all primary weapons; W cycles secondary
(MiscFlags 0x0002) weapons, X fires the selected one.

## Audio (shell responsibility; browser leg only for now — SDL deferred)

Sound IDs follow the classic files (names baked into the resources):
weapon fire = snd **200 + wëap.Sound** (bible; −1 = silent), played once
per weapon volley (not per barrel). Hyperspace: **128** "Warp Up" as the
streak begins, **130** "Warp Out" on arrival. Explosions: shot impact →
**301** (MedExplosion), or **300** (HeavyExplosion) when ExplodType ≥ 1;
ship destruction → **302** "ShipBreaksUp" when disintegration starts,
**303** "ShipExplodes" at the final fireball. Engine loop **223** while
the player thrusts (with a ~6-frame release so per-frame flicker doesn't
stutter it). Target-cycle beep **150**. Klaxxon **350** once when the
player's shields first hit 0 (re-armed when they recover). Planet
ambient: spöb `CustSndID` (bible: 11 kHz ambient) loops while landed.
Distance attenuation (approximation): `volume × max(0, 1 − dist/1200)`
from the player; events at the player are full volume. `V` toggles sound;
`?mute=1` starts muted. Title music (snd 30000+, EV Music) is deferred
until there's a title screen.

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
