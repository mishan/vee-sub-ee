/*
 * engine/shell/ui/tutorial.js — new-pilot onboarding hint banners.
 *
 * A few one-time tutorial banners for brand-new pilots (spec: "New-pilot
 * intro"), echoing the guidance classic EV gives a first-time captain. The
 * wording here is our own (clean-room) — same intent and keys, not the original's
 * copyrighted text. Armed only for pilots that played the intro (tutorialActive),
 * each step shows once (tutSeen, persisted), triggered from where it's relevant:
 *   welcome — entering flight by Levo (11-title finishIntro)
 *   depart  — first takeoff from the start world (14-landing takeOff)
 *   drift   — straying far enough that the nearest-planet arrow shows (ui/render)
 *
 * esbuild bundles the shell modules (entry: main.js). Normative: ENGINE_SPEC.md.
 */

import { markTutorialStep, tutorialActive, tutSeen } from '../01-state.js';
import { playSnd } from '../03-sound.js';

const MESSAGES = {
  welcome:
    'Welcome, captain. A good first move is to land on Levo — press L to target it, then L again to set down and check the local prices.',
  depart:
    'To reach another system, open the map with M, pick a neighbouring star, then press J to engage your hyperdrive.',
  drift:
    'Nothing but empty space out here. To travel on, open the map (M), choose a destination, and start your jump with J.',
};

let hideTimer = null;
/* Show a step's banner once, if the tutorial is armed and it hasn't shown yet. */
export function tutorial(step) {
  if (!tutorialActive || tutSeen.has(step) || !MESSAGES[step]) return;
  markTutorialStep(step);
  const el = document.getElementById('tutorial');
  el.textContent = MESSAGES[step];
  el.style.display = 'block';
  requestAnimationFrame(() => (el.style.opacity = '1'));
  playSnd(150, 0.5); // a little ding to draw the eye to the hint
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideTutorial, 9000);
}
export function hideTutorial() {
  const el = document.getElementById('tutorial');
  el.style.opacity = '0';
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.style.display = 'none';
  }, 500);
}
