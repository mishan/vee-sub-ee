/*
 * engine/shell/05-input.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- input ---------------- */

const keys = {};
/* Double speed (like the original's Caps Lock). Driven by either Caps Lock or
 * an on-screen button (usable when Caps Lock is disabled, and on mobile). The
 * effective flag is the OR of the two so a keypress can't undo a manual
 * toggle. Caps Lock is a lock key: browsers fire keydown on engage and keyup
 * on disengage (or a keydown/keyup pair), and getModifierState is stale on the
 * event itself — so we flip on either event, debounced to one flip per press. */
let fastForward = false, capsFF = false, manualFF = false, capsLatch = -1e9;
function applyFF() {
  const on = capsFF || manualFF;
  if (on === fastForward) return;
  fastForward = on;
  const ffEl = document.getElementById('ff');       // desktop indicator (may be off-screen)
  if (ffEl) ffEl.classList.toggle('on', on);
  const bar = document.querySelector('#touchBar [data-act="ff"]');
  if (bar) bar.classList.toggle('on', on);
  showMsg(on ? 'Fast forward (2×) on' : 'Fast forward off');
}
function capsToggle() {
  // Only in flight — behind the splash/title/hail/service/landing/dead overlays
  // gameplay keys are swallowed (the splash even advances on any key), so a
  // Caps Lock press there must not silently arm 2× for when you enter the game.
  if (gameOver || hailOpen || introUp() || landedAt || activeView) return;
  const t = performance.now();
  if (t - capsLatch < 200) return; // absorb the keydown/keyup pair into one flip
  capsLatch = t; capsFF = !capsFF; applyFF();
}
function toggleFastForward() { manualFF = !manualFF; applyFF(); }
/* Keyboard-activate the desktop 2× pill (Enter/Space) without the keypress
 * also leaking through to the flight controls. */
document.getElementById('ff').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFastForward(); }
});
/* Touch control state (mobile). The joystick doesn't drive the engine
 * directly — it synthesizes the same left/right/thrust the keyboard produces
 * (see step's player branch), so the flight core is untouched.
 * touchHeading is the absolute facing the stick points at. */
const touchCtl = { steer: false, heading: 0, thrust: false, fire: false };
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (e.key === 'CapsLock') capsToggle(); // Caps Lock → toggle double speed
  // Splash/title overlays pause the sim; swallow every gameplay hotkey so the
  // game can't be driven behind them. Any key advances the loading splash.
  if (splashShown) { advanceSplash(); e.preventDefault(); return; }
  if (titleShown) { e.preventDefault(); return; }
  // The hail modal pauses the sim; swallow every hotkey but Escape so the
  // game can't be driven into odd states behind the overlay. The one
  // exception is the post-capture choice (mode 'captured'): the prize is
  // already yours, so the player must resolve it (take command / add to
  // fleet) — Escape can't dismiss it and leave the ship in limbo.
  if (hailOpen) {
    const mustChoose = hailTarget && hailTarget.kind === 'board' && hailTarget.mode === 'captured';
    if (e.key === 'Escape' && !mustChoose) closeHail();
    e.preventDefault();
    return;
  }
  keys[e.key.toLowerCase()] = true;
  if (k === 'l') tryLand();
  if (k === 'm') { mapOpen = !mapOpen; }
  if (k === 'j') { if (mapOpen) mapOpen = false; beginJump(); }
  if (k === 'n' && gameOver) { newPilot(); return; }
  if (k === 'n' && !landedAt) cyclePlanetTarget();
  if (k === 'y' && !landedAt && !hailOpen) hail();
  if (k === 'b' && !landedAt) boardTarget();
  if (k === 'i' && !landedAt) showMissionBriefing();
  if (k === 'r' && gameOver) { // restart: reload straight back into the game, not the title
    try { sessionStorage.setItem('ve_resume', '1'); } catch {}
    location.reload();
  }
  if (k === 'v') {
    soundOn = !soundOn;
    if (!soundOn) stopAllLoops();
    showMsg(soundOn ? 'Sound on.' : 'Sound off.');
  }
  if (k === '[') setVolume(-0.1);
  if (k === ']') setVolume(+0.1);
  if (k === 'k' && !landedAt) recallFighters(); // dock deployed fighters
  if (k === 'q' && !landedAt) { // cycle secondary weapon
    const secs = player.weapons.filter(w => w.rec.MiscFlags & 2);
    if (!secs.length) { showMsg('No secondary weapons fitted.'); }
    else {
      const i = secs.indexOf(player.selSecondary);
      player.selSecondary = secs[(i + 1) % secs.length];
      showMsg(`Secondary: ${player.selSecondary.rec.name ?? 'weapon ' + player.selSecondary.id}`);
    }
  }
  if (e.key === 'Tab') { e.preventDefault(); if (!landedAt) cycleShipTarget(); }
  if (e.key === 'Escape') {
    if (hailOpen) closeHail();
    else if (activeView) closeService();
    else if (mapOpen) mapOpen = false;
    else if (jump && jump.phase === 'engage') abortJump();
    else if (landedAt) takeOff();
    else if (shipTarget) { shipTarget = null; showMsg('Target cleared.'); }
    else if (navTarget) { navTarget = null; showMsg('Navigation target cleared.'); }
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; if (e.key === 'CapsLock') capsToggle(); });

