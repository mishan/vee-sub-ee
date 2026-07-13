import {
  missionLog,
  S,
  Save,
  TEST_MODE,
  escorts,
  explored,
  preloadSprites,
  ships,
  showMsg,
  spinsNeededFor,
  strictPlay,
  systs,
  tutSeen,
  tutorialActive,
} from './01-state.js';
import { tutorial } from './ui/tutorial.js';
import { maybeSpawnBountyHunter, spawnAI, isPort } from './02-spawning.js';
import { attenuate, playSnd, stopAllLoops } from './03-sound.js';
import {
  abortJump,
  completeJump,
  fire,
  hitShip,
  mapBearingTo,
  nearestSpobInfo,
  player,
  shipHalf,
  spawnExplosion,
} from './04-combat.js';
import { keys, touchCtl } from './05-input.js';
import { hailOpen, onShipDestroyed } from './06-interaction.js';
import {
  govtAllies,
  govtEnemies,
  govts,
  maybeSpawnMissionShips,
  misnName,
  misns,
  onMissionEscortArrived,
  spobById,
} from './08-missions.js';
import { maybeSpawnPers } from './15-pers.js';
import { introUp } from './11-title.js';

/*
 * engine/shell/09-step.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 *
 * The 30 Hz tick lives on a `World` object (docs/OOP_DESIGN.md, phase 2): it
 * owns the live entities — the player, AI ships, shots, beams, explosions — and
 * advances them one frame in `step()`. The collections are still physically
 * stored on S for now (loadSystem rebuilds them per system); World exposes them
 * through getters, so the tick reads its entities through one object and later
 * phases can migrate ownership onto it. `export const step` stays a thin wrapper
 * so the run loop (17-main) is unchanged.
 *
 * AI ships pick a behavior from a small strategy hierarchy (phase 3): the tick
 * calls `aiFor(ship, world).step(ship, world)` instead of an if/else-if chain on
 * the ship's flags.
 */
/* ---------------- logic step (30Hz) ---------------- */

export function maxWeaponRange(e) {
  let r = 0;
  for (const w of e.weapons)
    if (w.rec.Guidance !== 99)
      r = Math.max(
        r,
        w.rec.Guidance === 0 || w.rec.Guidance === 3
          ? w.rec.Speed
          : EV.shotSpeedOf(w.rec) * w.rec.Count,
      );
  return r;
}

/* Red-alert when the number of ships hostile to the player rises (a new
 * grudge, a bounty hunter jumping in, a defense fleet scrambling) — but not
 * for the ambient population when a system first loads (alertGrace). */
S.prevHostiles = 0;
S.alertGrace = 0;
export function checkHostileAlert(aiShips = S.aiShips) {
  const n = aiShips.filter((s) => s.hostile && s.deathT < 0).length;
  if (S.alertGrace > 0) S.alertGrace--;
  else if (n > S.prevHostiles) playSnd(370, 0.7); // Red Alert
  S.prevHostiles = n;
}

/* ---------------- AI strategies (spec: "AI …") ----------------
 * One strategy per behavior an AI ship can take, dispatched each frame by
 * `aiFor(ship, world)` from the ship's current disposition (docs/OOP_DESIGN.md,
 * phase 3). Strategies are stateless — they act on the ship + world passed in —
 * so a single shared instance of each is reused. The flight math still lives in
 * the core (EV.stepWarship / stepTrader / stepFlee); the strategy decides which
 * to run, picks a target, and fires. */
class AI {
  // eslint-disable-next-line no-unused-vars
  step(s, world) {}
}

/* A player escort: guard the player, engaging the nearest ship hostile to them,
 * otherwise holding a loose formation. Escorts never target the player's side. */
class EscortAI extends AI {
  step(s, world) {
    let tgt = null,
      best = Infinity;
    for (const h of world.ships) {
      if (h === s || h.playerEscort || h.deathT >= 0 || h.disabled || !h.hostile) continue;
      const d = Math.hypot(h.x - s.x, h.y - s.y);
      if (d < best) {
        best = d;
        tgt = h;
      }
    }
    if (tgt && !S.gameOver && !S.landedAt) {
      const r = EV.stepWarship(s, tgt.x, tgt.y);
      if (r.aligned && r.dist < maxWeaponRange(s)) fire(s, tgt, true);
    } else {
      EV.stepWarship(s, world.player.x, world.player.y); // shadow the player
    }
  }
}

