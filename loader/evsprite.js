/*
 * evsprite.js — composite a decoded sprite PICT with its mask PICT into a
 * single transparent RGBA sheet, in pure JS.
 *
 * Part of the browser loader: replaces evsprites.sh (ImageMagick CopyOpacity).
 * A spïn resource pairs a sprite sheet PICT (SpritesID) with a mask PICT
 * (MasksID); the mask is white-where-opaque, so the composited alpha is just
 * the mask's luminance. Both inputs are { width, height, rgba } from evpict.
 *
 * No Node APIs, so it runs in the browser.
 */
'use strict';

function compositeSprite(sprite, mask) {
  const { width, height, rgba } = sprite;
  const out = new Uint8ClampedArray(rgba);         // copy the RGB
  if (mask && mask.width === width && mask.height === height) {
    // Alpha = mask luminance (Rec.601), matching ImageMagick CopyOpacity —
    // masks are grayscale, but decoded edge pixels can carry slight color.
    const m = mask.rgba;
    for (let i = 0, n = width * height; i < n; i++) {
      const o = i * 4;
      out[o + 3] = Math.round(0.299 * m[o] + 0.587 * m[o + 1] + 0.114 * m[o + 2]);
    }
  }
  return { width, height, rgba: out };
}

// (Manifest entries are built inline by evbuild.buildManifest, from the record's
// xSize/ySize — kept in one place there to avoid two copies drifting.)

if (typeof module !== 'undefined' && module.exports) module.exports = { compositeSprite };
if (typeof self !== 'undefined') { self.compositeSprite = compositeSprite; }
