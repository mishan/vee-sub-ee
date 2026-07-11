import { S, SAVED, TEST_MODE, params, showMsg } from './01-state.js';
import { spawnEscorts } from './02-spawning.js';
import { loopSnd } from './03-sound.js';
import { applyShipStats, beginJump, fuelMax, player } from './04-combat.js';
import { fastForward, keys } from './05-input.js';
import { cyclePlanetTarget, cycleShipTarget } from './06-interaction.js';
import { openService } from './07-trade.js';
import { renderPlanetScreen, tryLand } from './08-missions.js';
import { loadSystem, step } from './09-step.js';
import { render } from './10-render.js';
import { showSplash, showTitle } from './11-title.js';

/*
 * engine/shell/13-main.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- main loop ---------------- */

applyShipStats(); // arm the player (stats + loadout + shield/armor maxes)
loadSystem(S.SYSTEM_ID);
if (SAVED && SAVED.spob != null) {
  const p = S.spobs.find(sp => sp.id === SAVED.spob);
  if (p) { // resume docked where you last saved, like the original
    player.x = p.x; player.y = p.y;
    S.landedAt = p;
    S.fuel = fuelMax;
    player.shields = player.shieldMax; player.armor = player.armorMax;
    if (p.CustSndID >= 0) S.ambientSnd = loopSnd(p.CustSndID, 0.6);
    renderPlanetScreen();
    document.getElementById('landed').style.display = 'flex';
    showMsg('Pilot restored.');
  }
}
// Escorts only materialise when in flight; if we restored docked, takeOff()
// spawns them (after it places the player on the launch pad).
if (!S.landedAt) spawnEscorts();
if (params.has('fire')) keys[' '] = true; // test affordance: hold the trigger

// Test/dev affordances (URL params): ?map=1 opens the map,
// ?dest=<systId> preselects a destination, ?jump=1 engages the jump
// autopilot, ?ff=N fast-forwards N logic frames before the first render.
if (params.has('map')) S.mapOpen = true;
if (params.has('dest')) S.jumpDest = +params.get('dest');
if (params.has('jump')) beginJump();
export const FF = +(params.get('ff') || 0);

export let last = performance.now(), acc = 0;
export function frame(now) {
  acc += Math.min(now - last, 250); last = now;
  const dt = 1000 / EV.FPS;
  // Two sim ticks per real tick when fast-forward (2×) is on — but never while
  // hyperspacing: the warp spin-up/streak is timed to the Warp Up sound, so
  // running it at 2× desyncs the audio. The original disables 2× during warp;
  // the toggle state is kept, so 2× resumes on arrival (S.jump back to null).
  const steps = (fastForward && !S.jump) ? 2 : 1;
  while (acc >= dt) { for (let s = 0; s < steps; s++) step(); acc -= dt; }
  render();
  requestAnimationFrame(frame);
}
addEventListener('load', () => {
  for (let i = 0; i < FF; i++) step();
  if (params.has('land')) { tryLand(); tryLand(); } // select, then land
  for (const svc of ['exchange', 'outfitter', 'shipyard'])
    if (params.has(svc)) openService(svc);
  if (params.has('bar')) openService('bar');
  if (params.has('computer')) openService('missioncomputer');
  if (params.has('tab')) cycleShipTarget();
  if (params.has('nav')) cyclePlanetTarget();
  last = performance.now(); render(); requestAnimationFrame(frame);
  if (TEST_MODE) showMsg('Test mode (URL params) — pilot will not be saved or restored.');
  // Restarting after death (R) reloads straight into the game — skip the intro.
  let resuming = false;
  try { resuming = sessionStorage.getItem('ve_resume') === '1'; if (resuming) sessionStorage.removeItem('ve_resume'); } catch {}
  // Classic boot on a normal load: loading splash → title menu. Test flags
  // skip it; ?title/?splash force the splash, ?titlemenu jumps to the menu.
  // After creating a pilot, the reload jumps straight to the menu (skip the
  // splash) so you can Enter Ship — like the original.
  let newPilotJustMade = false;
  try { newPilotJustMade = sessionStorage.getItem('ve_newpilot') === '1'; if (newPilotJustMade) sessionStorage.removeItem('ve_newpilot'); } catch {}
  if (params.has('titlemenu') || newPilotJustMade) showTitle();
  else if (!resuming && !TEST_MODE || params.has('title') || params.has('splash')) showSplash();
});