/* Govt hostility between two AI ships (spec: "AI vs AI"). True when `s` should
 * attack `o` on sight: o's govt is s's govt's Enemy, or s's govt is xenophobic
 * (attacks any non-ally — e.g. the Pirates). Same govt or allies never. */
const ENGAGE_RANGE = 1600; // ambient warships only chase govt-enemies this close
const govtFlags = (g) => (govts[g] && govts[g].$sem ? govts[g].$sem.flags : []);
function aiEnemies(s, o) {
  const sg = s.govt,
    og = o.govt;
  if (sg < 128 || og < 128 || sg === og) return false;
  // Ally/Enemy are read in both directions, like legal relation() in 13-legal:
  // either govt naming the other settles it, so the two sides can't disagree.
  if (govtAllies(sg).includes(og) || govtAllies(og).includes(sg)) return false;
  if (govtEnemies(sg).includes(og) || govtEnemies(og).includes(sg)) return true;
  return govtFlags(sg).includes('xenophobic');
}
const foeValid = (s, world) =>
  s.foe && s.foe.deathT < 0 && !s.foe.disabled && world.ships.includes(s.foe);

/* The ship a combat AI should fight this frame, or null: the nearest of the
 * player (only if hostile to it), a foe that has damaged it (any range), and —
 * for ambient warships — the nearest govt-enemy within ENGAGE_RANGE. Mission and
 * pers ships and the player's escorts are left out of ambient targeting. */
