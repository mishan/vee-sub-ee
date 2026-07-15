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
import { enforcesHere, spawnEscorts } from './02-spawning.js';
import { COMM_SND, ERROR_SND, loopSnd, playSnd, stopAllLoops } from './03-sound.js';
import { hasAutoRefueller, player, rebuildPlayerWeapons, refuelShip } from './04-combat.js';
import { distTo, nearestLandable } from './06-interaction.js';
import { missionLandingEvents } from './08-missions.js';
import { loadSystem } from './09-step.js';
import { activeView } from './ui/dialog.js';
import { closeService } from './ui/services.js';
import { landedDialog, setMissionNotes } from './ui/landing.js';
import { tutorial } from './ui/tutorial.js';
import { decideLanding, shouldClearOnApproach } from './landing-rules.js';

// The landing screen's persistent "Take Off" button self-binds here (it triggers
// takeOff, which is logic), so it needs no global-onclick bridge.
document.getElementById('takeoffBtn').addEventListener('click', () => takeOff());

/* Landing radio (spec: "Landing"). A landing request runs request → clearance →
 * touchdown, tracked on S.landing; each L press talks to the port and plays the
 * comm-channel sound so the spaceport radio matches a ship hail. */
S.landing = null; // { spob, cleared } while a landing request is active

/* A governed port refuses landing when its govt is policing you here — you're a
 * criminal in this system and that govt enforces here — reusing the same
 * enforcesHere test that makes its warships hostile on sight. Ungoverned ports
 * (Govt < 128) take anyone. */
export function landingDenied(p) {
  return p.Govt >= 128 && enforcesHere(p.Govt);
}

/* Docking (space station) vs landing (planet): the spöb `station` flag picks the
 * verb, so the port talks about "docking" at a station and "landing" on a
 * planet, like the original. */
const isStation = (p) => !!(p.$sem && p.$sem.station);
const landVerb = (p) => (isStation(p) ? 'dock' : 'land');

/* The port's own clearance / denial / welcome wording is Ambrosia's, baked into
 * the EV application (not the game data); the build lifts it from the user's app
 * copy into `DATA.portComm` (evexport `extractPortComm`, gitignored artifact —
 * see spec "Landing"). The clean-room engine keeps only the neutral fallbacks
 * below, used when the app wasn't supplied (e.g. the browser loader). The
 * "begin approach" line has no EV counterpart — the original clears you and
 * autopilots in — so it's always ours. */
const PC = () => (typeof DATA !== 'undefined' && DATA.portComm) || {};
const clearedText = (p) =>
  (isStation(p) ? PC().dockCleared : PC().landCleared) ||
  (isStation(p) ? 'Docking clearance granted.' : 'Landing clearance granted.');
const deniedText = (p) =>
  (isStation(p) ? PC().dockDenied : PC().landDenied) ||
  (isStation(p) ? 'Docking request refused.' : 'Landing request refused.');
const approachText = (p) =>
  `${isStation(p) ? 'Docking' : 'Landing'} request received. Begin your approach.`;

/* A reply spoken by the port (request / clearance / denial / welcome): message
 * box + the comm-reply beep, so it sounds like a ship hail. */
function portSay(text) {
  showMsg(text);
  playSnd(COMM_SND, 0.5);
}
/* A local refusal — the action can't happen yet (too far, too fast): the error
 * beep + a plain message, no radio. */
function portError(text) {
  showMsg(text);
  playSnd(ERROR_SND, 0.5);
}

/* Per-frame (called from stepPlayer while flying): once a landing request is
 * active and you cross into the landing radius, the port clears you
 * automatically — "Cleared to land." announced once. Also drops a stale request
 * if the nav target has moved off the requested planet. */
export function pollLandingClearance() {
  const L = S.landing;
  if (!L) return;
  if (S.navTarget !== L.spob) {
    S.landing = null; // nav target moved off the requested planet → drop it
    return;
  }
  if (
    shouldClearOnApproach({
      hasRequest: true,
      sameTarget: true,
      cleared: L.cleared,
      denied: landingDenied(L.spob),
      inRange: distTo(L.spob) < EV.LAND_DIST,
    })
  ) {
    L.cleared = true;
    portSay(clearedText(L.spob));
  }
}

/* L: request landing on the current nav target when it's landable, otherwise the
 * nearest landable planet; then — once the request is active and you're cleared,
 * in range and slow — touch down. The port explains every refusal, like the
 * original. */
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
  S.navTarget = p;

  const active = !!S.landing && S.landing.spob === p;
  const { action, cleared } = decideLanding({
    active,
    denied: landingDenied(p),
    inRange: distTo(p) < EV.LAND_DIST,
    tooFast: Math.hypot(player.vx, player.vy) > EV.LAND_SPEED,
    cleared: active && S.landing.cleared,
  });
  switch (action) {
    case 'deny':
      S.landing = null;
      portSay(deniedText(p));
      return;
    case 'request':
      // Open the channel: cleared straight away if already in range, otherwise
      // put the pilot on approach. The initiating press never touches down.
      S.landing = { spob: p, cleared };
      portSay(cleared ? clearedText(p) : approachText(p));
      return;
    case 'tooFar':
      // "engaged but not yet able to land" → the error beep, like the original.
      portError(`Too far away to ${landVerb(p)}.`);
      return;
    case 'tooFast':
      portError(`You are moving too fast to ${landVerb(p)}.`);
      return;
    case 'clear':
      // Reached the pad and slowed, but the clearance poll hasn't announced yet
      // (same-frame press): clear now, so touchdown always follows clearance.
      S.landing.cleared = true;
      portSay(clearedText(p));
      return;
    case 'land':
      doLand(p);
      return;
  }
}

/* Actually put the ship down: repair, rearm, save, and open the landing hub. */
function doLand(p) {
  S.landedAt = p;
  S.landing = null;
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
  S.landing = null;
  setMissionNotes([]);
  landedDialog.close();
  // Rebuild the system fresh: the ships that were here when you landed are
  // gone; loadSystem respawns the ambient population and any mission ships.
  loadSystem(S.SYSTEM_ID);
  player.placeAtTakeoff(spob); // then place on the pad (loadSystem doesn't move you)
  spawnEscorts(); // launch the fleet alongside the player
  tutorial('depart'); // new-pilot hint on first departure (self-guards to once)
}
