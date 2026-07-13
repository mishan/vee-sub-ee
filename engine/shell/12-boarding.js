/*
 * engine/shell/12-boarding.js — part of the browser flight shell (boarding).
 *
 * Extracted from 08-missions: boarding a disabled ship and the capture / loot /
 * seize outcomes (spec: "Boarding"). esbuild bundles the shell modules (entry:
 * main.js). Normative behavior: engine/ENGINE_SPEC.md.
 */

import {
  missionLog,
  wallet,
  COMMODITIES,
  S,
  hold,
  escorts,
  outfits,
  shipName,
  ships,
  showMsg,
  spinOfShip,
} from './01-state.js';
import { preloadSprites } from './ui/sprites.js';
import { MAX_ESCORTS, addEscort } from './02-spawning.js';
import { playSnd } from './03-sound.js';
import {
  applyShipStats,
  beginDestruction,
  commitCrime,
  fuel,
  holds,
  penaltyOf,
  player,
} from './04-combat.js';
import { checkDefenseCleared, hailClick, hailOpen, openHail } from './06-interaction.js';
import { renderHail } from './ui/hail.js';
import { cargoNames, cargoUsed, missionCargoUsed } from './07-trade.js';
import { misnName, misns } from './08-missions.js';

/* Board the nearest disabled ship (spec: "Boarding"). B key. Mission
 * board/rescue targets count toward the goal; any other disabled ship is
 * plundered for cargo (a crime against its government). */
