/*
 * engine/shell/14-landing.js — landing logic (tryLand / takeOff).
 *
 * The landing SCREEN itself (the hub markup + its Dialog) lives in
 * ui/landing.js; this module keeps the flight-side logic: selecting and landing
 * on a planet, and taking off again (spec: "Landing"). Split per OOP_DESIGN.md's
 * "Separating UI from logic" (slice 5).
 * esbuild bundles the shell modules (entry: main.js). Normative: ENGINE_SPEC.md.
 */

import { S, savePilot, showMsg } from './01-state.js';
import { spawnEscorts } from './02-spawning.js';
import { loopSnd, playSnd, stopAllLoops } from './03-sound.js';
import { hasAutoRefueller, player, rebuildPlayerWeapons, refuelShip } from './04-combat.js';
import { distTo, nearestLandable } from './06-interaction.js';
import { missionLandingEvents } from './08-missions.js';
import { loadSystem } from './09-step.js';
import { activeView } from './ui/dialog.js';
import { closeService } from './ui/services.js';
import { landedDialog, setMissionNotes } from './ui/landing.js';
import { tutorial } from './ui/tutorial.js';

// The landing screen's persistent "Take Off" button self-binds here (it triggers
// takeOff, which is logic), so it needs no global-onclick bridge.
document.getElementById('takeoffBtn').addEventListener('click', () => takeOff());

/* L: select the nearest landable planet (brackets show it), or — if it's
 * already the target and we're in range and slow — land. Denials explain
 * themselves, like the original. */
export function tryLand() {
  if (S.landedAt || S.jump) return;
  const p =
    S.navTarget && (!S.navTarget.$sem || S.navTarget.$sem.canLand)
      ? S.navTarget
      : nearestLandable();
  if (!p) {
    showMsg('There is nowhere to land in this system.');
    return;
  }
  if (S.navTarget !== p) {
    S.navTarget = p;
    showMsg(`Targeting ${p.name}.`);
    playSnd(150, 0.5); // target-select beep
    return;
  }
  if (distTo(p) >= EV.LAND_DIST) {
    showMsg(`Landing on ${p.name}: too far away.`);
    return;
  }
  if (Math.hypot(player.vx, player.vy) > EV.LAND_SPEED) {
    showMsg('You are moving too fast to land.');
    return;
  }
  S.landedAt = p;
  player.vx = player.vy = 0;
  if (hasAutoRefueller()) refuelShip(); // auto-refuel (charged) only if that outfit is owned
  player.shields = player.shieldMax; // ...and repairs
  player.armor = player.armorMax;
  player.disabled = false;
  rebuildPlayerWeapons(); // rearm (simplification: ammo refills on landing)
  stopAllLoops();
  if (p.CustSndID >= 0) S.ambientSnd = loopSnd(p.CustSndID, 0.6); // planet ambient
  setMissionNotes(missionLandingEvents(p)); // cargo pickup/dropoff, completion
  savePilot(p.id); // classic: the game saves when you land (after mission events)
  landedDialog.open(); // renders the hub and shows the panel
}
export function takeOff() {
  if (!S.landedAt) return;
  if (activeView) closeService();
  const spob = S.landedAt;
  savePilot(spob.id); // captures docked purchases/trades
  stopAllLoops();
  S.landedAt = null;
  setMissionNotes([]);
  landedDialog.close();
  // Rebuild the system fresh: the ships that were here when you landed are
  // gone; loadSystem respawns the ambient population and any mission ships.
  loadSystem(S.SYSTEM_ID);
  EV.placeAtTakeoff(player, spob); // then place on the pad (loadSystem doesn't move you)
  spawnEscorts(); // launch the fleet alongside the player
  tutorial('depart'); // new-pilot hint on first departure (self-guards to once)
}
