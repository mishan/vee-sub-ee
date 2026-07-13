/*
 * engine/shell/ui/sprites.js — sprite & PICT image loading and canvas drawing.
 *
 * The graphics helpers split out of 01-state.js (they were pure presentation
 * living in the state leaf): the ship/stellar spin-sheet cache + loader
 * (`sprites`/`preloadSprites`/`drawSpin`) and the single-image PICT cache
 * (`gfxCache`/`gfxImg`/`drawGfxFit`). They read the ambient `MANIFEST`/`EV`
 * globals and the DOM (`document`/`Image`), so they belong in the UI layer, not
 * the state module — and they import nothing from the shell, so they stay a
 * leaf. Callers pass the spin/PICT id (the id conventions — `spinOfShip` etc. —
 * stay in 01-state). esbuild bundles it (entry: main.js).
 */

/* ---------------- ship / stellar spin sheets ---------------- */

export const sprites = new Map(); // spinId -> {img, meta, ready}
export function preloadSprites(spinIds) {
  for (const id of spinIds) {
    const meta = MANIFEST.spins[id];
    if (!meta || sprites.has(+id)) continue;
    const img = document.createElement('img');
    img.src = 'evassets/sprites/spin_' + id + '.png';
    img.style.display = 'none';
    document.body.appendChild(img);
    const entry = { img, meta, ready: img.complete };
    img.onload = () => {
      entry.ready = true;
    };
    sprites.set(+id, entry);
  }
}
export function drawSpin(ctx, spinId, x, y, headingDeg) {
  let s = sprites.get(spinId);
  if (!s) {
    // Lazy-load on first sight: some hulls (mission-, pers-, and fighter-spawned
    // ships) aren't in the per-system preload set, so without this they'd render
    // invisible — only their thruster flame and target bracket would show.
    preloadSprites([spinId]);
    s = sprites.get(spinId);
  }
  if (!s || !s.ready) return;
  const { frameW, frameH, xTiles, frames } = s.meta;
  const fi = EV.frameIndex(headingDeg, frames);
  ctx.drawImage(
    s.img,
    (fi % xTiles) * frameW,
    Math.floor(fi / xTiles) * frameH,
    frameW,
    frameH,
    x - frameW / 2,
    y - frameH / 2,
    frameW,
    frameH,
  );
}

/* ---------------- single-image PICTs ----------------
 * Plain single-image PICT cache (target pics 3000+, etc.), drawn fit to a box
 * centred on (cx, cy). */
export const gfxCache = new Map();
export function gfxImg(pictId) {
  let e = gfxCache.get(pictId);
  if (!e) {
    const img = new Image();
    img.src = 'evassets/graphics/PICT_' + pictId + '.png';
    e = { img, ready: img.complete };
    img.onload = () => {
      e.ready = true;
    };
    img.onerror = () => {
      // Terminal state: mark it ready too, so a failed load is distinguishable
      // from "still loading". drawGfxFit still checks e.bad, so it won't draw a
      // broken image — but it stops treating the failure as perpetually pending.
      e.ready = true;
      e.bad = true;
    };
    gfxCache.set(pictId, e);
  }
  return e;
}
export function drawGfxFit(ctx, pictId, cx, cy, maxW, maxH) {
  const e = gfxImg(pictId);
  if (!e.ready || e.bad || !e.img.naturalWidth) return false;
  const s = Math.min(maxW / e.img.naturalWidth, maxH / e.img.naturalHeight, 1);
  const w = e.img.naturalWidth * s,
    h = e.img.naturalHeight * s;
  ctx.drawImage(e.img, cx - w / 2, cy - h / 2, w, h);
  return true;
}