export function boardTarget() {
  if (S.landedAt || S.gameOver || hailOpen) return;
  let best = null,
    bd = 50;
  for (const s of S.aiShips) {
    if (!s.disabled || s.deathT >= 0 || s.looted) continue; // looted ships are done
    const d = Math.hypot(s.x - player.x, s.y - player.y);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (!best) {
    showMsg('No disabled ship in boarding range.');
    return;
  }
  // Boarding needs a low speed RELATIVE to the target: a disabled ship keeps its
  // drift, so match its velocity (not come to a dead stop) to dock.
  if (Math.hypot(player.vx - best.vx, player.vy - best.vy) > EV.LAND_SPEED * 2) {
    showMsg("Match the disabled ship's speed to board.");
    return;
  }
  const A = best.misnGoal === 2 || best.misnGoal === 5 ? missionLog.find(best.misnId) : null;
  playSnd(390, 0.7); // Airlock — the boarding sound
  if (A) {
    // mission boarding: complete the objective, no plunder dialog
    S.aiShips.splice(S.aiShips.indexOf(best), 1);
    if (best === S.shipTarget) S.shipTarget = null;
    checkDefenseCleared(best.defOf, best);
    A.shipsLeft--;
    showMsg(
      A.shipsLeft > 0
        ? `${misnName(misns[A.id], A)}: boarded (${A.shipsLeft} to go).`
        : `${misnName(misns[A.id], A)}: objective complete — return for payment.`,
    );
    return;
  }
  openHail('board', best); // non-mission: the boarding dialog (loot / capture)
}

/* ---- boarding a disabled ship (spec: "Boarding") ----
 * Effective crew for capture odds: the ship's own crew plus any Marines
 * outfit (oütf ModType 25 adds ModVal to the crew complement, per bible). */
export function playerCrew() {
  let c = ships[S.playerShipId].Crew || 1;
  for (const [oid, n] of outfits.entries()) {
    const o = DATA.types.outf[oid];
    if (o && o.$sem && o.$sem.modType === 'marines') c += (o.ModVal || 0) * (n || 0);
  }
  return c;
}
export const captureOdds = (s) => {
  const my = playerCrew(),
    th = ships[s.shipId].Crew || 1;
  return my / (my + th);
};

export function lootVessel() {
  hailClick();
  const s = S.hailTarget.obj,
    booty = s.booty || 0,
    rec = ships[s.shipId];
  const got = [];
  if (booty & 0x40) {
    // Money — a slice of the hull's purchase price (bible)
    const money = Math.max(200, Math.round((rec.Cost || 0) * (0.03 + Math.random() * 0.07)));
    wallet.earn(money);
    got.push(`${money.toLocaleString('en-US')} cr`);
  }
  let free = holds - cargoUsed(); // commodity flags 0x01..0x20 → the six goods
  let noRoom = false;
  for (let i = 0; i < 6; i++)
    if (booty & (1 << i)) {
      if (free <= 0) {
        noRoom = true;
        continue;
      } // goods aboard, but no hold space
      const take = Math.min(1 + Math.floor(Math.random() * 4), free);
      hold.adjust(COMMODITIES[i], take);
      free -= take;
      got.push(`${take}t ${cargoNames[i]}`);
    }
  s.looted = true; // stays disabled but no longer boardable
  commitCrime(s.govt, penaltyOf(s.govt, 'BoardPenalty'));
  checkDefenseCleared(s.defOf, s);
  S.hailTarget.mode = 'result';
  S.hailTarget.said = got.length
    ? `You strip the hold — ${got.join(', ')}.`
    : noRoom
      ? 'Cargo aboard, but your hold is full — nothing you can carry.'
      : 'The hold is bare.';
  renderHail();
}

export function captureVessel() {
  hailClick();
  const s = S.hailTarget.obj;
  commitCrime(s.govt, penaltyOf(s.govt, 'BoardPenalty'));
  if (Math.random() < captureOdds(s)) {
    // Seized. Offer the classic choice — fly the prize yourself, or fold it
    // into your fleet — resolved by the player's pick below. The ship stays
    // put (the sim is paused while the boarding dialog is up).
    S.hailTarget.mode = 'captured';
    S.hailTarget.said = `Your boarding party seizes the ${ships[s.shipId].name}!`;
    playSnd(150, 0.5);
  } else {
    S.hailTarget.mode = 'result';
    S.hailTarget.said = 'The crew repel your party and scuttle the ship!';
    beginDestruction(s); // failed capture → self-destruct
    checkDefenseCleared(s.defOf, s);
  }
  renderHail();
}

/* Capture outcome 1: transfer to the prize; your old command stays with you
 * as an escort (per the original — you don't abandon the ship, it joins you). */
export function takeCapturedShip() {
  hailClick();
  const s = S.hailTarget.obj;
  const defOf = s.defOf; // read before takeCommand removes s
  const oldShip = S.playerShipId,
    oldName = shipName;
  takeCommand(s); // switch to the captured hull
  const room = escorts.length < MAX_ESCORTS; // is there a slot for the old ship?
  if (room) addEscort(oldShip, oldName); // former command falls in as escort
  checkDefenseCleared(defOf, s);
  S.hailTarget.mode = 'result';
  S.hailTarget.said = room
    ? `You transfer to the ${ships[S.playerShipId].name}. Your old ship falls in as an escort.`
    : `You transfer to the ${ships[S.playerShipId].name}. Your fleet is full, so your old ship is left behind.`;
  renderHail();
}

/* Capture outcome 2: keep your ship; the prize joins your fleet as an escort. */
export function escortCapturedShip() {
  hailClick();
  const s = S.hailTarget.obj;
  if (escorts.length >= MAX_ESCORTS) {
    // hard cap — keep the choice open
    showMsg('Your fleet is already full — take command instead, or leave it.');
    return;
  }
  const i = S.aiShips.indexOf(s);
  if (i >= 0) S.aiShips.splice(i, 1);
  if (S.shipTarget === s) S.shipTarget = null;
  const name = s.misnName || ships[s.shipId].name; // keep any custom display name
  addEscort(s.shipId, name);
  checkDefenseCleared(s.defOf, s);
  S.hailTarget.mode = 'result';
  S.hailTarget.said = `The ${name} joins your fleet as an escort.`;
  renderHail();
}

/* Take command of a captured hull: you abandon your old ship (and its outfits,
 * per classic) and fly the prize away, freshly repaired and fuelled. */
export function takeCommand(s) {
  const i = S.aiShips.indexOf(s);
  if (i >= 0) S.aiShips.splice(i, 1);
  if (S.shipTarget === s) S.shipTarget = null;
  S.playerShipId = s.shipId;
  player.shipId = S.playerShipId;
  preloadSprites([spinOfShip(S.playerShipId)]); // ensure the new hull's sprite is ready
  player.x = s.x;
  player.y = s.y;
  player.heading = s.heading;
  player.vx = 0;
  player.vy = 0;
  player.deathT = -1;
  player.disabled = false;
  outfits.clear(); // old ship & upgrades left behind
  applyShipStats(); // arm the stock captured hull
  fuel.refill();
  player.shields = player.shieldMax;
  player.armor = player.armorMax;
  hold.clampTo(holds - missionCargoUsed()); // dump cargo that won't fit the new hull
}
