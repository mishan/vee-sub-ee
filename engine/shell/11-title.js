/*
 * engine/shell/11-title.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- title screen (spec: "Title screen") ----------------
 * On a normal load the classic EV title menu (PICT 8000) sits over the
 * already-initialised game; the sim is paused (titleShown) until the
 * player picks Enter Ship / Open Pilot. Test-param runs skip it so
 * headless screenshots go straight to the game. ?title=1 forces it. */
let titleShown = false, splashShown = false, splashAdvancing = false;
const titleEl = document.getElementById('title');
const splashEl = document.getElementById('splash');
const introUp = () => splashShown || titleShown; // sim paused, keys swallowed

/* Loading splash (PICT 131) → "Press any key" → music, brief hold, then the
 * title menu, echoing classic EV's boot. The first key/pointer gesture is
 * what unlocks audio (autoplay policy), so the theme starts here. */
function showSplash() {
  splashShown = true;
  splashEl.style.display = 'flex';
  document.getElementById('splashPrompt').textContent = 'Press any key to continue';
  const arm = () => { advanceSplash(); removeEventListener('pointerdown', arm, true); };
  addEventListener('pointerdown', arm, true); // keydown handled in the key listener
  armAudioUnlock();                           // unlock audio on any gesture type
}
function advanceSplash() {
  if (!splashShown || splashAdvancing) return;
  splashAdvancing = true;
  startTitleMusic(); // first gesture unlocks + starts the theme
  document.getElementById('splashPrompt').textContent = 'Loading…';
  setTimeout(() => {           // hold the splash a beat, like the original
    showTitle();               // title menu comes up beneath the splash
    splashEl.classList.add('fade');
    setTimeout(() => {         // then fade the splash away to reveal it
      splashEl.style.display = 'none';
      splashEl.classList.remove('fade');
      splashShown = false; splashAdvancing = false;
    }, 700);
  }, 1600);
}

function showTitle() {
  titleShown = true;
  titleEl.style.display = 'flex';
  titleEl.classList.add('intro'); // one-shot fade/scale-in, cleared after
  setTimeout(() => titleEl.classList.remove('intro'), 1100);
  // Open Pilot only means something when there's a save to resume.
  document.getElementById('hotOpen').style.opacity = SAVED ? '' : '0.35';
  // draw the pilot summary once layout settles, and keep it sized on resize
  requestAnimationFrame(renderTitleSummary);
  setTimeout(renderTitleSummary, 200); // fonts/bg may lag a frame
  titleSummaryResize = () => renderTitleSummary();
  addEventListener('resize', titleSummaryResize);
  armAudioUnlock(); // in case we came straight to the menu (e.g. ?titlemenu=1)
}
function enterGame() {
  if (!titleShown) return;
  titleShown = false;
  titleEl.style.display = 'none';
  stopTitleMusic();
  if (titleSummaryResize) { removeEventListener('resize', titleSummaryResize); titleSummaryResize = null; }
  render();
}
function titleAbout() {
  startTitleMusic();
  // STR# 20000 is the intro crawl; show it as flavour + a clean-room note.
  const intro = (DATA.strings[20000] && DATA.strings[20000].list || [])
    .join(' ').replace(/\s+/g, ' ').trim();
  document.getElementById('aboutCard').innerHTML = html`
    <h2>Vₑ — Escape Velocity, recreated</h2>
    <p>${intro}</p>
    <p style="color:#6f7c94;margin-top:12px">A clean-room reimplementation of
    Ambrosia Software’s Escape Velocity. Engine by Misha Nasledov.
    Game data is the original publisher’s and is not distributed.</p>
    <button onclick="document.getElementById('about').style.display='none'">Close</button>`;
  document.getElementById('about').style.display = 'flex';
}
function titlePrefs() {
  S.soundOn = !S.soundOn;
  if (!S.soundOn) stopTitleMusic(); else startTitleMusic();
  showMsg('Sound ' + (S.soundOn ? 'on' : 'off'));
}

/* The title viewscreen shows a summary of the current pilot's game (as the
 * original does), drawn on the canvas so it scales with the framed art. */
