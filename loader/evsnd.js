/*
 * evsnd.js — decode classic-Mac 'snd ' resources to PCM, in pure JS.
 *
 * Part of the browser loader spike: turn the raw 'snd ' bytes evrsrc.js extracts
 * from EV Sounds into playable audio (a WebAudio buffer / WAV) in the browser,
 * replacing resource_dasm in evconvert.sh.
 *
 * Handles Format 1 and Format 2 'snd ' resources: walk the command list to the
 * bufferCmd/soundCmd, then read the SoundHeader — standard (8-bit unsigned PCM),
 * extended (8/16-bit, multi-channel), reported for compressed. EV's effects are
 * 8-bit mono; the extended path is there for completeness.
 *
 * No Node APIs (DataView/Uint8Array only), so the same file runs in the browser.
 */
'use strict';

function decodeSnd(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const rd16 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const rd32 = () => { const v = dv.getUint32(p); p += 4; return v; };

  const format = rd16();
  if (format === 1) {
    const nMod = rd16();
    p += nMod * 6;                       // modifier: type(2) + initData(4)
  } else if (format === 2) {
    rd16();                              // refCount
  } else {
    return { error: 'unknown snd format ' + format };
  }
  const nCmd = rd16();
  let dataOff = -1;
  for (let i = 0; i < nCmd; i++) {
    const cmd = rd16(); rd16(); const param2 = rd32();   // cmd, param1, param2
    if ((cmd & 0x7fff) === 0x0051 || (cmd & 0x7fff) === 0x0050) { dataOff = param2; break; } // bufferCmd / soundCmd
  }
  if (dataOff < 0 || dataOff + 22 > u8.length) return { error: 'no sound header' };

  // SoundHeader at dataOff
  p = dataOff;
  rd32();                                // samplePtr (0 = samples follow inline)
  let length = rd32();                   // # sample frames
  const rateFixed = rd32();              // sample rate, Fixed 16.16
  rd32(); rd32();                        // loopStart, loopEnd
  const encode = u8[p++];                // 0x00 std, 0xFF ext, 0xFE compressed
  p++;                                   // baseFrequency
  const sampleRate = Math.round(rateFixed / 65536);

  if (encode === 0x00) {                 // standardSoundHeader: 8-bit unsigned mono
    const n = Math.min(length, u8.length - p);
    return { sampleRate, channels: 1, bits: 8, pcm8: u8.slice(p, p + n) };
  }
  if (encode === 0xff) {                 // extendedSoundHeader
    const channels = rd32();
    rd32();                              // AIFF sample rate hi (Fixed) — reuse rateFixed
    p += 10 - 4;                         // rest of 80-bit extended rate (we already used the header rate)
    rd32(); rd32(); rd32();              // markerChunk, instrumentChunks, AESRecording
    const sampleSize = rd16();
    p += 14;                             // futureUse (2) + 3 reserved longs... align to sample data
    const frames = length;
    if (sampleSize === 16) {
      // frames/channels come from the untrusted header; clamp the allocation to
      // the int16 samples that actually fit in the resource, so a crafted length
      // can't force a huge Int16Array before the read loop stops at u8.length.
      const avail = Math.max(0, (u8.length - p) >> 1);
      const n = Math.min(frames * channels, avail);
      const pcm = new Int16Array(n > 0 ? n : 0);
      for (let i = 0; i < pcm.length; i++) { pcm[i] = dv.getInt16(p); p += 2; }
      return { sampleRate, channels, bits: 16, pcm16: pcm };
    }
    const n = Math.min(frames * channels, u8.length - p);
    return { sampleRate, channels, bits: 8, pcm8: u8.slice(p, p + n) };
  }
  return { error: 'compressed sound (cmpSH) not supported', sampleRate, encode };
}

/* Convenience: 8-bit unsigned or 16-bit signed PCM -> Float32 in [-1, 1). */
function toFloat32(dec) {
  if (dec.pcm16) { const f = new Float32Array(dec.pcm16.length); for (let i = 0; i < f.length; i++) f[i] = dec.pcm16[i] / 32768; return f; }
  if (dec.pcm8) { const f = new Float32Array(dec.pcm8.length); for (let i = 0; i < f.length; i++) f[i] = (dec.pcm8[i] - 128) / 128; return f; }
  return new Float32Array(0);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { decodeSnd, toFloat32 };
if (typeof self !== 'undefined') { self.decodeSnd = decodeSnd; self.toFloat32 = toFloat32; }
