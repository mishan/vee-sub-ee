import { S, TEST_MODE, params, showMsg } from './01-state.js';
import { player, warpSnd } from './04-combat.js';
import { introUp } from './11-title.js';

/*
 * engine/shell/03-sound.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---- audio (spec: "Audio") ----
 * Plain Audio elements (file:// safe). Browsers block playback until the
 * first user gesture; failed play()s are swallowed until then. */
S.soundOn = !params.has('mute');
/* master volume, 0..1 in 10% steps ([ and ] keys), persisted */
export let masterVol = (() => {
  try {
    const v = parseFloat(localStorage.getItem('ve_volume'));
    return isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
  } catch {
    return 1;
  }
})();
export function setVolume(delta) {
  masterVol = Math.max(0, Math.min(1, Math.round((masterVol + delta) * 10) / 10));
  try {
    localStorage.setItem('ve_volume', String(masterVol));
  } catch {}
  // adjust every currently-playing long sound live
  for (const a of [S.ambientSnd, warpSnd])
    if (a) a.volume = Math.min((a._baseVol ?? 1) * masterVol, 1);
  if (titleGain) titleGain.gain.value = titleVol();
  if (titleAudioEl) titleAudioEl.volume = titleVol();
  for (const a of introMusicEls) a.volume = titleVol();
  showMsg(`Volume ${Math.round(masterVol * 100)}%`);
  playSnd(150, 0.6); // audible reference beep at the new level
}
/* Comm beeps (snd names are just "Beep1..5"; roles confirmed by Misha):
 *   COMM_SND  151 — comm / landing reply (the port or a hailed ship speaking)
 *   ERROR_SND 153 — action refused (too far / too fast to land, etc.)
 *   HAIL_SND  154 — hailing frequencies opening
 * The spaceport landing radio uses the same COMM_SND as a ship's comm reply, so
 * the two radios sound identical (spec: "Landing", "Audio"). */
export const COMM_SND = 151;
export const ERROR_SND = 153;
export const HAIL_SND = 154;

export const sndCache = new Map();
export function sndEl(id) {
  let a = sndCache.get(id);
  if (!a) {
    a = new Audio('evassets/sounds/snd_' + id + '.wav');
    sndCache.set(id, a);
  }
  return a;
}
export function playSnd(id, vol = 1) {
  if (!S.soundOn || vol * masterVol <= 0.02) return;
  const a = sndEl(id).cloneNode();
  a.volume = Math.min(vol * masterVol, 1);
  a.play().catch(() => {});
}
export function loopSnd(id, vol = 1) {
  if (!S.soundOn || masterVol <= 0) return null;
  const a = sndEl(id).cloneNode();
  a._baseVol = vol;
  a.volume = Math.min(vol * masterVol, 1);
  a.loop = true;
  a.play().catch(() => {});
  return a;
}
export const stopSnd = (a) => {
  if (a) {
    a.pause();
    a.currentTime = 0;
  }
};

/* Title theme (snd 30000). Prefer Web Audio — resuming the AudioContext inside
 * a gesture is the reliable mobile unlock, and a pre-decoded buffer plays
 * instantly on the first splash tap. But some desktop browsers' decodeAudioData
 * rejects the classic 8-bit PCM WAV; when decode fails (or Web Audio is absent)
 * fall back to an HTMLAudio element, which every browser plays. Either path is
 * driven by the same gesture unlock (armAudioUnlock). Effects stay on HTMLAudio. */
export let audioCtx = null,
  titleBuffer = null,
  titleSource = null,
  titleGain = null;
export let titleAudioEl = null,
  musicWanted = false;
