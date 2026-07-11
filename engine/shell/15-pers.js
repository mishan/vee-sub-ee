/*
 * engine/shell/15-pers.js — part of the browser flight shell (named characters).
 *
 * Extracted from 08-missions: përs (named characters) and their ship-offered
 * missions — eligibility, LinkSyst matching, arming the përs ship, and the
 * per-visit spawn (spec: "Ship-offered missions"). esbuild bundles the shell
 * modules (entry: main.js). Normative behavior: engine/ENGINE_SPEC.md.
 */

import { S, missionBits, persDone, persGrudge, ships, systs } from './01-state.js';
import { systemGovt } from './02-spawning.js';
import { armShip, poolKey, weaps } from './04-combat.js';
import { govtAllies, govtEnemies, misns, missionAvailable, pers, playerAI } from './08-missions.js';

/* ---------- përs (named characters) & ship-offered missions ----------
 * A mïsn with AvailLoc 2 is carried by a përs ship (bible): you hail the
 * character and it offers its LinkMission. See spec "Ship-offered missions". */
export const PF = { GRUDGE: 0x0001, REPLACE: 0x0040, DEACTIVATE: 0x0100, ONBOARD: 0x0200,
             LEAVE: 0x0800, NOT_WIMPY: 0x1000, NOT_BEEFY: 0x2000, NOT_WARSHIP: 0x4000 };

/* Does a përs's LinkSyst permit `systId`? Mirrors availStelMatch's govt ranges;
 * an unrecognized encoding falls through to "allowed" so a character isn't
 * silently lost. */
export function linkSystMatches(ls, systId) {
  if (ls == null || ls === -1) return true;              // any system
  if (ls >= 128 && ls <= 1127) return ls === systId;     // a specific system
  const sy = systs[systId], pg = sy ? sy.Govt : -1;
  if (ls >= 9999  && ls <= 10127) return pg === ls - 9999;
  if (ls >= 15000 && ls <= 15127) return govtAllies(ls - 15000).includes(pg);
  if (ls >= 20000 && ls <= 20127) return pg !== ls - 20000;
  if (ls >= 25000 && ls <= 25127) return govtEnemies(ls - 25000).includes(pg);
  return true;
}

/* A representative inhabited spöb of the current system, for evaluating a
 * ship-offered mission's spöb-relative gates (AvailStel/AvailRecord). */
export function systemSpob() {
  return S.spobs.find(s => s.$sem && !s.$sem.uninhabited && s.$sem.canLand) || S.spobs[0]
    || { id: -1, Govt: systemGovt(), System: S.SYSTEM_ID, $sem: { canLand: true, uninhabited: false } };
}

/* Is a ship-offered mission currently available and not already taken? */
export function shipMissionAvailable(id) {
  const m = misns[id];
  if (!m || m.AvailLoc !== 2) return false;
  if (S.activeMissions.some(a => a.id === id)) return false;
  return missionAvailable({ ...m, id }, systemSpob(), 2);
}

/* Player's current ship class excluded by the përs's don't-offer flags? */
export function persOffersToPlayer(pr) {
  const ai = playerAI();
  if ((pr.Flags & PF.NOT_WIMPY) && ai === 1) return false;
  if ((pr.Flags & PF.NOT_BEEFY) && ai === 2) return false;
  if ((pr.Flags & PF.NOT_WARSHIP) && ai >= 3) return false;
  return true;
}

/* Would this përs offer a mission here and now? (Spawn-time gate — the
 * player-ship-class filter is applied later, at hail time.) */
export function persEligible(id) {
  const pr = pers[id];
  if (!pr || persDone.has(+id) || persGrudge.has(+id) || !ships[pr.ShipType]) return false;
  if (pr.MissionBit >= 0 && pr.MissionBit <= 511 && !missionBits[pr.MissionBit]) return false;
  if (!linkSystMatches(pr.LinkSyst, S.SYSTEM_ID)) return false;
  return pr.LinkMission >= 128 && shipMissionAvailable(pr.LinkMission);
}

/* Arm a përs ship: stock loadout, then any përs weapon override + shield mod. */
export function armShipFromPers(e, pr) {
  armShip(e, ships[pr.ShipType]);
  if ([1, 2, 3, 4].some(i => pr['WeapType' + i] >= 128)) {   // the character's own guns
    e.weapons = []; e.pools = {}; e.poolCap = {};
    for (let i = 1; i <= 4; i++) {
      const t = pr['WeapType' + i];
      if (t >= 128 && weaps[t]) {
        e.weapons.push({ id: t, rec: weaps[t], n: Math.max(pr['WeapCount' + i], 1), cool: 0 });
        const pk = poolKey(weaps[t]);
        if (pk) {
          e.pools[pk] = (e.pools[pk] || 0) + Math.max(pr['AmmoLoad' + i], 0);
          e.poolCap[pk] = (e.poolCap[pk] || 0) + Math.max(pr['AmmoLoad' + i], 0);
        }
      }
    }
  }
  if (pr.ShieldMod) {                                        // % shield tweak (bible)
    e.shieldMax = Math.max(1, Math.round(e.shieldMax * (1 + pr.ShieldMod / 100)));
    e.shields = e.shieldMax;
  }
}

/* Bring a named character into the system if one belongs here and has a job.
 * Rare and at most one per visit — përs are special encounters. Positioned
 * relative to the system centre (like spawnAI), independent of the player. */
export function maybeSpawnPers() {
  if (Math.random() > 0.35) return;
  const eligible = Object.keys(pers).map(Number).filter(persEligible);
  if (!eligible.length) return;
  const id = eligible[Math.floor(Math.random() * eligible.length)];
  const pr = pers[id];
  const a = Math.random() * Math.PI * 2, r = 600 + Math.random() * 1400;
  const e = EV.makeShip(ships[pr.ShipType], Math.cos(a) * r, Math.sin(a) * r, Math.random() * 360);
  e.shipId = pr.ShipType;
  e.govt = pr.Govt >= 128 ? pr.Govt : 0;
  e.aiType = pr.AIType >= 1 ? pr.AIType : 1;
  e.booty = 0;
  e.target = S.spobs.length ? S.spobs[Math.floor(Math.random() * S.spobs.length)] : null;
  armShipFromPers(e, pr);
  e.isPers = true; e.persId = id; e.misnName = pr.name;
  e.misnLink = pr.LinkMission; e.persFlags = pr.Flags; e.commQuote = pr.CommQuote;
  e.warpIn = 18;
  S.aiShips.push(e);
}
