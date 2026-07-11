/*
 * engine/shell/09-step.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- logic step (30Hz) ---------------- */

function maxWeaponRange(e) {
  let r = 0;
  for (const w of e.weapons)
    if (w.rec.Guidance !== 99)
      r = Math.max(r, w.rec.Guidance === 0 || w.rec.Guidance === 3
        ? w.rec.Speed : EV.shotSpeedOf(w.rec) * w.rec.Count);
  return r;
}

/* Red-alert when the number of ships hostile to the player rises (a new
 * grudge, a bounty hunter jumping in, a defense fleet scrambling) — but not
 * for the ambient population when a system first loads (alertGrace). */
let prevHostiles = 0, alertGrace = 0;
function checkHostileAlert() {
  const n = aiShips.filter(s => s.hostile && s.deathT < 0).length;
  if (alertGrace > 0) alertGrace--;
  else if (n > prevHostiles) playSnd(370, 0.7); // Red Alert
  prevHostiles = n;
}

function step() {
  // dialogs/splash/title pause the sim; landed pauses too — the system is
  // frozen while docked and rebuilt fresh on takeoff.
  if (gameOver || hailOpen || introUp() || landedAt) return;
  maybeSpawnBountyHunter();
  checkHostileAlert();
  if (!landedAt) {
    if (jump && player.deathT >= 0) abortJump(); // no jumping out of a fireball
    if (jump && jump.phase === 'engage') {
      const ready = EV.stepJumpEngage(player, mapBearingTo(jump.destId));
      jump.t++;
      // spec: aligned+fast AND drive spun up AND clear of stellars
      if (ready && jump.t >= EV.JUMP_WARMUP_FRAMES &&
          nearestSpobInfo().dist >= EV.JUMP_MIN_DIST)
        jump = { destId: jump.destId, phase: 'streak', t: 0 };
    } else if (jump && jump.phase === 'streak') {
      EV.thrust(player); EV.integrate(player);
      if (++jump.t >= EV.JUMP_STREAK_FRAMES) completeJump();
    } else if (player.deathT >= 0) {
      EV.integrate(player); // breaking up: drift while the death timer runs
      if (--player.deathT <= 0) {
        spawnExplosion(player.x, player.y, player.deathDelay >= 60 ? 2 : 1);
        playSnd(303);
        stopAllLoops();
        gameOver = true;
        if (strictPlay) try { localStorage.removeItem('ve_pilot'); } catch {} // permadeath \u2014 the pilot is gone
        let hasPilot = false;
        try { hasPilot = !TEST_MODE && !!localStorage.getItem('ve_pilot'); } catch {}
        document.getElementById('deadHint').textContent =
          strictPlay ? 'Strict Play: this pilot is gone for good. N: new pilot' :
          hasPilot ? 'R: return to your last landing \u00b7 N: new pilot'
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
        let diff = EV.norm(touchCtl.heading - player.heading);
        if (diff > 180) diff -= 360;
        if (diff > player.turn * 0.5) cr = true;
        else if (diff < -player.turn * 0.5) cl = true;
      }
      if (touchCtl.thrust) cThrust = true;
      EV.stepPlayer(player, {
        left: cl, right: cr,
        retro: keys['arrowdown'] || keys['s'],
        thrust: cThrust,
      });
      EV.stepShields(player, player.shieldMax, player.shieldRe);
      for (const w of player.weapons) if (w.cool > 0) w.cool--;
      if (keys[' '] || touchCtl.fire) fire(player, shipTarget, true);
      if (keys['x'] && player.selSecondary) fire(player, shipTarget, false);
      /* klaxxon on shield collapse, re-armed on recovery */
      if (player.shields <= 0 && klaxxonArmed) { playSnd(350, 0.8); klaxxonArmed = false; }
      else if (player.shields > player.shieldMax * 0.25) klaxxonArmed = true;
    }
  }

  for (const s of [...aiShips]) {
    if (s.deathT >= 0) {                       // disintegrating (fireball already going)
      EV.integrate(s);
      // secondary blasts flicker across a bigger hull as it comes apart
      if (s.deathDelay >= 30 && s.deathT % 7 === 0)
        spawnExplosion(s.x + (Math.random() - 0.5) * 24, s.y + (Math.random() - 0.5) * 24, 0);
      if (--s.deathT <= 0) {
        spawnExplosion(s.x, s.y, s.deathDelay >= 60 ? 2 : 1); // final blast
        playSnd(303, attenuate(s.x, s.y)); // the final boom
        onShipDestroyed(s);
        aiShips.splice(aiShips.indexOf(s), 1);
        if (shipTarget === s) shipTarget = null;
        if (s.fighter) {                         // a downed fighter is lost (bay ammo not restored)
          showMsg(`Your ${ships[s.shipId] ? ships[s.shipId].name : 'fighter'} was shot down.`);
          continue;
        }
        if (s.playerEscort) {                    // a lost escort is gone for good
          const i = escorts.findIndex(e => e.id === s.escId);
          const name = (i >= 0 && escorts[i].name) || s.misnName
            || (ships[s.shipId] && ships[s.shipId].name) || 'escort';
          if (i >= 0) escorts.splice(i, 1);
          showMsg(`Your escort ${name} was destroyed.`);
          continue;                              // don't spawn an ambient replacement
        }
        const epoch = systEpoch;
        setTimeout(() => { if (epoch === systEpoch) spawnAI(true); }, 4000 + Math.random() * 8000);
      }
      continue;
    }
    if (s.warpIn > 0) s.warpIn--;
    if (s.disabled) { EV.integrate(s); continue; }
    EV.stepShields(s, s.shieldMax, s.shieldRe);
    for (const w of s.weapons) if (w.cool > 0) w.cool--;
    if (s.playerEscort) {
      // Guard the player: engage the nearest ship hostile to them, otherwise
      // hold a loose formation nearby. Escorts never target the player's side.
      let tgt = null, best = Infinity;
      for (const h of aiShips) {
        if (h === s || h.playerEscort || h.deathT >= 0 || h.disabled || !h.hostile) continue;
        const d = Math.hypot(h.x - s.x, h.y - s.y);
        if (d < best) { best = d; tgt = h; }
      }
      if (tgt && !gameOver && !landedAt) {
        const r = EV.stepWarship(s, tgt.x, tgt.y);
        if (r.aligned && r.dist < maxWeaponRange(s)) fire(s, tgt, true);
      } else {
        EV.stepWarship(s, player.x, player.y); // shadow the player
      }
    } else if (s.hostile && player.deathT < 0 && !gameOver && !landedAt) {
      const r = EV.stepWarship(s, player.x, player.y);
      if (r.aligned && r.dist < maxWeaponRange(s)) fire(s, player, true);
    } else if (s.fleeing) {
      EV.stepFlee(s, player.x, player.y);
    } else {
      const alive = EV.stepTrader(s, s.target);
      // A plain trader that reaches its planet docks instantly (clean
      // disappearance at the spob — no drawn-out ghost fade).
      const docked = alive && !s.misnId && s.state === 'landing';
      if (!alive || docked) {
        if ((s.misnId != null && !s.escort) || (s.isPers && !s.offered)) {
          // A catch-goal target (board/disable/destroy), or a named character
          // still carrying an unaccepted job, mustn't slip away by landing —
          // loiter near the spob instead of despawning.
          s.target = spobs.length ? spobs[Math.floor(Math.random() * spobs.length)] : null;
          s.state = 'cruise'; s.fade = 1;
        } else {
          if (s.misnId != null && s.escort) onMissionEscortArrived(s);
          aiShips.splice(aiShips.indexOf(s), 1);
          if (shipTarget === s) shipTarget = null;
          if (s.misnId == null) {
            const epoch = systEpoch;
            setTimeout(() => { if (epoch === systEpoch) spawnAI(Math.random() < 0.5); },
              2000 + Math.random() * 6000);
          }
        }
      }
    }
  }

  /* shots */
  const everyone = player.deathT < 0 && !landedAt && !gameOver ? [player, ...aiShips] : [...aiShips];
  // The player and their escorts are one side: their fire never harms each other.
  const alliedTo = o => o === player || o.playerEscort;
  const friendly = (a, b) => alliedTo(a) && alliedTo(b);
  for (const shot of [...shots]) {
    const alive = EV.stepShot(shot, shot.homing);
    let hit = false;
    for (const v of everyone) {
      if (v === shot.owner || v.deathT >= 0 || friendly(shot.owner, v)) continue;
      if (Math.hypot(v.x - shot.x, v.y - shot.y) <
          Math.max(shot.rec.ProxRadius, shipHalf(v))) {
        hitShip(v, shot.rec, shot.heading, shot.owner);
        if (shot.rec.ExplodType >= 0) spawnExplosion(shot.x, shot.y, shot.rec.ExplodType);
        hit = true;
        break;
      }
    }
    if (hit || !alive) shots.splice(shots.indexOf(shot), 1);
  }

  /* beams: ray from owner's nose, damage first ship within 8 px */
  for (const b of [...beams]) {
    if (b.owner.deathT >= 0 || --b.life <= 0) { beams.splice(beams.indexOf(b), 1); continue; }
    b.heading = b.turreted && b.target ? EV.bearing(b.target.x - b.owner.x, b.target.y - b.owner.y)
                                       : b.owner.heading;
    const dx = Math.sin(EV.rad(b.heading)), dy = -Math.cos(EV.rad(b.heading));
    let bestT = Infinity, bestV = null;
    for (const v of everyone) {
      if (v === b.owner || v.deathT >= 0 || friendly(b.owner, v)) continue;
      const t = (v.x - b.owner.x) * dx + (v.y - b.owner.y) * dy;
      if (t < 0 || t > b.rec.Speed) continue;
      const px = b.owner.x + dx * t, py = b.owner.y + dy * t;
      if (Math.hypot(v.x - px, v.y - py) < 8 + shipHalf(v) / 2 && t < bestT) { bestT = t; bestV = v; }
    }
    b.len = bestV ? bestT : b.rec.Speed;
    if (bestV) hitShip(bestV, b.rec, b.heading, b.owner);
  }

  /* explosions */
  for (const ex of [...explosions]) {
    if (++ex.tick % 2 === 0 && ++ex.f >= ex.frames)
      explosions.splice(explosions.indexOf(ex), 1);
  }
}

