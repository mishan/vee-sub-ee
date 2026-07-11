/*
 * engine/shell/12-main.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- main loop ---------------- */

applyShipStats(); // arm the player (stats + loadout + shield/armor maxes)
loadSystem(SYSTEM_ID);
if (SAVED && SAVED.spob != null) {
  const p = spobs.find(sp => sp.id === SAVED.spob);
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
const FF = +(params.get('ff') || 0);

let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(now - last, 250); last = now;
  const dt = 1000 / EV.FPS;
  const steps = fastForward ? 2 : 1; // Caps Lock: two sim ticks per real tick
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
