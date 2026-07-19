import {
  missionLog,
  S,
  Save,
  TEST_MODE,
  escorts,
  explored,
  ships,
  showMsg,
  spinsNeededFor,
  strictPlay,
  systs,
  tutSeen,
  tutorialActive,
} from './01-state.js';
import { preloadSprites } from './ui/sprites.js';
import { tutorial } from './ui/tutorial.js';
import { maybeSpawnBountyHunter, spawnAI, spawnAsteroids } from './02-spawning.js';
import { attenuate, playSnd, stopAllLoops } from './03-sound.js';
import {
  AFTERBURNER_FUEL,
  abortJump,
  completeJump,
  fire,
  fuel,
  hasAfterburner,
  hitShip,
  mapBearingTo,
  nearestSpobInfo,
  player,
  shipHalf,
  spawnExplosion,
  startWarpSound,
} from './04-combat.js';
import { keys, touchCtl } from './05-input.js';
import { hailOpen, onShipDestroyed } from './06-interaction.js';
import { pollLandingClearance } from './14-landing.js';
import { aiFor } from './ai-strategies.js';
import { maybeSpawnMissionShips, misnName, misns, spobById } from './08-missions.js';
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
 * owns the live entities and advances them one frame in `step()`. World now
 * physically owns the entity arrays — `ships` (the AI ships), `shots`, `beams`,
 * `explosions` and `asteroids` are its own fields (the constructor creates them,
 * loadSystem resets them, and the shell pushes/reads through `world.*`). The
 * player is a getter onto the 04-combat singleton; only `spobs` (the system's
 * stellar objects, which are system data rather than stepped entities) still
 * lives on S. `export const step` stays a thin wrapper so the run loop (17-main)
 * is unchanged.
 *
 * AI ships pick a behavior from a small strategy hierarchy (phase 3): the tick
 * calls `aiFor(ship, world).step(ship, world)` instead of an if/else-if chain on
 * the ship's flags.
 */
/* ---------------- logic step (30Hz) ---------------- */

/* The hyperspace speed ceiling at frame `t` of the spin-up (0 … WARMUP+STREAK):
 * ramps from cruise (maxSpeed) up to (1+JUMP_BOOST)×, back-loaded (p²) so the
 * ship charges slowly, then rockets away just before the cut to arrival
 * (spec: "Hyperjump"). */
function jumpCap(t, maxSpeed) {
  const total = EV.JUMP_WARMUP_FRAMES + EV.JUMP_STREAK_FRAMES;
  const p = Math.min(t / total, 1);
  return maxSpeed * (1 + EV.JUMP_BOOST * p * p);
}

/* Red-alert when the number of ships hostile to the player rises (a new
 * grudge, a bounty hunter jumping in, a defense fleet scrambling) — but not
 * for the ambient population when a system first loads (alertGrace). */
S.prevHostiles = 0;
S.alertGrace = 0;
export function checkHostileAlert(aiShips = []) {
  const n = aiShips.filter((s) => s.hostile && s.deathT < 0).length;
  if (S.alertGrace > 0) S.alertGrace--;
  else if (n > S.prevHostiles) playSnd(370, 0.7); // Red Alert
  S.prevHostiles = n;
}

/* The live flight simulation for the current system. It owns the entities and
 * the tick. */
export class World {
  constructor() {
    // World physically owns the per-system entity arrays (docs/OOP_DESIGN.md
    // phase 2); loadSystem resets them each visit and the shell pushes/reads
    // through world.*. (spobs still lives on S — a follow-up migrates it.)
    this._ships = [];
    this._shots = [];
    this._beams = [];
    this._explosions = [];
    this._asteroids = [];
  }
  get player() {
    return player;
  }
  get ships() {
    return this._ships;
  }
  set ships(v) {
    this._ships = v;
  }
  get shots() {
    return this._shots;
  }
  set shots(v) {
    this._shots = v;
  }
  get beams() {
    return this._beams;
  }
  set beams(v) {
    this._beams = v;
  }
  get explosions() {
    return this._explosions;
  }
  set explosions(v) {
    this._explosions = v;
  }
  get asteroids() {
    return this._asteroids;
  }
  set asteroids(v) {
    this._asteroids = v;
  }