/* ---------------- touch controls (mobile) ----------------
 * A floating joystick (left thumb) steers, dedicated Thrust and Fire buttons
 * (right thumb) drive and shoot, and an always-on mini bar reaches the
 * secondary actions. The joystick only sets heading — thrust is its own
 * button — so aiming never accidentally burns the engine. All of it just
 * synthesizes the same booleans the keyboard produces (see step). Shown on
 * touch devices (or forced with ?mobile=1; ?mobile=0 off), only while flying. */
const TOUCH = params.has('mobile')
  ? params.get('mobile') !== '0'
  : (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window ||
     navigator.maxTouchPoints > 0);
const touchEl = document.getElementById('touch');
const joyBase = document.getElementById('touchJoyBase');
const joyKnob = document.getElementById('touchJoyKnob');
const JOY_MAX = 60;      // px the knob travels from the origin
const JOY_DEAD = 0.18;   // fraction of radius before steering engages
let joyId = null, joyOX = 0, joyOY = 0;

function updateJoyKnob(x, y) {
  let dx = x - joyOX, dy = y - joyOY;
  const len = Math.hypot(dx, dy) || 1;
  if (len > JOY_MAX) { dx *= JOY_MAX / len; dy *= JOY_MAX / len; }
  joyKnob.style.left = (joyOX + dx) + 'px';
  joyKnob.style.top = (joyOY + dy) + 'px';
  touchCtl.steer = Math.min(len / JOY_MAX, 1) > JOY_DEAD;
  if (touchCtl.steer) touchCtl.heading = EV.bearing(dx, dy); // up (−y) = heading 0
}
function releaseJoy() {
  joyId = null; touchEl.classList.remove('on');
  touchCtl.steer = false;
}
function touchAction(act) {
  switch (act) {
    case 'target': cycleShipTarget(); break;
    case 'nav': cyclePlanetTarget(); break;
    case 'land': tryLand(); break;
    case 'board': boardTarget(); break;
    case 'hail': hail(); break;
    case 'map': mapOpen = !mapOpen; break;
    case 'jump': if (mapOpen) mapOpen = false; beginJump(); break;
    case 'missions': showMissionBriefing(); break;
    case 'ff': toggleFastForward(); break;
    case 'sound':
      soundOn = !soundOn;
      if (!soundOn) stopAllLoops();
      showMsg(soundOn ? 'Sound on.' : 'Sound off.');
      break;
  }
}
function updateOrientation() {
  document.body.classList.toggle('portrait', innerHeight > innerWidth * 1.1);
}
/* Called from render(): only show flight controls while actually flying; on
 * the galaxy map, hide joystick+fire so canvas taps can pick a destination. */
function updateTouchUI() {
  // `no-fly` gates flight-only chrome on both desktop (the 2× pill) and touch
  // (the joystick/action bar), so it is toggled before the touch-only guard.
  const flying = !splashShown && !titleShown && !landedAt && !gameOver &&
                 !hailOpen && !activeView;
  document.body.classList.toggle('no-fly', !flying);
  if (!TOUCH) return;
  touchEl.classList.toggle('map', flying && mapOpen);
  if (!flying || mapOpen) { // joystick/thrust/fire unusable → release everything
    if (joyId !== null) releaseJoy();
    if (touchCtl.fire) { touchCtl.fire = false; document.getElementById('touchFire').classList.remove('press'); }
    if (touchCtl.thrust) { touchCtl.thrust = false; document.getElementById('touchThrust').classList.remove('press'); }
  }
}

if (TOUCH) {
  document.body.classList.add('touch');
  const zone = document.getElementById('touchJoyZone');
  zone.addEventListener('pointerdown', e => {
    if (joyId !== null) return;
    joyId = e.pointerId; joyOX = e.clientX; joyOY = e.clientY;
    try { zone.setPointerCapture(joyId); } catch {}
    joyBase.style.left = joyOX + 'px'; joyBase.style.top = joyOY + 'px';
    updateJoyKnob(joyOX, joyOY);
    touchEl.classList.add('on');
    e.preventDefault();
  });
  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== joyId) return;
    updateJoyKnob(e.clientX, e.clientY); e.preventDefault();
  });
  const endJoy = e => { if (e.pointerId === joyId) releaseJoy(); };
  zone.addEventListener('pointerup', endJoy);
  zone.addEventListener('pointercancel', endJoy);

  // hold-button helper: sets a touchCtl flag while pressed
  const holdButton = (el, set) => {
    const on = v => { set(v); el.classList.toggle('press', v); };
    el.addEventListener('pointerdown', e => { on(true); e.preventDefault(); });
    el.addEventListener('pointerup', e => { on(false); e.preventDefault(); });
    el.addEventListener('pointercancel', () => on(false));
    el.addEventListener('pointerleave', () => on(false));
  };
  holdButton(document.getElementById('touchFire'), v => touchCtl.fire = v);
  holdButton(document.getElementById('touchThrust'), v => touchCtl.thrust = v);

  document.getElementById('touchBar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (b) touchAction(b.dataset.act);
  });

  addEventListener('resize', updateOrientation);
  addEventListener('orientationchange', updateOrientation);
  updateOrientation();
}

