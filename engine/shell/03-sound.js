/*
 * engine/shell/03-sound.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---- audio (spec: "Audio") ----
 * Plain Audio elements (file:// safe). Browsers block playback until the
 * first user gesture; failed play()s are swallowed until then. */
S.soundOn = !params.has('mute');
/* master volume, 0..1 in 10% steps ([ and ] keys), persisted */
let masterVol = (() => {
  try { const v = parseFloat(localStorage.getItem('ve_volume')); return isNaN(v) ? 1 : Math.max(0, Math.min(1, v)); }
  catch { return 1; }
})();
function setVolume(delta) {
  masterVol = Math.max(0, Math.min(1, Math.round((masterVol + delta) * 10) / 10));
  try { localStorage.setItem('ve_volume', String(masterVol)); } catch {}
  // adjust every currently-playing long sound live
  for (const a of [S.ambientSnd, warpSnd])
    if (a) a.volume = Math.min((a._baseVol ?? 1) * masterVol, 1);
  if (titleGain) titleGain.gain.value = titleVol();
  if (titleAudioEl) titleAudioEl.volume = titleVol();
  showMsg(`Volume ${Math.round(masterVol * 100)}%`);
  playSnd(150, 0.6); // audible reference beep at the new level
}
const sndCache = new Map();
function sndEl(id) {
  let a = sndCache.get(id);
  if (!a) { a = new Audio('evassets/sounds/snd_' + id + '.wav'); sndCache.set(id, a); }
  return a;
}
function playSnd(id, vol = 1) {
  if (!S.soundOn || vol * masterVol <= 0.02) return;
  const a = sndEl(id).cloneNode();
  a.volume = Math.min(vol * masterVol, 1);
  a.play().catch(() => {});
}
function loopSnd(id, vol = 1) {
  if (!S.soundOn || masterVol <= 0) return null;
  const a = sndEl(id).cloneNode();
  a._baseVol = vol;
  a.volume = Math.min(vol * masterVol, 1);
  a.loop = true;
  a.play().catch(() => {});
  return a;
}
const stopSnd = a => { if (a) { a.pause(); a.currentTime = 0; } };

/* Title theme (snd 30000). Prefer Web Audio — resuming the AudioContext inside
 * a gesture is the reliable mobile unlock, and a pre-decoded buffer plays
 * instantly on the first splash tap. But some desktop browsers' decodeAudioData
 * rejects the classic 8-bit PCM WAV; when decode fails (or Web Audio is absent)
 * fall back to an HTMLAudio element, which every browser plays. Either path is
 * driven by the same gesture unlock (armAudioUnlock). Effects stay on HTMLAudio. */
let audioCtx = null, titleBuffer = null, titleSource = null, titleGain = null;
let titleAudioEl = null, musicWanted = false;
function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();               // starts suspended until a gesture
  }
  return audioCtx;
}
const titleVol = () => Math.min(0.7 * masterVol, 1);
const musicPlaying = () => !!titleSource || (titleAudioEl && !titleAudioEl.paused);
function useHtmlAudioFallback() {
  audioCtx = null; titleBuffer = null;         // give up on Web Audio for the theme
  titleAudioEl = new Audio('evassets/music/snd_30000.wav');
  titleAudioEl.loop = true;
  if (musicWanted) startTitleMusic();
}
// Prepare the theme up front (skipped in test mode; the intro is bypassed).
if (!TEST_MODE) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    fetch('evassets/music/snd_30000.wav')
      .then(r => r.arrayBuffer())
      .then(buf => ensureAudioCtx().decodeAudioData(buf))
      .then(b => { titleBuffer = b; if (musicWanted) startTitleMusic(); })
      .catch(useHtmlAudioFallback);            // e.g. 8-bit WAV desktop decode fails
  } else {
    useHtmlAudioFallback();
  }
}
function startTitleMusic() {
  if (!S.soundOn || masterVol <= 0 || !introUp()) return;
  musicWanted = true;
  if (titleBuffer && audioCtx) {                // Web Audio path
    if (audioCtx.state === 'suspended') audioCtx.resume(); // unlock inside the gesture
    if (titleSource) return;                    // already playing
    titleGain = audioCtx.createGain();
    titleGain.gain.value = titleVol();
    titleGain.connect(audioCtx.destination);
    titleSource = audioCtx.createBufferSource();
    titleSource.buffer = titleBuffer;
    titleSource.loop = true;
    titleSource.connect(titleGain);
    titleSource.start();
  } else if (titleAudioEl) {                     // HTMLAudio fallback
    titleAudioEl.volume = titleVol();
    titleAudioEl.play().catch(() => {});
  }
  // neither ready yet → the decode/fallback handler will call us again
}
function stopTitleMusic() {
  musicWanted = false;
  if (titleSource) { try { titleSource.stop(); } catch {} try { titleSource.disconnect(); } catch {} titleSource = null; }
  if (titleGain) { try { titleGain.disconnect(); } catch {} titleGain = null; }
  if (titleAudioEl) { titleAudioEl.pause(); titleAudioEl.currentTime = 0; }
}
/* Some mobile browsers only honour AudioContext.resume() from certain gesture
 * types (a pointerup/touchend/click — not the pointerdown the splash advances
 * on), which is why the theme used to wait for the first menu-button click.
 * Arm the unlock on every gesture type until the context is actually running. */
let audioUnlockArmed = false;
function armAudioUnlock() {
  if (audioUnlockArmed) return;
  audioUnlockArmed = true;
  const evs = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
  const tryUnlock = () => {
    startTitleMusic();                        // resumes the ctx / plays the theme
    // stop listening once the theme is playing, or once we've left the intro
    if (musicPlaying() || !introUp()) {
      for (const e of evs) removeEventListener(e, tryUnlock, true);
      audioUnlockArmed = false;
    }
  };
  for (const e of evs) addEventListener(e, tryUnlock, true);
}
const attenuate = (x, y) => Math.max(0, 1 - Math.hypot(x - player.x, y - player.y) / 1200);
S.ambientSnd = null; S.klaxxonArmed = true;
function stopAllLoops() {
  stopSnd(S.ambientSnd); S.ambientSnd = null;
}