  /* One 30 Hz tick: advance the player, the AI ships, then resolve combat
   * (asteroids drift, shots and beams hit, explosions animate). Each phase is
   * its own method below; this reads as the frame's outline. */
  step() {
    // dialogs/splash/title pause the sim; landed pauses too — the system is
    // frozen while docked and rebuilt fresh on takeoff; the galaxy map pauses it
    // while you plan a route.
    if (S.gameOver || hailOpen || introUp() || S.landedAt || S.mapOpen || S.missionsOpen) return;
    // Asteroids are spawned on the first live tick after a (re)load, by which point
    // the caller (jump arrival / takeoff / boot) has placed the player — so the
    // field is centred on the ship from its first drawn frame rather than the
    // pre-placement position (spec: "Asteroids").
    if (S.asteroidsPending) {
      spawnAsteroids();
      S.asteroidsPending = false;
    }
    maybeSpawnBountyHunter();
    checkHostileAlert(this.ships);

    this.stepPlayer();
    this.stepShips();

    // Combat resolution: the set that can be hit this frame — the player joins
    // only while alive and in flight — and the allied test that keeps the player
    // and their escorts from harming each other.
    const everyone =
      this.player.deathT < 0 && !S.landedAt && !S.gameOver
        ? [this.player, ...this.ships]
        : [...this.ships];
    const alliedTo = (o) => o === this.player || o.playerEscort;
    const friendly = (a, b) => alliedTo(a) && alliedTo(b);
    // Asteroids drift/spin (spec: "Asteroids"); they never touch ships, only fire.
    // Wrap around the player so the field always surrounds them in-system.
    for (const a of this.asteroids) a.step(this.player.x, this.player.y);
    this.stepShots(everyone, friendly);
    this.stepBeams(everyone, friendly);
    this.stepExplosions();
  }

  /* The player: hyperspace cues + jump engage/streak, breaking-up death, and
   * flight control + firing. (Skipped while docked — but step() has already
   * returned in that case, so the guard is just defensive.) */
  stepPlayer() {
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
        fuel.canJump() &&
        nearDist >= EV.JUMP_MIN_DIST;
      if (jumpReady && !S.jumpReady) playSnd(150, 0.5); // ding on entering jump range
      S.jumpReady = jumpReady;
      // Landing radio: clear the pilot to land once they reach the pad with a
      // request open (the "got close since initiating" case). (spec: "Landing")
      pollLandingClearance();
      // New-pilot tutorial: once you've drifted far enough that the nearest planet
      // has left the radar (~2600 px, its half-range) — the point the nav arrow
      // shows — nudge toward the map/jump. Self-guards to fire once.
      if (tutorialActive && !tutSeen.has('drift') && nearDist > 2600) tutorial('drift');
      if (S.jump && this.player.deathT >= 0) abortJump(); // no jumping out of a fireball
      if (S.jump && S.jump.phase === 'brake') {
        // Kill any momentum first (spec), then spin up the hyperdrive. The
        // no-jump-ring check is NOT repeated here: once a jump is engaged it
        // proceeds even if the ship drifts into the ring, like the original.
        if (this.player.stepJumpBrake()) {
          this.player.vx = this.player.vy = 0;
          startWarpSound();
          S.jump = { destId: S.jump.destId, phase: 'engage', t: 0 };
        }
      } else if (S.jump && S.jump.phase === 'engage') {
        const ready = this.player.stepJumpEngage(
          mapBearingTo(S.jump.destId),
          jumpCap(S.jump.t, this.player.maxSpeed),
        );
        S.jump.t++;
        // spec: aligned AND the drive has spun up. No stellar-distance check
        // here — an engaged jump proceeds even if the ship drifts into the
        // no-jump ring, like the original (the ring only gates *initiation*).
        if (ready && S.jump.t >= EV.JUMP_WARMUP_FRAMES)
          S.jump = { destId: S.jump.destId, phase: 'streak', t: 0 };
      } else if (S.jump && S.jump.phase === 'streak') {
        // Final dash: the speed ceiling is near its peak here, so the ship
        // rockets away before the cut to arrival.
        this.player.thrust(jumpCap(EV.JUMP_WARMUP_FRAMES + S.jump.t, this.player.maxSpeed));
        this.player.integrate();
        if (++S.jump.t >= EV.JUMP_STREAK_FRAMES) completeJump();
      } else if (this.player.deathT >= 0) {
        this.player.integrate(); // breaking up: drift while the death timer runs
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
        // Afterburner (Z held): a boosted forward drive, only while owned and
        // with fuel to burn — it spends AFTERBURNER_FUEL/frame (spec:
        // "Afterburner").
        const ab = keys['z'] && hasAfterburner() && fuel.value > 0;
        this.player.stepPlayer({
          left: cl,
          right: cr,
          retro: keys['arrowdown'] || keys['s'],
          thrust: cThrust,
          afterburn: ab,
        });
        if (ab) fuel.burn(AFTERBURNER_FUEL);
        this.player.regenShields(this.player.shieldMax, this.player.shieldRe);
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
  }

  /* AI ships: run each one — disintegration + despawn/replace, warp-in coast,
   * disabled drift, else regen/cooldowns and its chosen AI strategy. */
  stepShips() {
    for (const s of [...this.ships]) {
      if (s.deathT >= 0) {
        // disintegrating (fireball already going)
        s.integrate();
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
          s.integrate();
          s.warpIn--;
          continue;
        }
        s.warpIn = 0; // dropped to sub-light (or entered at rest) → hand to AI
      }
      if (s.disabled) {
        // A disabled ship is powerless: no engine flame, and it coasts down
        // instead of flying off at whatever speed it held when hit (spec:
        // "Combat"). The light per-frame damping brings a fast hulk to a slow
        // drift (also what lets you catch up and board it).
        s.thrusting = false;
        s.vx *= 0.98;
        s.vy *= 0.98;
        s.integrate();
        continue;
      }
      s.regenShields(s.shieldMax, s.shieldRe);
      for (const w of s.weapons) if (w.cool > 0) w.cool--;
      // Behavior is a strategy chosen from the ship's current disposition
      // (escort / hostile-to-player / fleeing / trader) — see the AI classes.
      aiFor(s, this).step(s, this);
    }
  }