export function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC(); // starts suspended until a gesture
  }
  return audioCtx;
}
export const titleVol = () => Math.min(0.7 * masterVol, 1);
export const musicPlaying = () => !!titleSource || (titleAudioEl && !titleAudioEl.paused);
export function useHtmlAudioFallback() {
  audioCtx = null;
  titleBuffer = null; // give up on Web Audio for the theme
  titleAudioEl = new Audio('evassets/music/snd_30000.wav');
  titleAudioEl.loop = true;
  if (musicWanted) startTitleMusic();
}
// Prepare the theme up front (skipped in test mode; the intro is bypassed).
if (!TEST_MODE) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    fetch('evassets/music/snd_30000.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => ensureAudioCtx().decodeAudioData(buf))
      .then((b) => {
        titleBuffer = b;
        if (musicWanted) startTitleMusic();
      })
      .catch(useHtmlAudioFallback); // e.g. 8-bit WAV desktop decode fails
  } else {
    useHtmlAudioFallback();
  }
}
export function startTitleMusic() {
  if (!S.soundOn || masterVol <= 0 || !introUp()) return;
  musicWanted = true;
  if (titleBuffer && audioCtx) {
    // Web Audio path
    if (audioCtx.state === 'suspended') audioCtx.resume(); // unlock inside the gesture
    if (titleSource) return; // already playing
    titleGain = audioCtx.createGain();
    titleGain.gain.value = titleVol();
    titleGain.connect(audioCtx.destination);
    titleSource = audioCtx.createBufferSource();
    titleSource.buffer = titleBuffer;
    titleSource.loop = true;
    titleSource.connect(titleGain);
    titleSource.start();
  } else if (titleAudioEl) {
    // HTMLAudio fallback
    titleAudioEl.volume = titleVol();
    titleAudioEl.play().catch(() => {});
  }
  // neither ready yet → the decode/fallback handler will call us again
}
export function stopTitleMusic() {
  musicWanted = false;
  if (titleSource) {
    try {
      titleSource.stop();
    } catch {}
    try {
      titleSource.disconnect();
    } catch {}
    titleSource = null;
  }
  if (titleGain) {
    try {
      titleGain.disconnect();
    } catch {}
    titleGain = null;
  }
  if (titleAudioEl) {
    titleAudioEl.pause();
    titleAudioEl.currentTime = 0;
  }
}

/* ---- new-pilot intro music (spec: "New-pilot intro") ----
 * The intro has two cues, distinct from the title theme (snd 30000): an ambient
 * bed (snd 30003 "Transition") under the launch graphic, then drums under the
 * story crawl — snd 30001 "Drum Intro" once, seguing into a snd 30002 "Drum Loop".
 * Plain HTMLAudio (the 8-bit WAVs can trip desktop Web Audio decode); they start
 * from the intro's first gesture, so autoplay is already unlocked. */
export let introMusicEls = [];
function introTrack(id, loop) {
  const a = new Audio('evassets/music/snd_' + id + '.wav');
  a.loop = !!loop;
  a.volume = titleVol();
  return a;
}
export function playIntroAmbient() {
  stopIntroMusic();
  if (!S.soundOn || masterVol <= 0) return;
  const a = introTrack(30003, true);
  a.play().catch(() => {});
  introMusicEls = [a];
}
export function playIntroDrums() {
  stopIntroMusic();
  if (!S.soundOn || masterVol <= 0) return;
  const intro = introTrack(30001, false),
    loop = introTrack(30002, true);
  // segue: when the one-shot drum intro ends, roll into the looping bed — but
  // only if it hasn't been stopped (skip/finish) in the meantime.
  intro.addEventListener('ended', () => {
    if (introMusicEls.includes(loop)) loop.play().catch(() => {});
  });
  intro.play().catch(() => {});
  introMusicEls = [intro, loop];
}
export function stopIntroMusic() {
  for (const a of introMusicEls) {
    try {
      a.pause();
      a.currentTime = 0;
    } catch {}
  }
  introMusicEls = [];
}
/* Some mobile browsers only honour AudioContext.resume() from certain gesture
 * types (a pointerup/touchend/click — not the pointerdown the splash advances
 * on), which is why the theme used to wait for the first menu-button click.
 * Arm the unlock on every gesture type until the context is actually running. */
export let audioUnlockArmed = false;
export function armAudioUnlock() {
  if (audioUnlockArmed) return;
  audioUnlockArmed = true;
  const evs = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
  const tryUnlock = () => {
    startTitleMusic(); // resumes the ctx / plays the theme
    // stop listening once the theme is playing, or once we've left the intro
    if (musicPlaying() || !introUp()) {
      for (const e of evs) removeEventListener(e, tryUnlock, true);
      audioUnlockArmed = false;
    }
  };
  for (const e of evs) addEventListener(e, tryUnlock, true);
}
export const attenuate = (x, y) => Math.max(0, 1 - Math.hypot(x - player.x, y - player.y) / 1200);
S.ambientSnd = null;
S.klaxxonArmed = true;
export function stopAllLoops() {
  stopSnd(S.ambientSnd);
  S.ambientSnd = null;
}
