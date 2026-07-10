/*
 * evpict.js — decode classic-Mac QuickDraw PICT resources to RGBA, in pure JS.
 *
 * Part of the browser loader spike: turn the raw PICT bytes evrsrc.js extracts
 * from EV Graphics/Titles into pixels *in the browser*, replacing the
 * resource_dasm + ImageMagick step in evconvert.sh.
 *
 * Scope: the opcodes EV's PICTs actually use. Handles both PICT v1 (byte
 * opcodes) and v2 (word opcodes), the preamble (version/header/clip/comments),
 * and the image ops PackBitsRect (0x0098) and BitsRect (0x0090) — indexed
 * PixMaps (1/2/4/8-bit) and 1-bit BitMaps, PackBits row compression. Output is
 * rendered into the picture frame rect, clipped like resource_dasm.
 * DirectBitsRect/DirectBitsRgn (0x009A/0x009B) render direct 16/32-bit color.
 * An unmodelled opcode stops decoding and sets `unhandled` on the result.
 *
 * No Node APIs (DataView/Uint8Array only), so the same file runs in the browser.
 */
'use strict';

function decodePict(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const rd16 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const rd16s = () => { const v = dv.getInt16(p); p += 2; return v; };
  const rd32 = () => { const v = dv.getUint32(p); p += 4; return v; };
  const rdRect = () => ({ top: rd16s(), left: rd16s(), bottom: rd16s(), right: rd16s() });

  rd16();                       // picSize (unreliable for >32k; ignore)
  const frame = rdRect();       // picture frame — defines output size
  const fw = frame.right - frame.left, fh = frame.bottom - frame.top;
  // The frame rect is untrusted (loader accepts arbitrary .sit input) and the
  // RGBA buffer below is sized straight from it. Reject a negative or absurd
  // frame before allocating, so a crafted PICT can't OOM the tab. EV's largest
  // real art is 832×624; 8192/dim is generous headroom (≤256 MB ceiling).
  const MAX_DIM = 8192;
  if (!(fw >= 0 && fh >= 0 && fw <= MAX_DIM && fh <= MAX_DIM))
    throw new Error('PICT frame rect out of range (' + fw + '×' + fh + ')');

  // Version: v2 begins with word 0x0011 (bytes 00 11) then a version word;
  // v1 begins with byte 0x11 then a 1-byte version. Detect from the raw bytes.
  let v2;
  if (u8[10] === 0x00 && u8[11] === 0x11) { p = 10; rd16(); rd16(); v2 = true; }
  else if (u8[10] === 0x11) { p = 12; v2 = false; }   // skip version op + number byte
  else { p = 10; v2 = true; }                          // assume v2
  const rdop = () => v2 ? (p & 1 ? (p++, rd16()) : rd16()) : u8[p++];

  const out = { width: fw, height: fh, rgba: new Uint8ClampedArray(fw * fh * 4) };

  for (let guard = 0; guard < 100000 && p < u8.length; guard++) {
    const op = rdop();
    if (op === 0x00ff || op === 0xff) break;                 // OpEndPic
    if (op === 0x0000) continue;                             // NOP
    if (op === 0x001e) continue;                             // DefHilite
    if (op === 0x0c00) { p += 24; continue; }                // HeaderOp (v2)
    if (op === 0x0001) { const len = rd16(); p += len - 2; continue; } // Clip region
    if (op === 0x00a0) { p += 2; continue; }                 // ShortComment
    if (op === 0x00a1) { rd16(); const s = rd16(); p += s; continue; } // LongComment
    // A picture can carry several image ops (tiled bitmaps); composite them all
    // into the frame rather than stopping at the first. The *Rgn variants
    // (0x0091/0x0099) are the Rect ops plus a clip region we skip.
    if (op === 0x0090 || op === 0x0091 || op === 0x0098 || op === 0x0099) {
      renderBits(op === 0x0098 || op === 0x0099, op === 0x0091 || op === 0x0099);
      continue;
    }
    if (op === 0x009a || op === 0x009b) { renderDirectBits(op === 0x009b); continue; }
    out.unhandled = '0x' + op.toString(16);   // keep what we've composited, but flag it
    return out;
  }
  return out;

  // --- Bits / PackBitsRect (0x0090 / 0x0098) and their *Rgn variants ---
  function renderBits(packed, hasRegion) {
    const rowBytesRaw = rd16();
    const isPixmap = (rowBytesRaw & 0x8000) !== 0;
    const rowBytes = rowBytesRaw & 0x7fff;
    let bounds, pixelSize = 1, packType = 0, palette = null;

    if (isPixmap) {
      bounds = rdRect();
      rd16();                   // pmVersion
      packType = rd16();
      rd32();                   // packSize
      rd32(); rd32();           // hRes, vRes
      rd16();                   // pixelType
      pixelSize = rd16();
      rd16(); rd16();           // cmpCount, cmpSize
      rd32();                   // planeBytes
      rd32(); rd32();           // pmTable, pmReserved
      rd32();                   // ctSeed
      rd16();                   // ctFlags
      const ctSize = rd16();    // entries - 1
      palette = new Array(Math.max(256, ctSize + 1));
      // Index the table by POSITION: for an indexed PixMap the pixel value is
      // the entry's ordinal, not its `value` field (which is often 0 in the
      // ppat/device tables EV ships). Using the value field misplaced entries
      // and left most indices unset (→ black).
      for (let i = 0; i <= ctSize; i++) {
        rd16();                 // value (ignored — positional)
        const r = rd16(), g = rd16(), b = rd16();
        palette[i] = [r >> 8, g >> 8, b >> 8];
      }
    } else {
      bounds = rdRect();        // old-style 1-bit BitMap
    }
    const src = rdRect();       // srcRect
    const dst = rdRect();       // dstRect (where the bits land in frame coords)
    rd16();                     // transfer mode
    if (hasRegion) { const rl = rd16(); p += rl - 2; }  // maskRgn (skip)

    const bw = bounds.right - bounds.left, bh = bounds.bottom - bounds.top;
    // bounds come from untrusted PICT data and drive the bh×bw loops below;
    // reject a negative or absurd rect so a crafted bitmap can't spin/OOM.
    // (rowBytes is already masked to ≤0x7fff, so rowBuf is bounded.)
    if (!(bw >= 0 && bh >= 0 && bw <= MAX_DIM && bh <= MAX_DIM))
      throw new Error('PICT bitmap bounds out of range (' + bw + '×' + bh + ')');
    // Indexed PixMaps are 1/2/4/8-bit; anything else here (e.g. a PixMap claiming
    // 16) would silently fall through pixelAt to the 1-bit path and render junk.
    if (isPixmap && pixelSize !== 1 && pixelSize !== 2 && pixelSize !== 4 && pixelSize !== 8)
      throw new Error('PICT indexed PixMap unsupported pixelSize ' + pixelSize);
    const offX = (dst.left - frame.left) - (src.left - bounds.left);
    const offY = (dst.top - frame.top) - (src.top - bounds.top);
    const rowBuf = new Uint8Array(rowBytes);
    const unpacked = !packed || packType === 1 || rowBytes < 8;

    for (let y = 0; y < bh; y++) {
      if (unpacked) { for (let i = 0; i < rowBytes; i++) rowBuf[i] = u8[p++]; }
      else {
        const count = rowBytes > 250 ? rd16() : u8[p++];
        unpackBits(u8, p, count, rowBuf, rowBytes);
        p += count;
      }
      const oy = y + offY;
      if (oy < 0 || oy >= fh) continue;
      for (let x = 0; x < bw; x++) {
        const ox = x + offX;
        if (ox < 0 || ox >= fw) continue;
        const c = pixelAt(rowBuf, x);
        const o = (oy * fw + ox) * 4;
        out.rgba[o] = c[0]; out.rgba[o + 1] = c[1]; out.rgba[o + 2] = c[2]; out.rgba[o + 3] = 255;
      }
    }
    out.depth = isPixmap ? pixelSize : 1;

    function pixelAt(row, x) {
      if (isPixmap && pixelSize === 8) return palette[row[x]] || BLACK;
      if (isPixmap && pixelSize < 8) {
        const ppb = 8 / pixelSize, mask = (1 << pixelSize) - 1;
        const shift = 8 - pixelSize - (x % ppb) * pixelSize;
        return palette[(row[(x / ppb) | 0] >> shift) & mask] || BLACK;
      }
      const on = (row[x >> 3] >> (7 - (x & 7))) & 1;   // 1-bit: set = black
      return on ? BLACK : WHITE;
    }
  }

  // --- DirectBitsRect (0x009A) / DirectBitsRgn (0x009B): direct 16/32-bit ---
  function renderDirectBits(hasRegion) {
    p += 4;                     // pmBaseAddr (dummy 0x000000FF)
    const rowBytes = rd16() & 0x7fff;
    const bounds = rdRect();
    rd16();                     // pmVersion
    const packType = rd16();
    rd32();                     // packSize
    rd32(); rd32();             // hRes, vRes
    rd16();                     // pixelType
    const pixelSize = rd16();
    const cmpCount = rd16();
    rd16();                     // cmpSize
    rd32(); rd32(); rd32();     // planeBytes, pmTable, pmReserved (no color table)
    const src = rdRect(), dst = rdRect(); rd16(); // srcRect, dstRect, mode

    const bw = bounds.right - bounds.left, bh = bounds.bottom - bounds.top;
    // All of bounds/pixelSize/cmpCount are untrusted and size rowBuf / drive the
    // bh×bw loops. Reject values that would over-allocate, loop excessively, or
    // break planar indexing (which reads component planes at bw and bw*2).
    if (!(bw >= 0 && bh >= 0 && bw <= MAX_DIM && bh <= MAX_DIM))
      throw new Error('PICT direct-bits bounds out of range (' + bw + '×' + bh + ')');
    if (pixelSize !== 16 && pixelSize !== 32)
      throw new Error('PICT direct-bits unsupported pixelSize ' + pixelSize);
    if (pixelSize === 32 && (cmpCount < 3 || cmpCount > 4))
      throw new Error('PICT direct-bits invalid cmpCount ' + cmpCount);
    const offX = (dst.left - frame.left) - (src.left - bounds.left);
    const offY = (dst.top - frame.top) - (src.top - bounds.top);
    // Unpacked row: 16-bit = bw*2 bytes of RGB555; 32-bit packType 4 = planar,
    // cmpCount components of bw bytes each.
    const rowLen = pixelSize === 16 ? bw * 2 : bw * cmpCount;
    const rowBuf = new Uint8Array(rowLen);
    const unpacked = packType === 1 || rowBytes < 8;
    // Packed 16-bit is packType 3 — PackBits over 16-bit *words*, not bytes.
    // unpackBits is byte-oriented, so it would misdecode; refuse rather than
    // render garbage. (EV's own direct-color PICTs are all 32-bit packType 4.)
    if (pixelSize === 16 && !unpacked)
      throw new Error('PICT packed 16-bit direct color (word-RLE) not supported');
    // For 4-component data the first plane is alpha (ARGB), so RGB starts one
    // plane in; 3-component data starts at plane 0.
    const planeBase = (cmpCount - 3) * bw;
    // Dormant gaps (unreachable with classic EV data, which is all 32-bit
    // packType 4): the 32-bit read below assumes *planar* rows, so chunky
    // (packType 1/2, interleaved) 32-bit would misdecode; and the 16-bit read
    // is only reached for unpacked rows (packed 16-bit throws above). Left as-is
    // rather than adding untested code paths.

    for (let y = 0; y < bh; y++) {
      if (unpacked) { for (let i = 0; i < rowLen; i++) rowBuf[i] = u8[p++]; }
      else {
        const count = rowBytes > 250 ? rd16() : u8[p++];
        unpackBits(u8, p, count, rowBuf, rowLen);
        p += count;
      }
      const oy = y + offY;
      if (oy < 0 || oy >= fh) continue;
      for (let x = 0; x < bw; x++) {
        const ox = x + offX;
        if (ox < 0 || ox >= fw) continue;
        let r, g, b;
        if (pixelSize === 16) {
          const v = (rowBuf[x * 2] << 8) | rowBuf[x * 2 + 1];
          r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31;
        } else {                 // 32-bit planar (skip the alpha plane if present)
          r = rowBuf[planeBase + x]; g = rowBuf[planeBase + bw + x]; b = rowBuf[planeBase + bw * 2 + x];
        }
        const o = (oy * fw + ox) * 4;
        out.rgba[o] = r; out.rgba[o + 1] = g; out.rgba[o + 2] = b; out.rgba[o + 3] = 255;
      }
    }
    out.depth = pixelSize;
  }
}
const BLACK = [0, 0, 0], WHITE = [255, 255, 255];

/* PackBits (RLE) row decode: `count` input bytes at src[off] -> up to `outLen`. */
function unpackBits(src, off, count, out, outLen) {
  let i = off, end = off + count, o = 0;
  while (i < end && o < outLen) {
    const n = src[i++] << 24 >> 24; // sign-extend
    if (n >= 0) { for (let k = 0; k <= n && o < outLen && i < end; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const b = src[i++]; for (let k = 0; k < 1 - n && o < outLen; k++) out[o++] = b; }
  }
  while (o < outLen) out[o++] = 0;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { decodePict };
if (typeof self !== 'undefined') self.decodePict = decodePict;
