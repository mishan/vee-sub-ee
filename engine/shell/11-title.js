import { SAVED, armTutorial, markIntroSeen } from './01-state.js';
import {
  armAudioUnlock,
  playIntroAmbient,
  playIntroDrums,
  startTitleMusic,
  stopIntroMusic,
  stopTitleMusic,
} from './03-sound.js';
import { render } from './ui/render.js';
import {
  fadeSplashAway,
  hideTitleMenu,
  needPilot,
  paintSplash,
  setSplashLoading,
  showTitleMenu,
} from './ui/title.js';
import { beginGraphic, hideIntro, showIntroGraphic, skipCrawl, startCrawl } from './ui/intro.js';
import { tutorial } from './ui/tutorial.js';

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
  splashAdvancing = false,
  introShown = false;
// The splash, title menu, and new-pilot intro all pause the sim and swallow
// gameplay keys.
export const introUp = () => splashShown || titleShown || introShown;

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

/* ---------------- new-pilot intro (spec: "New-pilot intro") ----------------
 * Shown once, the first time a brand-new pilot is flown (see 17-main's boot).
 * The launch graphic (PICT 8200) holds under an ambient bed; the first gesture
 * begins it (unlocking audio), then it segues to the STR# 20000 story crawl over
 * drums; finishing (or skipping) drops into flight and arms the tutorial. Phase:
 * 'graphic' waits for the first gesture; 'playing' = holding/crawling (skippable). */
let introPhase = 'idle';
export function showIntro() {
  introShown = true;
  introPhase = 'graphic';
  showIntroGraphic();
  // A pointer gesture begins (or, once playing, skips) the intro; key presses
  // reach the same handler via 05-input, which calls introGesture on any key
  // while introShown. Kept until the intro ends (removed in finishIntro).
  addEventListener('pointerdown', introGesture, true);
}
// One handler for both gestures and keys: the first begins the intro, any after
// skips the rest.
export function introGesture() {
  if (introPhase === 'graphic') beginIntro();
  else if (introPhase === 'playing') finishIntro();
}
function beginIntro() {
  introPhase = 'playing';
  beginGraphic();
  playIntroAmbient(); // snd 30003 under the launch graphic
  setTimeout(startCrawlPhase, 4500); // hold the graphic a beat, then crawl
}
function startCrawlPhase() {
  if (!introShown) return; // skipped during the hold
  playIntroDrums(); // snd 30001 → 30002 under the crawl
  startCrawl(finishIntro);
}
export function finishIntro() {
  if (!introShown) return;
  introShown = false;
  introPhase = 'idle';
  removeEventListener('pointerdown', introGesture, true);
  skipCrawl(); // no-op if the crawl already ended; cancels it if skipping
  hideIntro();
  stopIntroMusic();
  markIntroSeen(); // persist so the intro never replays for this pilot
  render();
  // New pilots get the onboarding tutorial: arm it, then the first ("welcome")
  // banner as they enter flight by Levo.
  armTutorial();
  tutorial('welcome');
}

// Enter Ship is the one gameplay entry point, so its binding stays with the
// transition logic (mirrors the Take Off button living with 14-landing). A
// loaded pilot enters the game; otherwise nudge toward New/Open Pilot.
document.getElementById('hotEnter').onclick = () => {
  if (SAVED) enterGame();
  else needPilot();
};
