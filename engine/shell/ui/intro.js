/*
 * engine/shell/ui/intro.js — the new-pilot intro cinematic (presentation).
 *
 * Two screens, shown once the first time a brand-new pilot is flown (spec:
 * "New-pilot intro"): the launch graphic (PICT 8200 "Intro"), then the story
 * crawl — STR# 20000 "Intro Text" scrolled bottom-to-top over black, fading at
 * the edges, ending on "Good luck, captain." This module owns only the DOM/
 * animation; the flow + audio + persistence live in the intro state machine in
 * 11-title.js, which drives these helpers. Dependency stays one-way (logic → ui).
 *
 * esbuild bundles the shell modules (entry: main.js). Normative: ENGINE_SPEC.md.
 */

export const introEl = document.getElementById('intro');

/* Show the launch graphic with a "press any key to begin" prompt (the first
 * gesture is what unlocks audio, so the ambient/crawl music can start). */
export function showIntroGraphic() {
  introEl.className = 'graphic';
  introEl.style.display = 'flex';
  const p = document.getElementById('introPrompt');
  if (p) {
    p.textContent = 'Press any key or tap to begin';
    p.style.display = '';
  }
  document.getElementById('introSkip').style.display = 'none';
}
// Once begun, drop the prompt (the graphic holds a beat before the crawl).
export function beginGraphic() {
  const p = document.getElementById('introPrompt');
  if (p) p.style.display = 'none';
}

// Group STR# 20000 into paragraphs (a blank line ends one), as the crawl reads.
function introParagraphs() {
  const lines = (DATA.strings[20000] && DATA.strings[20000].list) || [];
  const paras = [];
  let cur = [];
  for (const ln of lines) {
    if (String(ln).trim() === '') {
      if (cur.length) {
        paras.push(cur.join(' '));
        cur = [];
      }
    } else cur.push(ln);
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras;
}

let crawlRAF = null,
  crawlDone = null;
/* Build the crawl and scroll it up at a steady pace; call `onDone` at the end
 * (or when skipped). rAF (not a CSS transition) so a skip can cancel cleanly. */
export function startCrawl(onDone) {
  crawlDone = onDone;
  const crawl = document.getElementById('introCrawl');
  crawl.textContent = '';
  for (const para of introParagraphs()) {
    const p = document.createElement('p');
    p.textContent = para; // textContent, not innerHTML — no markup injection
    crawl.appendChild(p);
  }
  introEl.className = 'crawl';
  document.getElementById('introSkip').style.display = '';
  // Measure after the browser has laid the text out, then animate.
  requestAnimationFrame(() => {
    const view = document.getElementById('introCrawlWrap').clientHeight || introEl.clientHeight;
    const startY = view, // start just below the viewport
      endY = -crawl.scrollHeight; // finish once the last line has scrolled off
    const SPEED = 55; // px/sec — leisurely, like the original (tunable)
    const dur = ((startY - endY) / SPEED) * 1000;
    const t0 = performance.now();
    const stepFn = (now) => {
      const k = Math.min((now - t0) / dur, 1);
      crawl.style.transform = `translate(-50%, ${startY + (endY - startY) * k}px)`;
      if (k < 1) crawlRAF = requestAnimationFrame(stepFn);
      else finishCrawl();
    };
    crawlRAF = requestAnimationFrame(stepFn);
  });
}
function finishCrawl() {
  if (crawlRAF) cancelAnimationFrame(crawlRAF);
  crawlRAF = null;
  const d = crawlDone;
  crawlDone = null;
  if (d) d();
}
// Skip the crawl (any gesture) — jumps straight to its onDone.
export function skipCrawl() {
  finishCrawl();
}
export function hideIntro() {
  if (crawlRAF) cancelAnimationFrame(crawlRAF);
  crawlRAF = null;
  crawlDone = null;
  introEl.style.display = 'none';
  introEl.className = '';
}
