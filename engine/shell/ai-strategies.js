/*
 * engine/shell/ai-strategies.js — the AI behavior strategies, split out of
 * 09-step.js.
 *
 * One strategy per behavior an AI ship can take (escort / warship / flee /
 * trader), dispatched each frame by `aiFor(ship, world)` from the ship's current
 * disposition (docs/OOP_DESIGN.md, phase 3). Strategies are stateless — they act
 * on the ship + world passed in — so one shared instance of each is reused. The
 * flight math lives in the core as Ship methods (s.stepWarship / stepTrader /
 * stepFlee); a strategy decides which to run, picks a target, and fires. The pure
 * "who to fight" decisions live in ai-targeting.js; this module wires the live
 * world/govt tables into them and owns the shell side-effects (fire, spawn,
 * despawn). `world` is the World from 09-step (a ships/player/... view).
 *
 * esbuild bundles the shell modules (entry: main.js). Normative: ENGINE_SPEC.md.
 */
import { S } from './01-state.js';
import { isPort, spawnAI } from './02-spawning.js';
import { fire } from './04-combat.js';
import { govtAllies, govtEnemies, govts, onMissionEscortArrived } from './08-missions.js';
import { combatTarget as combatTargetOf, nearest } from './ai-targeting.js';

// Longest range at which any of a ship's weapons can hit (beams use Speed as
// range; projectiles Speed·Count). Fighter bays (Guidance 99) don't count.
function maxWeaponRange(e) {
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

class AI {
  // eslint-disable-next-line no-unused-vars
  step(s, world) {}
}

/* A player escort: guard the player, engaging the nearest ship hostile to them,
 * otherwise holding a loose formation. Escorts never target the player's side. */
class EscortAI extends AI {
  step(s, world) {
    // Guard the player: engage the nearest ship hostile to them.
    const tgt = nearest(
      s,
      world.ships,
      (h) => !h.playerEscort && h.deathT < 0 && !h.disabled && h.hostile,
    );
    if (tgt && !S.gameOver && !S.landedAt) {
      const r = s.stepWarship(tgt.x, tgt.y);
      if (r.aligned && r.dist < maxWeaponRange(s)) fire(s, tgt, true);
    } else {
      s.stepWarship(world.player.x, world.player.y); // shadow the player
    }
  }
}

/* The targeting decisions (govt hostility + who to fight) are pure logic in
 * ai-targeting.js (DOM-free, unit-tested); GOVT_REL adapts this shell's govt
 * table to the relations interface those rules expect. The govt-fn references
 * are wrapped (not passed by value) so building GOVT_REL never reads the
 * 08-missions bindings at module-eval time — safe wherever this loads in the
 * shell's import cycle. */
const ENGAGE_RANGE = 1600; // ambient warships only chase govt-enemies this close
const GOVT_REL = {
  allies: (g) => govtAllies(g),
  enemies: (g) => govtEnemies(g),
  flags: (g) => (govts[g] && govts[g].$sem ? govts[g].$sem.flags : []),
};
const foeValid = (s, world) =>
  s.foe && s.foe.deathT < 0 && !s.foe.disabled && world.ships.includes(s.foe);

/* Wrapper over the pure combatTarget: reads the live world (player targetability,
 * the ship's resolved foe) and passes plain data in. Clearing a stale foe stays
 * here (a state mutation the pure rule mustn't do). */
function combatTarget(s, world) {
  const p = world.player;
  const playerTargetable = p.deathT < 0 && !S.gameOver && !S.landedAt;
  const foe = foeValid(s, world) ? s.foe : (s.foe = null);
  const hunts = s.aiType >= 3 && s.misnId == null && !s.isPers; // ambient warship
  return combatTargetOf(s, world.ships, {
    player: playerTargetable ? p : null,
    foe,
    hunts,
    rel: GOVT_REL,
    engageRange: ENGAGE_RANGE,
  });
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
    const r = s.stepWarship(t.x, t.y);
    if (r.aligned && r.dist < maxWeaponRange(s)) fire(s, t, true);
  }
}

/* A frightened ship: turn tail and run — from the AI that shot it if it has one
 * (keep fleeing it even after it's disabled/gone, not switch to the player),
 * otherwise from the player. */
class FleeAI extends AI {
  step(s, world) {
    const from = s.foe || world.player;
    s.stepFlee(from.x, from.y);
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
    s.stepTrader(s.target);
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
export function aiFor(s, world) {
  if (s.playerEscort) return escortAI;
  if (s.fleeing) return fleeAI; // surrender / begged-off / wimpy trader running
  // Warships fight (WarshipAI picks the target: player, foe, or govt-enemy); a
  // brave trader turns warship once it's hostile to the player (grudge) or
  // something has become its foe.
  if (s.aiType >= 3 || (s.aiType === 2 && (s.hostile || foeValid(s, world)))) return warshipAI;
  return traderAI;
}