function gameDate() {
  // Classic EV starts the calendar at the pilot's creation date + 250 years and
  // advances it one day per hyperspace jump (gameDay). Anchored to the stored
  // creation epoch so the date is stable across sessions.
  const base = new Date(pilotBorn);
  const d = new Date(base.getFullYear() + 250, base.getMonth(), base.getDate());
  d.setDate(d.getDate() + S.gameDay);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const day = d.getDate();
  const suf = (day % 10 === 1 && day !== 11) ? 'st' : (day % 10 === 2 && day !== 12) ? 'nd'
            : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
  return `${months[d.getMonth()]} ${day}${suf}, ${d.getFullYear()}`;
}
function renderTitleSummary() {
  const cv = document.getElementById('titleView');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;                     // not laid out yet
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  if (!SAVED) { // nothing to summarize until a pilot is opened/created
    const words = ['No', 'Pilot', 'file', 'loaded'];
    const m = Math.round(cv.width * 0.08), aw = cv.width - m * 2;
    let fs = Math.round(cv.height / 7);
    g.textAlign = 'center'; g.textBaseline = 'top';
    const longest = () => Math.max(...words.map(wd => g.measureText(wd).width));
    g.font = `bold ${fs}px monospace`;
    while (fs > 7 && longest() > aw) { fs -= 1; g.font = `bold ${fs}px monospace`; }
    const lines = []; let line = '';
    for (const wd of words) {
      const t = line ? line + ' ' + wd : wd;
      if (line && g.measureText(t).width > aw) { lines.push(line); line = wd; } else line = t;
    }
    if (line) lines.push(line);
    const lh = fs * 1.35;
    let y = (cv.height - lines.length * lh) / 2;
    g.fillStyle = '#6f9f80';
    for (const ln of lines) { g.fillText(ln, cv.width / 2, y); y += lh; }
    g.textAlign = 'left';
    return;
  }
  const shipTypeName = ships[S.playerShipId] ? ships[S.playerShipId].name : 'Shuttlecraft';
  const fields = [
    ['Pilot', pilotName || 'Pilot'],
    ['Ship name', shipName || shipTypeName],
    ['Ship type', shipTypeName],
    ['Legal status', legalStatus(systemGovt())],
    ['Combat rating', combatRating()],
    ['Date', gameDate()],
  ];
  const pad = Math.round(cv.width * 0.07);
  const avail = cv.width - pad * 2;
  const lh = cv.height / (fields.length * 2 + 0.5); // label+value per field
  const labelSz = Math.max(6, Math.round(lh * 0.72));
  const valueSz = Math.max(7, Math.round(lh * 0.92));
  g.textBaseline = 'top';
  let y = pad * 0.6;
  for (const [label, val] of fields) {
    g.fillStyle = '#3f8f63'; g.font = `${labelSz}px monospace`;
    g.fillText(label + ':', pad, y); y += lh * 0.95;
    // shrink the value to fit the narrow viewscreen if needed
    let vs = valueSz; g.font = `bold ${vs}px monospace`;
    while (vs > 6 && g.measureText(val).width > avail) { vs -= 1; g.font = `bold ${vs}px monospace`; }
    g.fillStyle = '#86ffb6'; g.fillText(val, pad, y); y += lh * 1.05;
  }
}
// re-render on resize while the title is up (the canvas is sized from layout)
let titleSummaryResize = null;

// Enter Ship / Open Pilot need a loaded pilot; otherwise nudge toward New Pilot.
const needPilot = () => { showMsg('No pilot loaded — choose New Pilot to begin.'); };
document.getElementById('hotEnter').onclick = () => { if (SAVED) enterGame(); else needPilot(); };
document.getElementById('hotOpen').onclick  = () => { if (SAVED) enterGame(); else needPilot(); };
document.getElementById('hotNew').onclick   = () => {
  if (!SAVED || confirm('Start a new pilot? Your saved pilot will be erased.')) startNewPilot();
};
document.getElementById('hotAbout').onclick = titleAbout;
document.getElementById('hotPrefs').onclick = titlePrefs;
document.getElementById('hotQuit').onclick  = () =>
  showMsg('This is the browser edition — just close the tab to quit.');

