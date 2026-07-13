import { SAVED } from './01-state.js';
import { armAudioUnlock, startTitleMusic, stopTitleMusic } from './03-sound.js';
import { render } from './ui/render.js';
import {
  fadeSplashAway,
  hideTitleMenu,
  needPilot,
  paintSplash,
  setSplashLoading,
  showTitleMenu,
} from './ui/title.js';

/*
 * engine/shell/11-title.js — the title/intro state machine (part of the shell).
 *
 * The sim-facing side of the boot chrome: the splashShown/titleShown flags (which
 * pause the sim and swallow gameplay keys, via introUp), and the transitions the
 * boot sequence (17-main) and input driver (05-input) drive — showSplash,
 * advanceSplash, showTitle, enterGame. Each manages the flags and the title music,
 * then delegates the actual DOM to the render helpers in ui/title.js. The screens
 * themselves (splash/title markup, pilot summary, About/Open Pilot dialogs, prefs)
 * live in ui/title.js — split out per OOP_DESIGN.md's "Separating UI from logic"
 * (slice 5). Dependency is one-way: this imports ui/title, never the reverse.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- title screen (spec: "Title screen") ----------------
 * On a normal load the classic EV title menu (PICT 8000) sits over the
 * already-initialised game; the sim is paused (titleShown) until the
 * player picks Enter Ship / Open Pilot. Test-param runs skip it so
 * headless screenshots go straight to the game. ?title=1 forces it. */
export let titleShown = false,
  splashShown = false,
  splashAdvancing = false;
export const introUp = () => splashShown || titleShown; // sim paused, keys swallowed

/* Loading splash (PICT 131) → "Press any key" → music, brief hold, then the
 * title menu, echoing classic EV's boot. The first key/pointer gesture is
 * what unlocks audio (autoplay policy), so the theme starts here. */
export function showSplash() {
  splashShown = true;
  paintSplash();
  const arm = () => {
    advanceSplash();
    removeEventListener('pointerdown', arm, true);
  };
  addEventListener('pointerdown', arm, true); // keydown handled in the key listener
  armAudioUnlock(); // unlock audio on any gesture type
}
export function advanceSplash() {
  if (!splashShown || splashAdvancing) return;
  splashAdvancing = true;
  startTitleMusic(); // first gesture unlocks + starts the theme
  setSplashLoading();
  setTimeout(() => {
    // hold the splash a beat, like the original
    showTitle(); // title menu comes up beneath the splash
    fadeSplashAway(() => {
      // then fade the splash away to reveal it
      splashShown = false;
      splashAdvancing = false;
    });
  }, 1600);
}

export function showTitle() {
  titleShown = true;
  showTitleMenu();
  armAudioUnlock(); // in case we came straight to the menu (e.g. ?titlemenu=1)
}
export function enterGame() {
  if (!titleShown) return;
  titleShown = false;
  hideTitleMenu();
  stopTitleMusic();
  render();
}

// Enter Ship is the one gameplay entry point, so its binding stays with the
// transition logic (mirrors the Take Off button living with 14-landing). A
// loaded pilot enters the game; otherwise nudge toward New/Open Pilot.
document.getElementById('hotEnter').onclick = () => {
  if (SAVED) enterGame();
  else needPilot();
};