function combatTarget(s, world) {
  let best = null,
    bd = Infinity;
  const p = world.player;
  if (s.hostile && p.deathT < 0 && !S.gameOver && !S.landedAt) {
    best = p;
    bd = Math.hypot(p.x - s.x, p.y - s.y);
  }
  const foe = foeValid(s, world) ? s.foe : (s.foe = null);
  const hunts = s.aiType >= 3 && s.misnId == null && !s.isPers; // ambient warship
  for (const o of world.ships) {
    if (o === s || o.deathT >= 0 || o.disabled || o.playerEscort) continue;
    let elig = o === foe;
    if (!elig && hunts && o.misnId == null && !o.isPers && aiEnemies(s, o))
      elig = Math.hypot(o.x - s.x, o.y - s.y) <= ENGAGE_RANGE;
    if (!elig) continue;
    const d = Math.hypot(o.x - s.x, o.y - s.y);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

/* A warship (or brave trader with a grudge): fight the nearest hostile — the
 * player, a foe, or an ambient govt-enemy — else cruise like a trader. */
class WarshipAI extends AI {
  step(s, world) {
    const t = combatTarget(s, world);
    if (!t) {
      traderAI.step(s, world); // nothing to fight → cruise / loiter
      return;
    }
    const r = EV.stepWarship(s, t.x, t.y);
    if (r.aligned && r.dist < maxWeaponRange(s)) fire(s, t, true);
  }
}

/* A frightened ship: turn tail and run — from the AI that shot it if it has one
 * (keep fleeing it even after it's disabled/gone, not switch to the player),
 * otherwise from the player. */
class FleeAI extends AI {
  step(s, world) {
    const from = s.foe || world.player;
    EV.stepFlee(s, from.x, from.y);
  }
}

function despawnAI(s, world) {
  world.ships.splice(world.ships.indexOf(s), 1);
  if (S.shipTarget === s) S.shipTarget = null;
}
const randomSpob = () =>
  S.spobs.length ? S.spobs[Math.floor(Math.random() * S.spobs.length)] : null;

/* An ambient/mission trader: cruise to a planet, sit there a while, then take
 * off and hyperspace out at the system edge (spec: "AI trader"). Catch-goal
 * mission ships and unoffered pers loiter instead (they mustn't slip away);
 * mission escorts complete their arrival on touchdown. */
class TraderAI extends AI {
  step(s, world) {
    const catchGoal = (s.misnId != null && !s.escort) || (s.isPers && !s.offered);
    // A plain ambient trader with nowhere to land — a port-less system (empty,
    // star-only, or all-uninhabited), or a target that isn't an inhabited
    // landable port — doesn't loiter: it heads straight back out. (Catch-goal /
    // escort ships, and ships already landed or departing, keep their flow.)
    if (
      !catchGoal &&
      !s.escort &&
      s.state !== 'landed' &&
      s.state !== 'depart' &&
      !isPort(s.target)
    ) {
      s.state = 'depart';
      s.departing = false;
      s.target = null; // depart logic below picks a system edge to leave through
    }
    EV.stepTrader(s, s.target);
    if (catchGoal) {
      // Don't let it leave: if it lands or tries to depart, send it back to a
      // planet and keep loitering in-system.
      if (s.state === 'landed' || s.state === 'depart') {
        s.state = 'cruise';
        s.departing = false;
        s.target = randomSpob();
      }
      return;
    }
    // A mission escort reaching its destination completes the mission arrival.
    if (s.misnId != null && s.escort && s.state === 'landed') {
      onMissionEscortArrived(s);
      despawnAI(s, world);
      return;
    }
    // Plain trader taking off: aim it at the system edge, then remove it once
    // it's flown clear (a hyperspace-out) and schedule a replacement arrival.
    if (s.state === 'depart') {
      if (!s.departing) {
        const a = Math.random() * Math.PI * 2;
        s.target = { x: Math.cos(a) * 3000, y: Math.sin(a) * 3000 };
        s.departing = true;
      }
      if (Math.hypot(s.x, s.y) > 2600) {
        despawnAI(s, world);
        if (s.misnId == null) {
          const epoch = S.systEpoch;
          setTimeout(
            () => {
              if (epoch === S.systEpoch) spawnAI(true);
            },
            2000 + Math.random() * 6000,
          );
        }
      }
    }
  }
}

const escortAI = new EscortAI(),
  warshipAI = new WarshipAI(),
  fleeAI = new FleeAI(),
  traderAI = new TraderAI();

/* Pick the strategy for a ship this frame: escorts guard the player; a fleeing
 * ship runs; warships (and brave traders with a grudge) fight via WarshipAI,
 * which resolves whether there's actually a target (player / foe / govt-enemy)
 * and otherwise cruises; everything else trades. */
function aiFor(s, world) {
  if (s.playerEscort) return escortAI;
  if (s.fleeing) return fleeAI; // surrender / begged-off / wimpy trader running
  // Warships fight (WarshipAI picks the target: player, foe, or govt-enemy); a
  // brave trader turns warship once it's hostile to the player (grudge) or
  // something has become its foe.
  if (s.aiType >= 3 || (s.aiType === 2 && (s.hostile || foeValid(s, world)))) return warshipAI;
  return traderAI;
}

/* The live flight simulation for the current system. It owns the entities and
 * the tick; the collections are read through getters (still backed by S until a
 * later phase moves storage here). */
export class World {
  get player() {
    return player;
  }
  get ships() {
    return S.aiShips;
  }
  get shots() {
    return S.shots;
  }
  get beams() {
    return S.beams;
  }
  get explosions() {
    return S.explosions;
  }

  step() {
    // dialogs/splash/title pause the sim; landed pauses too — the system is
    // frozen while docked and rebuilt fresh on takeoff; the galaxy map pauses it
    // while you plan a route.
    if (S.gameOver || hailOpen || introUp() || S.landedAt || S.mapOpen || S.missionsOpen) return;
    maybeSpawnBountyHunter();
    checkHostileAlert(this.ships);
    if (!S.landedAt) {
      // One nearest-planet scan for this frame, shared by the jump cue and the
      // drift tutorial below (the player hasn't moved between them). The later
      // jump-engage check re-scans because stepJumpEngage moves the player first.
      const nearDist = nearestSpobInfo().dist;
      // Hyperspace-ready cue: with a destination armed and the fuel to take it,
      // light the nav pane and ding once the instant you clear the no-jump ring
      // (and again if you drift back out and clear it anew).
      const jumpReady =
        !S.jump &&
        S.jumpDest != null &&
        !!systs[S.jumpDest] &&
        S.fuel >= EV.JUMP_FUEL &&
        nearDist >= EV.JUMP_MIN_DIST;
      if (jumpReady && !S.jumpReady) playSnd(150, 0.5); // ding on entering jump range
      S.jumpReady = jumpReady;
      // New-pilot tutorial: once you've drifted far enough that the nearest planet
      // has left the radar (~2600 px, its half-range) — the point the nav arrow
      // shows — nudge toward the map/jump. Self-guards to fire once.
      if (tutorialActive && !tutSeen.has('drift') && nearDist > 2600) tutorial('drift');
      if (S.jump && this.player.deathT >= 0) abortJump(); // no jumping out of a fireball
      if (S.jump && S.jump.phase === 'engage') {
        const ready = EV.stepJumpEngage(this.player, mapBearingTo(S.jump.destId));
        S.jump.t++;
        // spec: aligned+fast AND drive spun up AND clear of stellars
        if (
          ready &&
          S.jump.t >= EV.JUMP_WARMUP_FRAMES &&
          nearestSpobInfo().dist >= EV.JUMP_MIN_DIST
        )
          S.jump = { destId: S.jump.destId, phase: 'streak', t: 0 };
      } else if (S.jump && S.jump.phase === 'streak') {
        EV.thrust(this.player);
        EV.integrate(this.player);
        if (++S.jump.t >= EV.JUMP_STREAK_FRAMES) completeJump();
      } else if (this.player.deathT >= 0) {
        EV.integrate(this.player); // breaking up: drift while the death timer runs
        if (--this.player.deathT <= 0) {
          spawnExplosion(this.player.x, this.player.y, this.player.deathDelay >= 60 ? 2 : 1);
          playSnd(303);
          stopAllLoops();
          S.gameOver = true;
          if (strictPlay) Save.remove(Save.activeId()); // permadeath — pilot gone
          let hasPilot = false;
          try {
            hasPilot = !TEST_MODE && !!Save.load();
          } catch {}
          document.getElementById('deadHint').textContent = strictPlay
            ? 'Strict Play: this pilot is gone for good. N: new pilot'
            : hasPilot
              ? 'R: return to your last landing · N: new pilot'
              : 'Press R to try again';
          document.getElementById('dead').style.display = 'flex';
        }
      } else {
        let cl = keys['arrowleft'] || keys['a'];
        let cr = keys['arrowright'] || keys['d'];
        let cThrust = keys['arrowup'] || keys['w'];
        // Joystick → same booleans: turn toward the stick's absolute heading,
        // stopping within half a turn-step so it doesn't oscillate; a firm push
        // (touchCtl.thrust) burns the engine.
        if (touchCtl.steer) {
          let diff = EV.norm(touchCtl.heading - this.player.heading);
          if (diff > 180) diff -= 360;
          if (diff > this.player.turn * 0.5) cr = true;
          else if (diff < -this.player.turn * 0.5) cl = true;
        }
        if (touchCtl.thrust) cThrust = true;
        EV.stepPlayer(this.player, {
          left: cl,
          right: cr,
          retro: keys['arrowdown'] || keys['s'],
          thrust: cThrust,
        });
        EV.stepShields(this.player, this.player.shieldMax, this.player.shieldRe);
        for (const w of this.player.weapons) if (w.cool > 0) w.cool--;
        if (keys[' '] || touchCtl.fire) fire(this.player, S.shipTarget, true);
        if (keys['x'] && this.player.selSecondary) fire(this.player, S.shipTarget, false);
        /* klaxxon on shield collapse, re-armed on recovery */
        if (this.player.shields <= 0 && S.klaxxonArmed) {
          playSnd(350, 0.8);
          S.klaxxonArmed = false;
        } else if (this.player.shields > this.player.shieldMax * 0.25) S.klaxxonArmed = true;
      }
    }

    for (const s of [...this.ships]) {
      if (s.deathT >= 0) {
        // disintegrating (fireball already going)
        EV.integrate(s);
        // secondary blasts flicker across a bigger hull as it comes apart
        if (s.deathDelay >= 30 && s.deathT % 7 === 0)
          spawnExplosion(s.x + (Math.random() - 0.5) * 24, s.y + (Math.random() - 0.5) * 24, 0);
        if (--s.deathT <= 0) {
          spawnExplosion(s.x, s.y, s.deathDelay >= 60 ? 2 : 1); // final blast
          playSnd(303, attenuate(s.x, s.y)); // the final boom
          onShipDestroyed(s);
          this.ships.splice(this.ships.indexOf(s), 1);
          if (S.shipTarget === s) S.shipTarget = null;
          if (s.fighter) {
            // a downed fighter is lost (bay ammo not restored)
            showMsg(`Your ${ships[s.shipId] ? ships[s.shipId].name : 'fighter'} was shot down.`);
            continue;
          }
          if (s.playerEscort) {
            // a lost escort is gone for good
            const i = escorts.findIndex((e) => e.id === s.escId);
            const name =
              (i >= 0 && escorts[i].name) ||
              s.misnName ||
              (ships[s.shipId] && ships[s.shipId].name) ||
              'escort';
            if (i >= 0) escorts.splice(i, 1);
            showMsg(`Your escort ${name} was destroyed.`);
            continue; // don't spawn an ambient replacement
          }
          const epoch = S.systEpoch;
          setTimeout(
            () => {
              if (epoch === S.systEpoch) spawnAI(true);
            },
            4000 + Math.random() * 8000,
          );
        }
        continue;
      }
      if (s.warpIn > 0) {
        // Warp-in coast: the ship exits hyperspace above its top speed and
        // decelerates to sub-light before its AI takes the helm. No steering,
        // shields or fire yet — it's still slowing from the jump.
        const sp = Math.hypot(s.vx, s.vy);
        if (sp > s.maxSpeed * 1.02) {
          const k = Math.max(s.maxSpeed / sp, 0.92);
          s.vx *= k;
          s.vy *= k;
          EV.integrate(s);
          s.warpIn--;
          continue;
        }
        s.warpIn = 0; // dropped to sub-light (or entered at rest) → hand to AI
      }
      if (s.disabled) {
        EV.integrate(s);
        continue;
      }
      EV.stepShields(s, s.shieldMax, s.shieldRe);
      for (const w of s.weapons) if (w.cool > 0) w.cool--;
      // Behavior is a strategy chosen from the ship's current disposition
      // (escort / hostile-to-player / fleeing / trader) — see the AI classes.
      aiFor(s, this).step(s, this);
    }

    /* shots */
    const everyone =
      this.player.deathT < 0 && !S.landedAt && !S.gameOver
        ? [this.player, ...this.ships]
        : [...this.ships];
    // The player and their escorts are one side: their fire never harms each other.
    const alliedTo = (o) => o === this.player || o.playerEscort;
    const friendly = (a, b) => alliedTo(a) && alliedTo(b);
    for (const shot of [...this.shots]) {
      const alive = EV.stepShot(shot, shot.homing);
      let hit = false;
      for (const v of everyone) {
        if (v === shot.owner || v.deathT >= 0 || friendly(shot.owner, v)) continue;
        if (Math.hypot(v.x - shot.x, v.y - shot.y) < Math.max(shot.rec.ProxRadius, shipHalf(v))) {
          hitShip(v, shot.rec, shot.heading, shot.owner);
          if (shot.rec.ExplodType >= 0) spawnExplosion(shot.x, shot.y, shot.rec.ExplodType);
          hit = true;
          break;
        }
      }
      if (hit || !alive) this.shots.splice(this.shots.indexOf(shot), 1);
    }

    /* beams: ray from owner's nose, damage first ship within 8 px */
    for (const b of [...this.beams]) {
      if (b.owner.deathT >= 0 || --b.life <= 0) {
        this.beams.splice(this.beams.indexOf(b), 1);
        continue;
      }
      b.heading =
        b.turreted && b.target
          ? EV.bearing(b.target.x - b.owner.x, b.target.y - b.owner.y)
          : b.owner.heading;
      const dx = Math.sin(EV.rad(b.heading)),
        dy = -Math.cos(EV.rad(b.heading));
      let bestT = Infinity,
        bestV = null;
      for (const v of everyone) {
        if (v === b.owner || v.deathT >= 0 || friendly(b.owner, v)) continue;
        const t = (v.x - b.owner.x) * dx + (v.y - b.owner.y) * dy;
        if (t < 0 || t > b.rec.Speed) continue;
        const px = b.owner.x + dx * t,
          py = b.owner.y + dy * t;
        if (Math.hypot(v.x - px, v.y - py) < 8 + shipHalf(v) / 2 && t < bestT) {
          bestT = t;
          bestV = v;
        }
      }
      b.len = bestV ? bestT : b.rec.Speed;
      if (bestV) hitShip(bestV, b.rec, b.heading, b.owner);
    }

    /* explosions */
    for (const ex of [...this.explosions]) {
      if (++ex.tick % 2 === 0 && ++ex.f >= ex.frames)
        this.explosions.splice(this.explosions.indexOf(ex), 1);
    }
  }
}

/* The single live world. `step` stays exported as a thin wrapper so the run
 * loop (17-main) and fast-forward keep calling step() unchanged. */
export const world = new World();
export const step = () => world.step();

/* Arrive in / load a system: rebuild the per-system world and spawn ambient
 * AI plus this system's mission/pers ships. Called on jump arrival,
 * takeoff, and initial boot. */
export function loadSystem(systId) {
  S.SYSTEM_ID = +systId;
  S.syst = systs[S.SYSTEM_ID];
  explored.add(S.SYSTEM_ID);
  S.systEpoch++;
  S.spobs = Object.entries(DATA.types.spob)
    .filter(([, p]) => p.System === S.SYSTEM_ID)
    .map(([id, p]) => ({ id: +id, x: p.xPos, y: p.yPos, ...p }));
  S.aiShips = [];
  S.shots = [];
  S.beams = [];
  S.explosions = [];
  S.navTarget = null;
  S.shipTarget = null;
  S.alertGrace = 45;
  S.prevHostiles = 0; // don't red-alert the ambient population
  preloadSprites(spinsNeededFor(S.SYSTEM_ID));
  // Landscapes for this system's spobs (default 10000+Type and custom),
  // so the planet screen never shows without its picture.
  for (const p of S.spobs)
    for (const id of [10000 + p.Type, p.CustPicID].filter((v) => v >= 0)) {
      if (document.getElementById('scape' + id)) continue;
      const img = document.createElement('img');
      img.id = 'scape' + id;
      img.src = 'evassets/titles/PICT_' + id + '.png';
      img.style.display = 'none';
      img.onerror = () => img.remove();
      document.body.appendChild(img);
    }
  const n = Math.min(Math.max(S.syst.AvgShips, 2), 8);
  for (let i = 0; i < n; i++) spawnAI(false);
  // NB: the player's escorts are spawned by the *caller*, after it has placed
  // the player (arrival edge / launch pad) — see spawnEscorts(). Spawning here
  // would use the player's stale pre-arrival coordinates.
  // missions: AvailRandom rerolls per arrival; place this system's ships;
  // mark observe goals satisfied when we arrive in the right system.
  missionLog.resetForSystem(); // fresh mission offer caches per system
  for (const A of missionLog.list) {
    maybeSpawnMissionShips(A);
    if (A.shipGoal === 4 && !A.observed) {
      const sys = A.shipSyst;
      if (
        (sys >= 128 && sys === S.SYSTEM_ID) ||
        (A.travelStel && spobById(A.travelStel) && spobById(A.travelStel).System === S.SYSTEM_ID)
      ) {
        A.observed = true;
        showMsg(`${misnName(misns[A.id], A)}: target observed — return for payment.`);
      }
    }
  }
  maybeSpawnPers(); // a named character may be here with a job (after AvailRandom reset)
}
