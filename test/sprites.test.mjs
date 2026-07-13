import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  sprites,
  preloadSprites,
  drawSpin,
  gfxCache,
  gfxImg,
  drawGfxFit,
} from '../engine/shell/ui/sprites.js';

// ui/sprites.js reads MANIFEST/document/Image/EV only inside its methods, so it
// imports in node; stub those globals to exercise the frame-crop / scale math.
// Capture and restore any pre-existing globals so the stubs don't leak into other
// suites sharing the process.
const _origGlobals = {
  document: globalThis.document,
  Image: globalThis.Image,
  MANIFEST: globalThis.MANIFEST,
  EV: globalThis.EV,
};
after(() => {
  for (const [k, v] of Object.entries(_origGlobals)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
});
globalThis.document = {
  createElement: () => ({ style: {}, src: '', complete: false }),
  body: { appendChild() {} },
};
globalThis.Image = class {
  constructor() {
    this.src = '';
    this.complete = false;
  }
};
// Local alias to the same object the module reads as the MANIFEST global, so
// tests can mutate MANIFEST.spins without eslint no-undef on the bare global.
const MANIFEST = { spins: {} };
globalThis.MANIFEST = MANIFEST;
globalThis.EV = { frameIndex: (h, frames) => ((h % frames) + frames) % frames };

function fakeCtx() {
  const calls = [];
  return {
    calls,
    drawImage(...a) {
      calls.push(a);
    },
  };
}
function reset() {
  sprites.clear();
  gfxCache.clear();
  MANIFEST.spins = {};
}

test('preloadSprites loads only ids with manifest metadata, and never twice', () => {
  reset();
  MANIFEST.spins = { 800: { frameW: 16, frameH: 16, xTiles: 6, frames: 36 } };
  preloadSprites([800, 999]); // 999 has no manifest entry
  assert.equal(sprites.size, 1);
  const e = sprites.get(800);
  assert.equal(e.img.src, 'evassets/sprites/spin_800.png');
  assert.equal(e.meta, MANIFEST.spins[800]);
  assert.equal(e.ready, false); // img.complete was false
  assert.equal(sprites.has(999), false);
  preloadSprites([800]); // already present → no reload
  assert.equal(sprites.size, 1);
  // the onload handler flips the entry to ready
  e.img.onload();
  assert.equal(e.ready, true);
});

test('drawSpin crops the correct sheet frame and centres it on (x,y)', () => {
  reset();
  const meta = { frameW: 20, frameH: 20, xTiles: 6, frames: 36 };
  const img = { id: 'sheet' };
  sprites.set(500, { img, meta, ready: true });
  const saved = globalThis.EV;
  globalThis.EV = { frameIndex: () => 7 }; // frame 7 → col 1, row 1
  const ctx = fakeCtx();
  drawSpin(ctx, 500, 100, 200, 123);
  globalThis.EV = saved;
  // src crop (7%6*20, ⌊7/6⌋*20) = (20,20); dest centred (100-10,200-10); 20×20
  assert.deepEqual(ctx.calls, [[img, 20, 20, 20, 20, 90, 190, 20, 20]]);
});

test('drawSpin draws nothing for a missing or not-yet-ready sprite', () => {
  reset();
  const ctx = fakeCtx();
  drawSpin(ctx, 12345, 0, 0, 0); // absent + no manifest → lazy load finds nothing
  sprites.set(600, {
    img: {},
    meta: { frameW: 10, frameH: 10, xTiles: 1, frames: 1 },
    ready: false,
  });
  drawSpin(ctx, 600, 0, 0, 0); // present but still loading
  assert.equal(ctx.calls.length, 0);
});

test('gfxImg caches one entry per PICT id', () => {
  reset();
  const a = gfxImg(3000);
  assert.equal(a.img.src, 'evassets/graphics/PICT_3000.png');
  assert.equal(gfxImg(3000), a); // same cached entry
  assert.notEqual(gfxImg(3001), a);
  assert.equal(gfxCache.size, 2);
});

test('gfxImg marks a failed load terminal: ready AND bad (not stuck loading)', () => {
  reset();
  const e = gfxImg(4000);
  assert.equal(e.ready, false);
  assert.equal(e.bad, undefined);
  e.img.onerror(); // the image 404s
  assert.equal(e.ready, true); // no longer looks like "still loading"
  assert.equal(e.bad, true);
});

test('drawGfxFit scales to fit the box (no upscaling) and centres it', () => {
  reset();
  gfxCache.set(9, { img: { naturalWidth: 200, naturalHeight: 100 }, ready: true });
  const ctx = fakeCtx();
  // s = min(100/200, 100/100, 1) = 0.5 → 100×50, dest (50-50, 60-25)
  assert.equal(drawGfxFit(ctx, 9, 50, 60, 100, 100), true);
  assert.deepEqual(ctx.calls, [[gfxCache.get(9).img, 0, 35, 100, 50]]);
  // a small image is never enlarged: s clamps at 1
  gfxCache.set(10, { img: { naturalWidth: 40, naturalHeight: 40 }, ready: true });
  const ctx2 = fakeCtx();
  drawGfxFit(ctx2, 10, 100, 100, 200, 200);
  assert.deepEqual(ctx2.calls, [[gfxCache.get(10).img, 80, 80, 40, 40]]);
});

test('drawGfxFit returns false and draws nothing when not ready, bad, or empty', () => {
  reset();
  const ctx = fakeCtx();
  gfxCache.set(1, { img: { naturalWidth: 100, naturalHeight: 100 }, ready: false });
  gfxCache.set(2, { img: { naturalWidth: 100, naturalHeight: 100 }, ready: true, bad: true });
  gfxCache.set(3, { img: { naturalWidth: 0, naturalHeight: 0 }, ready: true });
  assert.equal(drawGfxFit(ctx, 1, 0, 0, 50, 50), false); // still loading
  assert.equal(drawGfxFit(ctx, 2, 0, 0, 50, 50), false); // load failed
  assert.equal(drawGfxFit(ctx, 3, 0, 0, 50, 50), false); // zero-size
  assert.equal(ctx.calls.length, 0);
});