  /* Projectiles vs ships and asteroids: each shot hits the first non-friendly
   * ship in range, or is absorbed by an asteroid in its swept path — detonating
   * (with any area-of-effect blast) at the impact point. */
  stepShots(everyone, friendly) {
    for (const shot of [...this.shots]) {
      const alive = shot.step(shot.homing);
      let hit = false;
      for (const v of everyone) {
        if (v === shot.owner || v.deathT >= 0 || friendly(shot.owner, v)) continue;
        if (EV.shotHitsShip(shot, v, shipHalf(v))) {
          this.detonateShot(shot, shot.x, shot.y, everyone, friendly, v);
          hit = true;
          break;
        }
      }
      // An asteroid in the shot's swept path absorbs it: cover works. The impact
      // (and any blast) plays where the rock stopped it (the segment entry point),
      // not at the shot's post-step position past the rock.
      if (!hit && this.asteroids.length) {
        const pt = EV.shotAsteroidImpact(shot, this.asteroids);
        if (pt) {
          this.detonateShot(shot, pt.x, pt.y, everyone, friendly, null);
          hit = true;
        }
      }
      if (hit || !alive) this.shots.splice(this.shots.indexOf(shot), 1);
    }
  }

  /* Detonate a shot at (bx,by): show its explosion and deal damage. A blast
   * weapon (BlastRadius > 0) hits every eligible ship within the radius of the
   * impact (radial impact kick, pushed away from the centre); a plain weapon
   * damages only the ship it struck (`directTarget`, along the shot heading).
   * The shooter and its allies are exempt either way (spec: "Blast"). */
  detonateShot(shot, bx, by, everyone, friendly, directTarget) {
    const rec = shot.rec;
    // A blast weapon's fireball is scaled to its radius (bigger blast → bigger
    // explosion); a plain hit (BlastRadius 0) draws at the sprite's native size.
    if (rec.ExplodType >= 0) spawnExplosion(bx, by, rec.ExplodType, rec.BlastRadius);
    if (rec.BlastRadius > 0) {
      for (const v of everyone) {
        if (v === shot.owner || v.deathT >= 0 || friendly(shot.owner, v)) continue;
        if (EV.inBlastRadius(bx, by, v, rec.BlastRadius))
          hitShip(v, rec, EV.bearing(v.x - bx, v.y - by), shot.owner);
      }
    } else if (directTarget) {
      hitShip(directTarget, rec, shot.heading, shot.owner);
    }
  }

  /* Beams: a ray from the owner's nose that damages the nearest non-friendly
   * ship, stopped short by any closer asteroid; b.len is the drawn length. */
  stepBeams(everyone, friendly) {
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
        const t = EV.beamHitDist(b.owner.x, b.owner.y, dx, dy, b.rec.Speed, v, shipHalf(v));
        if (t < bestT) {
          bestT = t;
          bestV = v;
        }
      }
      // An asteroid closer than the target ship stops the beam short (no damage).
      const astT = this.asteroids.length
        ? EV.rayHitsAsteroids(b.owner.x, b.owner.y, dx, dy, b.rec.Speed, this.asteroids)
        : Infinity;
      if (astT < bestT) bestV = null;
      b.len = bestV ? bestT : Math.min(astT, b.rec.Speed);
      if (bestV) hitShip(bestV, b.rec, b.heading, b.owner);
    }
  }

  /* Explosion animation (spec: "Explosions"): advance a frame every 2 ticks and
   * drop the explosion once it runs out. */
  stepExplosions() {
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
  world.ships = [];
  world.shots = [];
  world.beams = [];
  world.explosions = [];
  // Asteroids block weapons fire (spec: "Asteroids"). Defer the actual spawn to
  // the first live tick: the caller places the player *after* loadSystem, so
  // spawning now would centre the field on the pre-placement position.
  world.asteroids = [];
  S.asteroidsPending = true;
  S.navTarget = null;
  S.shipTarget = null;
  S.landing = null; // no landing request carries across a system change
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
