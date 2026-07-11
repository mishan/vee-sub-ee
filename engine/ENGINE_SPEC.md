# Vₑ engine spec

The normative description of flight physics and entity behavior, implemented by
`engine/core.js` (the DOM-free browser core). If the code disagrees with this
file, the code is wrong; if this file is wrong, fix both in the same commit.

## Units and coordinate system

- Logic runs at a fixed **30 Hz** (classic EV's frame rate). All rates are
  per logic frame unless noted.
- Positions are pixels. **y grows downward** (screen space).
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

- `stopDist = |v|²/(2·accel) + |v|·(180/turn) + 40` — kinematic stopping
  distance, **plus the distance coasted while flipping 180° to face
  retrograde** (`180/turn` frames at speed `|v|`), plus a pad. The
  turn-around term is what stops slow-turning ships from sailing past the
  planet before their brake burn bites.
- CRUISE: steer toward target; if `dist > stopDist` and aligned, thrust;
  if `dist ≤ stopDist`, → BRAKE.
- BRAKE: steer toward retrograde; if `|v| > 0.15`, thrust when aligned;
  else if `dist < 80` → LANDING, otherwise → CRUISE (overshot; go around).
- LANDING: fade −= 0.02 per frame (no motion changes); at fade ≤ 0 the
  entity despawns (shell schedules a respawn). The shell may dock the ship
  instantly instead of fading — the core only reports arrival.

## Landing (player)

Eligible: nearest spob with `$sem.canLand`, distance < 60 px, and
`|v| ≤ 0.9 px/frame`. On takeoff the player is placed at
`(spob.x, spob.y − 40)`, heading 0, **velocity 0** (launch stationary,
not drifting). Landing refuels the ship to capacity (see Hyperjump).

**While docked the sim is paused** (the shell's `step()` no-ops when
`landedAt`), so the system freezes behind the landing screen instead of
running on. **Takeoff rebuilds the system** (`loadSystem`): the ships that
were present when you landed are gone and a fresh ambient population +
mission ships are spawned — matching the original, where the world is
repopulated each time you launch. (Shell behavior.)

## Time controls (shell; browser leg)

**Double speed** (classic EV's Caps Lock): the fixed-step loop runs two sim
ticks per real tick while on. Toggled by **either Caps Lock or an on-screen
button** — the `» 2×` indicator top-centre on desktop (click to toggle) and a
`2×` button in the mobile action bar — so it works with Caps Lock disabled and
on touch. Caps Lock is a lock key and `getModifierState` reads stale on the
toggle event itself (it catches up only on the next key), so instead we **flip
on the Caps Lock keydown or keyup, debounced** — one flip per physical press,
absorbing the keydown/keyup pair. The effective flag is the OR of the Caps-Lock
and manual states, so a keypress can't clobber a manual toggle. Caps Lock only
toggles **in flight** — behind the splash/title/hail/service/landing/dead
overlays (which swallow gameplay keys) it is ignored, so it can't silently arm
2× for when you enter the game. It only changes how many `step()`s run per
frame, not the per-step math, so the flight core is untouched. **Suppressed
during hyperspace** (`S.jump` active): the warp spin-up and streak are timed to
the Warp Up sound, so 2× would desync the audio — the loop runs at 1× while
warping and resumes 2× on arrival (the toggle state is preserved, not cleared).

## Hyperjump

- Fuel: raw shïp `Fuel` field; **one jump costs 100** (classic: 100 = one
  jump). Shuttlecraft carries 400 → 4 jumps. Landing refills to capacity.
- Destinations: the current sÿst's `Con1..Con16` fields with values ≥ 128
  that name existing systems.
- Jump sequence (shell drives it, constants normative):
  1. Player selects a linked destination (map). Requires fuel ≥ 100 and
     **distance > 800 px from every spöb** (JUMP_MIN_DIST, approximation
     of classic's "too close to a stellar object" rule) — both to engage
     and to enter hyperspace.
  2. Engage: autopilot steers toward the destination system's map bearing
     (`atan2(dx, −dy)` on galaxy-map coordinates) and forces thrust. The
     hyperdrive warm-up starts now (Warp Up sound, 8.3 s).
  3. The ship enters hyperspace only when (a) aligned within one
     frame-step of turn at ≥ 95% maxSpeed, (b) **220 frames
     (JUMP_WARMUP_FRAMES) have elapsed since engaging** — the drive has
     to spin up; the autopilot cruises toward the destination meanwhile —
     and (c) clear of stellars. Then the 30-frame outbound streak plays
     (timed to land on the sound's final whoosh: 220 + 30 = 250 frames ≈
     the 8.3 s Warp Up).
  4. Arrival: player is placed 700 px from the system center on the
     bearing back toward the origin system, same heading, velocity =
     maxSpeed along the inbound bearing; fuel −= 100. (700 keeps arrival
     within sight of the inner planets; was 1800, which felt stranded.)
     Aborting the engage/warm-up (Esc) cuts the Warp Up sound.

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

## Missions (game rules, not flight core; browser leg)

The mïsn resource ("the crown jewel", per the bible). We implement a
faithful, completable subset; missions whose goals we can't yet resolve
are simply not offered, so no mission ever dead-ends.

**Mission bits.** 512 boolean flags (persisted). Set/cleared by
`CompBitSet/2/4` (on completion) and `FailBitSet/2` (on failure); codes
0–511 set bit n, 1000–1511 clear bit n−1000. Availability reads them via
`AvailBitSet` (−1 ignore; 0–511 require set; 1000–1511 require clear) and
`AvailBitClr` (require clear).

**Day counter.** A calendar day advances on each hyperspace jump (classic
EV's model). `TimeLimit` (days) is checked against days-elapsed-since-
accept; expiry fails the mission.

**Availability** (evaluated per spöb on landing; `AvailRandom` rerolled
per system arrival): `AvailLoc` 0 = mission computer, 1 = bar, 2 = from a
ship (offered on hail — see "Ship-offered missions"). `AvailStel`: −1 any inhabited spöb, a
specific ID, or govt-relative codes (9999+g govt's own, 15000+g ally's,
20000+g anyone-but, 25000+g enemy's). `AvailRating` (−1 ignore, else the
combat rating — total crew killed — must be ≥ it) and `AvailRecord` (0
ignore; positive = legal record with the spöb's govt at least this good;
negative = at least this criminal; −32000 = the spöb must be dominated)
now gate on the tracked rating/record.
Ship-type gates: Flags 0x2000 (not for cargo ships, player inherentAI
1–2), 0x4000 (not for warships, 3–4), and `AvailShipType`
(128–255 must fly / 1128–1255 must not / 2128–2255 must be govt).
Only missions with a supported goal are offered.

**Goals supported:** all ShipGoal types plus cargo/go-to. Cargo delivery
(CargoType/CargoQty, PickupMode 0 = at accept / 1 = at TravelStel,
DropOffMode 0 = TravelStel / 1 = ReturnStel); destroy (0); disable
(1, ship reduced to disabled not destroyed — killing it fails);
board (2, disable then approach ≤ 50 px slow and press **B**);
escort (3, ships spawn friendly and run for their destination — the goal
fails if any is killed, completes when they arrive safely);
observe (4, be in the ShipSyst); rescue (5, ships spawn already disabled,
board them); chase-off (6, destroy or the ship leaves); and plain go-to.
Deferred: aux ships. A catch-goal
target (destroy/disable/board) that reaches a planet loiters rather than
landing, so it can't slip away.

**Ship-offered missions (AvailLoc 2; shell, browser leg).** These are
carried by `përs` resources — named characters (e.g. "Piper Maru"), each
linking a mission via `LinkMission`. A character spawns at most once per
system visit, at a low rate (`maybeSpawnPers`), when it is eligible: its
`LinkSyst` permits the current system (specific ID, or govt-relative
9999/15000/20000/25000+g ranges, −1 = anywhere, unknown → allowed), its
`MissionBit` gate (if any) is set, it hasn't been spent or grudged, and its
`LinkMission` passes the normal availability checks for loc 2 (evaluated
against a representative inhabited spöb of the current system). The
character flies its own `ShipType` with its `Govt`/`AIType`, weapon
overrides, and `ShieldMod`, and — while it still has an unaccepted job — it
loiters instead of docking away.

**Hailing** an eligible character shows its `CommQuote` (STR# 7100) and the
mission briefing with an **Accept**/**Decline** choice alongside the usual
comm options; the `<OSN>` token resolves to the character's name. Accepting
runs the same `acceptMission` path as the bar/computer. Honored `përs`
flags: `deactivateAfterLinkMission` (0x0100 — the character is spent, saved
in `persDone`, never reappears), `leaveAfterLinkMission` (0x0800 — it flees
after you accept), the don't-offer-to-my-ship-class flags (0x1000/0x2000/
0x4000 vs the player's inherentAI), and grudge (attacking a character
withdraws its offer and, if `holdsGrudge` 0x0001, is remembered in
`persGrudge` so it won't deal with you again). `persDone`/`persGrudge` are
persisted in the pilot file. Deferred: replace-ship-on-accept (0x0040),
offer-on-board (0x0200), and the conditional HailQuote radio lines
(STR# 7101).

**Resolution & display.** Random mission fields are resolved **once when
first offered** (cached per system visit), so the briefing shows the real
values and accepting yields exactly what was shown (classic behavior):
TravelStel/ReturnStel codes → a concrete spöb (−2 random inhabited, −3
random uninhabited, −4 the accept spöb, specific ID, 9999/15000/20000/
25000+g govt-relative), CargoQty ≤ −2 → abs·(0.5–1.5) tons, deadline →
gameDay + TimeLimit. Text tokens are substituted in briefs **and mission
names**: `<DST>/<DSY>` destination stellar/system, `<RST>/<RSY>` return,
`<CT>/<CQ>` cargo type/qty, `<DL>` deadline date ("day N, NC <year>"),
`<PN>/<PSN>` player/ship. Briefings show "Destination: <stellar>
(<system>)" and "Deliver by: <date> (<N> days)".

**Special ships**: `ShipCount` ships from `ShipDude`, placed in
`ShipSyst` (−1 accept system, −6 follow the player, specific ID, …),
named from `ShipNameID` STR#. `ShipBehav`: 0/10 attack the player,
1/11 protect, 9/hyper-in delay. They reuse the combat system. Goal
bookkeeping: destroy/chase-off complete when all are gone; disable when
all disabled; board/rescue when all boarded (killing one instead fails
the capture); escort when all arrive unharmed.

**Plot branching.** The storyline is a graph of missions gated by mission
bits: completing a mission's `CompBitSet` unlocks the mission(s) whose
`AvailBitSet` names that bit, while `AvailBitClr`/1000+ codes create
mutually-exclusive branches. The classic data has 49 chaining bits over
72 gated missions — e.g. the Astex opener at Diphidia II: Investigate
Dumping (bit 24) → Observe Antares (25) → Capture Ore Sample (26, board)
→ Destroy Freighters (27) → Escape Astex (28). No new machinery is needed
for chains beyond the bit gating above; the goal types just have to all
work, which is why board/escort/rescue/disable were completed here.

**Flow.** Accept in the bar/computer shows `BriefText` (a dësc); unless
Flags 0x0004 (can't refuse) the player may decline (`RefuseText`). `I`
shows the accepted mission's `QuickBrief`. Loading/dropping cargo shows
`LoadCargText`/`DumpCargoText`. At `ReturnStel` with the goal met,
`CompText` + payout: `PayVal` > 0 credits; −10128−g clears legal record
with govt g; −20128−g / −30128−g grant outfit; −40001−n take n% cash.
`CompGovt`/`CompReward` adjust reputation (a simple per-govt integer we
track; failure subtracts ½·CompReward, per the bible). Failure at
ReturnStel shows `FailText`. Missions persist (bits, active list with
resolved destinations, accept-day, day counter, reputation) in the pilot.

## Outfitter and shipyard

Availability gate for both: item `TechLevel ≤ spöb.TechLevel`, or an exact
match against `SpecialTech1..3`; items with `MissionBit ≥ 0` are hidden
until the mission system exists. Shops show **only available items** —
no empty or grayed slots; the grid compacts (thumbnails still come from
each item's fixed cell in the menu sheet). Owned outfits stay listed
anywhere they'd otherwise be hidden (you can always sell). A shop whose
list would be empty doesn't get a button on the landing screen at all. Outfits: `Cost`/`Mass`/`Max` from the
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
system's spobs. Despawned traders respawn after a 2–8 s delay.

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

**Fighter bays** (guidance 99; shell, browser leg): the weapon carries no
shot — its `AmmoType` is the **ship class ID** of a fighter it launches.
The bay's `WeapCount` (plus outfitter copies) is its size; the shell tracks
`have` = fighters currently docked, refilled to full whenever the loadout is
rebuilt (which happens on landing — same "rearm at port" simplification as
ammo). Firing the bay as a secondary (**player only** for now) launches one
fighter — a player-allied ship of class `AmmoType` that reuses the **escort
AI** (follows/fights the player's enemies, friendly-fire immune, green radar
blip) but is *transient*: it belongs to the bay's ammo, not the saved
`escorts` fleet. Each launch spends one from `have` and starts the bay's
`Reload` cooldown. **K** recalls every deployed fighter — each docks back
into a bay of its type, restoring one `have` (and fighters auto-recall just
before a hyperspace jump so they travel with you). A fighter **shot down is
lost** — its slot is *not* returned to the bay (you rearm on landing). The
sidebar shows `Fighters: have/size`. Deferred: AI carriers launching their
own fighters, and persisting fighter losses across a landing.

**Damage** (bible, exact): shields up → `MassDmg/4 + EnergyDmg` off
shields; shields down (≤0) → `MassDmg + EnergyDmg/4` off armor; always
at least 1. Shield overflow does not carry into armor. **Disabled** at
armor ≤ ⅓ of max (shïp flag 0x0010 lowers this to 10% — honored when
present): AI stops, engines dead, still targetable. **Only AI ships can
be disabled** — the player is destroyed outright when armor hits 0, never
left in a disabled limbo (the player's `disableFrac` is forced to 0 so
damage never yields 'disabled'). **Destroyed** at armor ≤ 0: the ship
disintegrates for `DeathDelay` frames (its engine flame cuts out), then
explodes — spïn 401 fireball, or 402 + sparks when DeathDelay ≥ 60
("huge"). **Shield regen**: +1% of max shields every
`ShieldRe` frames — **except while disabled**: a disabled ship drifts
with collapsed shields and stays a boarding target (the bible is silent
on this; classic gameplay — e.g. mïsn rescue goals that require boarding
a disabled ship — settles it).

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
matching weapon). Space fires all primary weapons; Q cycles secondary
(MiscFlags 0x0002) weapons, X fires the selected one.

## Audio (shell responsibility)

Sound IDs follow the classic files (names baked into the resources):
weapon fire = snd **200 + wëap.Sound** (bible; −1 = silent), played once
per weapon volley (not per barrel). Hyperspace: **128** "Warp Up" as the
streak begins, **130** "Warp Out" on arrival. Explosions: shot impact →
**301** (MedExplosion), or **300** (HeavyExplosion) when ExplodType ≥ 1;
ship destruction → **302** "ShipBreaksUp" when disintegration starts,
**303** "ShipExplodes" at the final fireball. There is **no thrust
sound** — classic flight is silent, and snd 223 "Engine", despite the
name, is a weapon sound (the Forklift's, weap 191 Sound 23 → 200+23; the
name describes the sound, not its role). Target-select beep **150**
(cycling a target, and picking a planet to land on). **390** "Airlock" is
the **boarding** sound (boarding/plundering a disabled ship — NOT
landing, despite what its length suggested; Misha confirmed). Landing
touchdown currently has no dedicated sound — none in the bank is clearly
it. **710** "Voice Targ" is a 1.36 s fighter-command voice line, reserved
for the (unimplemented) fighter-bay mechanic — not a UI blip. Hail dialog
buttons beep with **153**. Red Alert **370** when the count of ships
hostile to the player rises (grudge / bounty hunter / defense fleet),
suppressed for the ambient population on system entry. Klaxxon **350**
once when the player's shields first hit 0 (re-armed when they recover).
Planet ambient: spöb `CustSndID` (bible: 11 kHz ambient) loops while
landed.
Distance attenuation (approximation): `volume × max(0, 1 − dist/1200)`
from the player; events at the player are full volume. `V` toggles sound; `[`/`]` adjust
a master volume (10% steps, multiplied into every event volume,
persisted in localStorage as `ve_volume`); `?mute=1` starts muted. Title music (snd 30000+, EV Music) is deferred
until there's a title screen.

## Legal record & encounters (shell; browser leg)

The **legal record is per system** (persisted; a system with no stored value
defaults to its controlling gövt's `InitialRec`), negative = criminal — like
classic EV, two systems of one government can differ. The status label
(STR# 134) scales a system's record by *that system's* gövt `CrimeTol`, on the
bible's Appendix II ladder: evil at |record| ≥ 1·/4·/16·/64·/256·/1024·/4096·
CrimeTol → Offender…Galactic Scourge; good at ≥ 4·/16·/…·4096·CrimeTol →
Decent Individual…Honored Leader; else Clean. Independent systems use
gövt 128. **Combat rating** (STR# 138 / Appendix I) is separate — it comes from
total crew of destroyed ships: 0/1/100/200/400/800/1600/3200/6400/12800/25600 →
Harmless…Ultimate.

**Applying a change.** A govt-keyed effect (a killed ship's gövt, a mission's
`CompGovt`) is spread across systems by `applyGovtDelta`: the **current system**
takes the full signed change, and every **other** system whose gövt relates to
the affected one has a `SPREAD_PROB` (≈¼) chance of taking a `SPREAD_FRAC`
fraction of it. Sign follows the relationship to the affected gövt — the gövt
itself and its allies same sign (a crime hurts), its enemies the opposite (a
crime against a gövt pleases its foes), a xenophobic gövt counts everyone
unallied as an enemy (so hunting pirates is lawful). This random scatter is
reverse-engineered from real pilot save diffs (one Confed crime spree reddened
26% of Confed systems and lifted 31% of the enemy Rebellion's); the spread
constants are tuned approximations (see CLAUDE.md "Known approximations").

**Consequences of combat** (player actions only): disabling costs
`DisabPenalty`, boarding/plundering `BoardPenalty`, killing `KillPenalty`, each
fed through `applyGovtDelta` against the victim gövt. A kill adds the victim's
crew to the combat rating. (`ShootPenalty` is "currently ignored" per the bible;
we follow suit.)

**Encounters.** Pirate/xenophobic warships are hostile on sight (govt flags). A
warship also spawns hostile if you are **criminal in the current system**
(record below −CrimeTol) and its gövt enforces there — the system's own gövt, an
ally, or a gövt flagged to enforce its laws everywhere (0x0002). When you're
criminal in the current system, **bounty hunters** hyperspace in at the edge
(hostile, named from STR# 10008, capped by how notorious you are in that
system). The galaxy map shows the legal status for the selected system and your
combat rating.

## Hailing (shell; browser leg)

`Y` opens a modal hail dialog (pauses the sim) for the current ship or
nav target; buttons play a click (snd 600). Response text comes from the
classic STR# comm lists. **Ship comm** (STR# 3000, grouped): 0–4
channel-open, 5–9 no-response, 10–14 "What do you want?", 15–19
beg-for-life, 20–29 cordial greeting, 50–59 rude, 60–64 can't-afford,
70–74 no-danger, 90–94 pay-first, 95–99 refuse, 100–104 deal-done,
115–119 good-mood accept, 120–124 bad-mood refuse, 135–139 I'll-leave-
you-alone, 140–144 fuel-for-a-price. Greeting: a hostile ship snarls
(10–14), otherwise the govt greeting (7000+govt) or cordial (20–29). The
`.who` line shows the govt and **HOSTILE** (red) when hostile.

**Ship options:** *Request assistance* — a hostile ship refuses (95–99);
if you don't need fuel it says so (70–74); otherwise it offers to refuel
for `FUEL_PRICE` (1500 cr) with a *Pay* / *Offer half* / *Never mind*
sub-dialog (a low-ball lands only on a coin-flip "good mood", else it's
refused). *Beg for mercy* (hostile only) — ~45% the pilot names a bribe
(20% of your credits, clamped 500–5000) you can *Pay* to make it break
off (hostile→false, flees), else it taunts you. *Demand surrender /
plunder* (disabled only) → loot credits. **Planet** options: request
information (a 3002 no-info line), demand tribute, close. **Tribute/
domination:**
demanding tribute from a governed planet with a defense fleet
(`DefDude`/`DefCount`; >1000 encodes waves, last digit = ships/wave)
refuses and scrambles that fleet (hostile, tagged to the spöb). Once you
destroy the fleet the spöb is *subdued*; demanding again pays a one-time
tribute (`2000·(TechLevel+1)` cr — a convention, since classic spöb data
has no tribute-amount field) and marks it *dominated* (persisted).

## Boarding (shell; browser leg)

`B` boards the nearest **disabled** ship within 50 px while nearly stopped
(≤ `2·LAND_SPEED`). A mission board target (shipGoal 2/5) just completes the
objective as before. Any other ship opens a modal boarding dialog (Airlock
snd 390) with **Capture vessel**, **Loot the hold**, and **Leave**:

- **Loot** yields the dude's `Booty` flags (bible): commodities
  0x01–0x20 = food/industrial/medical/luxury/metal/equipment (a few tons
  each, into free hold space) and 0x40 = money (a slice of the hull's
  `Cost`). `Booty == 0` ⇒ "repelled", loot disabled. Looting applies the
  govt's `BoardPenalty` and leaves the ship **disabled but flagged looted**,
  so it can't be boarded again. (Booty is *only* goods + money — no fuel or
  ammo, per the bible.)
- **Capture** rolls `playerCrew / (playerCrew + targetCrew)` — crew from the
  shïp `Crew` field, plus any Marines outfit (ModType 25, `ModVal` per unit;
  none exist in the Override data but the hook is there). The crew-ratio
  formula is an **approximation** (the bible names the inputs, not the
  odds). On success the prize is yours and you choose its fate (see
  **Escorts**): **Take command** — switch to the captured hull (stock
  loadout — your old ship's outfits are abandoned), repaired, refuelled,
  repositioned at the prize, cargo clamped to the new hold, and your former
  ship falls in as an escort; or **Add to your fleet** — keep your ship and
  the prize joins you as an escort. Failure ⇒ the crew **self-destruct** the
  ship (it begins its death sequence). Either way the attempt applies
  `BoardPenalty`.

## Escorts (shell; browser leg)

Player-owned escorts are allied AI ships that fly with the player. They are
persisted in the pilot file as `escorts: [{id, shipId, name}]` and
re-materialised on every system entry / takeoff by `spawnEscorts`, which the
jump/takeoff callers invoke **after** they place the player (`completeJump`
after `placeAtArrival`, `takeOff` after `placeAtTakeoff`, initial boot when in
flight) — not inside `loadSystem`, which runs before placement and would spawn
the fleet around the player's stale pre-arrival coordinates. So a fleet
follows the player through hyperspace and off
planets. A live escort entity is a normal AI ship with `playerEscort = true`,
`aiType = 3` (warship behaviour), and `govt = 0` (no affiliation, so it stays
out of government reaction/vendetta logic).

Escort AI each frame: pick the **nearest ship hostile to the player** and
engage it with `stepWarship` + `fire` (same warship steering/aim the enemy
population uses); with no hostile in the system, shadow the player
(`stepWarship` toward the player's position). Escorts never target the player
or each other. **Friendly fire is off**: the player and their escorts are one
side, and shots/beams whose owner and victim are both on that side pass
through harmlessly. Enemy fire hits escorts normally, and an escort that is
destroyed is removed from the saved fleet **permanently** (no ambient
replacement is scheduled). Escorts show as green radar blips.

### Escorts for hire (shell; browser leg)

The **Spaceport Bar** carries two boards, toggled by tabs: the mission BBS
(as before) and a **hire-escort** dialog. The dialog shows *Your fleet* (each
escort with its type, per-jump salary or "captured", and a **Dismiss**
button) alongside *Pilots for hire* — a small fixed roster with each hull's
fee, upkeep, and its ship-class description (desc ID `2000 + (shipId - 128)`, from the
data file). The roster is the four cheapest armed, purchasable (`Cost > 0`),
non-mission-locked hulls, computed once from the ship table (so it's stable
and data-driven rather than hard-coded).

Hiring pays a one-time **fee** and enlists a persistent escort that draws a
per-jump **upkeep**; both are fractions of the hull's `Cost` (`HIRE_FEE_FRAC`
0.5 with a 1 000 cr floor, `UPKEEP_FRAC` 0.01 with a 50 cr floor). Like the
commodity multipliers and trade-in rate, **these figures are conventions, not
from the bible — flagged as approximations.** The fleet is capped at
`MAX_ESCORTS` (6, hired + captured) and the cap is enforced everywhere a ship
would join: hiring is blocked when full, the capture dialog's **Add to your
fleet** is disabled when full, and taking command of a prize while full leaves
your old ship behind rather than exceeding the cap. Upkeep is charged on each hyperspace jump
(`completeJump`); any escort you can't cover **quits on arrival** (deducted in
fleet order, so you keep as many as you can afford). Captured ships draw no
salary. A hired escort is otherwise identical to a captured one — same allied
AI, persistence, friendly-fire immunity, and permanent loss on death.

The wider original system (per-government rosters, tech-gated availability,
pilot bios in desc 2100–2163, and in-flight fleet commands) is **not
implemented**; escorts fight and follow automatically.

## Persistence (shell responsibility; browser leg)

The pilot auto-saves **on landing and on takeoff** (classic saved when
you landed; the takeoff save captures docked trades and refits) to
localStorage key `ve_pilot`: version, current system, docked spöb, ship,
credits, cargo, outfits, explored set, and the `escorts` fleet. Fuel/shields/armor are not saved —
landing restores them anyway. On load with no gameplay-affecting URL
params, the pilot restores docked at the saved spöb. Any test param
(`?syst ?ship ?x ?y ?heading ?ff ?land ?exchange ?outfitter ?shipyard
?map ?dest ?jump ?tab ?nav ?fire ?new`) enters **test mode**: no restore
and no saving, so headless runs never touch a real pilot. Death: R
returns to the last landing (reload restores the save) — it sets a
`ve_resume` sessionStorage flag first so the reload drops **straight back
into the game, skipping the title intro**; N abandons the pilot and starts
fresh; `?new=1` does the same from a URL.

## Title screen (shell responsibility; browser leg)

On a normal load the boot sequence echoes the original: a **loading splash**
(PICT 131 in EV Titles) with a blinking "Press any key to continue" comes up
first. The first key or pointer gesture unlocks audio (browser autoplay
policy) and starts the title theme, the prompt becomes "Loading…", and after
a short beat the splash fades to reveal the **title menu** (PICT 8000), which
fades/scales in. (Classic's Ambrosia-logo intro is intentionally skipped.)

The title menu is shown over the already-initialised game as a full-screen
overlay, and the sim is paused until the player chooses an option. The splash
and title are treated like a modal: while either is up the sim is frozen and
every gameplay hotkey is swallowed (any key merely advances the splash), so
the game can't be driven behind the overlay. The art carries its own baked
menu labels; the shell places transparent hotspots over them:

- **New Pilot** — a two-step dialog (echoing the original): name the pilot
  with a **Strict Play** (permadeath) option, then name the starting
  Shuttlecraft. Each field is pre-seeded with a random suggestion. The
  suggestions come from the EV app's STR# 128 ("Default Names", first half
  pilots / second half ships), injected at build via `--app`; the committed
  template keeps generic fallbacks (data-free). Confirming writes a fresh
  pilot (Levo, Shuttlecraft, 10 000 cr, with name/shipName/strict) and
  reloads to the menu.
- **Open Pilot** / **Enter Ship** — dismiss the title and resume the loaded
  pilot (docked at the saved spöb, or in flight if none). **They do nothing
  without a loaded pilot** (New Pilot must create one first).
- **Strict Play**: on death the pilot is deleted (no R-restore); the
  game-over hint says so.
- **Set Prefs** — toggles sound.
- **About EV…** — shows the STR# 20000 intro text plus a clean-room note.
- **Quit EV** — no-op in the browser (note to close the tab).

The central viewscreen shows a **summary of the current pilot's game** (as the
original does), drawn on a canvas so it scales with the framed art: ship type,
current system, legal status in that system, combat rating, credits, and the
date. The date follows classic EV — real date + 250 years at pilot creation,
+1 day per hyperjump (`gameDay`) — so a fresh pilot reads like the original's.
When no pilot is loaded (no save) the viewscreen reads **"No Pilot file
loaded"** instead.

Title music (snd 30000, in the music/ set) prefers the **Web Audio API**: the
file is fetched and `decodeAudioData`'d up front, and the first splash gesture
`resume()`s the AudioContext (the reliable mobile unlock) and starts the
pre-decoded buffer — so the theme begins on the loading screen, not on a later
menu tap. Because some mobile browsers only honour `resume()` from a
pointerup/touchend/click (not the splash's pointerdown), the unlock is armed on
every gesture type until the context runs. Some desktop browsers' decode
**rejects the classic 8-bit PCM WAV**, so on decode failure (or where Web Audio
is absent) it **falls back to an HTMLAudio element**, which every browser plays;
the same gesture unlock drives both. Volume tracks `0.7·masterVol`; the theme
stops on entering the game. (Sound effects keep using HTMLAudio; they unlock
once gameplay begins.) Any test-param run (see Persistence) skips
the intro so headless screenshots go straight to the game; `?title`/`?splash`
force the splash, `?titlemenu` jumps to the menu.

## Touch controls (shell responsibility; browser leg)

On touch devices (detected via `pointer: coarse` / `ontouchstart` /
`maxTouchPoints`, forceable with `?mobile=1`, off with `?mobile=0`) the shell
overlays on-screen controls; the game is landscape-only and shows a
rotate-to-landscape nudge in portrait. The controls are shown only while
actually flying (hidden on the splash/title, landing, service, hail, and
game-over screens).

- **Floating joystick** (left thumb): appears wherever the thumb presses in
  the left region. Its angle is an *absolute* facing — the ship steers toward
  it (past a small ~18% deadzone). Steering is **decoupled from thrust** so
  aiming never accidentally burns the engine. The joystick does **not** touch
  the flight core: it synthesizes the same `left`/`right` booleans the keyboard
  produces (turn toward the target heading, stopping within half a turn-step so
  it doesn't oscillate), so physics is unaffected.
- **Thrust and Fire buttons** (bottom-right, side by side, clear of the sidebar
  panel): each holds its control (`thrust` / primary trigger) while pressed.
- **Mini action bar** (always-on, top-centre): Target/Nav cycle, Land, Board,
  Hail, Map, Jump, Missions, and a sound toggle — each just calls the same
  handler as its keyboard shortcut. On the galaxy map the joystick and fire
  button hide so canvas taps can pick a destination (fingertip hit radius is
  enlarged).

Fitting the small screen: the fixed 144×480 sidebar panel is scaled down to
fit the viewport height (no-op on desktop, where the viewport is taller).
The landing and service dialogs cap their width to the viewport and, since
there is no Esc key, carry a **persistent Take Off / Back button pinned to the
overlay** (reachable without scrolling past the dialog body); the keyboard-hint
strip is hidden on touch. The viewport meta keeps browser/assistive **zoom
enabled** (accessibility); accidental double-tap zoom over the play area is
suppressed with `touch-action` (the touch controls capture their own gestures).
The title theme uses Web Audio (see "Title screen"); because some mobile
browsers only honour `AudioContext.resume()` from a pointerup/touchend/click
rather than the pointerdown the splash advances on, the unlock is armed on
every gesture type until the context is actually running.

## Sprite ID conventions (from the EV bible, see semantics.js)

ship spïn = 128 + (shïp − 128); stellar spïn = 300 + spöb.Type;
weapons 200–263, explosions 400–402. Landing landscape: PICT
(10000 + spöb.Type) in EV Titles (34 landscapes, one per stellar type),
overridden by `CustPicID` when ≥ 0; fall back to the standard if the
custom PICT is missing from the data. Per-ship PICTs (index = shïp − 128):
shipyard detail 5000+i, **target-display schematic 3000+i** ("Target
Pics"), **hail comm portrait 5300+i** ("Ship Comm Dialog"); shop menu
sheets 5100 (ships) / 6100 (outfits), outfit detail 6000+i.
