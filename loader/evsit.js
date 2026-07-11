/*
 * evsit.js — decompress StuffIt 5 method 13 ("LZ+Huffman") streams, pure JS.
 *
 * Lets the browser loader accept a dropped `.sit` directly: this is the
 * decompressor; a StuffIt-5 archive parser (entry tree → per-fork streams)
 * sits on top. EV's `.sit` uses method 13 exclusively, and every fork uses the
 * *dynamic* table variant (header high-nibble 0), so the large static Huffman
 * tables are not needed here.
 *
 * Reimplemented in JS from the format as documented by XADMaster / The
 * Unarchiver (XADStuffIt13Handle, XADPrefixCode, XADLZSSHandle) — the algorithm
 * and its constants, not their code. Bit order is LSB-first; codes are built
 * canonically (shortest code = zeros) and matched MSB-first over the bitstream.
 *
 * No Node APIs, so it runs in the browser.
 */
'use strict';

// Meta-code: fixed prefix code used to encode the dynamic code-length lists.
// Values are given low-bit-first (bit k = (code >> k) & 1).
const META_CODES = [
  0x5d8, 0x058, 0x040, 0x0c0, 0x000, 0x078, 0x02b, 0x014,
  0x00c, 0x01c, 0x01b, 0x00b, 0x010, 0x020, 0x038, 0x018,
  0x0d8, 0xbd8, 0x180, 0x680, 0x380, 0xf80, 0x780, 0x480,
  0x080, 0x280, 0x3d8, 0xfd8, 0x7d8, 0x9d8, 0x1d8, 0x004,
  0x001, 0x002, 0x007, 0x003, 0x008,
];
const META_LENGTHS = [
  11, 8, 8, 8, 8, 7, 6, 5, 5, 5, 5, 6, 5, 6, 7, 7, 9, 12, 10, 11, 11, 12,
  12, 11, 11, 11, 12, 12, 12, 12, 12, 5, 2, 2, 3, 4, 5,
];

/* LSB-first bit reader over a byte array. Reads past the end throw, rather than
 * yielding undefined→0 — otherwise truncated/corrupt input decodes as a stream
 * of zeros and can spin until expectedLen instead of failing fast. */
class BitLE {
  constructor(bytes, start) { this.b = bytes; this.p = start | 0; this.bit = 0; }
  nextBit() {
    if (this.p >= this.b.length) throw new Error('StuffIt bitstream exhausted (truncated or corrupt data)');
    const v = (this.b[this.p] >> this.bit) & 1;
    if (++this.bit === 8) { this.bit = 0; this.p++; }
    return v;
  }
  nextBits(n) { let v = 0; for (let k = 0; k < n; k++) v |= this.nextBit() << k; return v; }
  nextByte() {                                    // byte-aligned
    if (this.bit) { this.bit = 0; this.p++; }
    if (this.p >= this.b.length) throw new Error('StuffIt bitstream exhausted (truncated or corrupt data)');
    return this.b[this.p++];
  }
}

/* Prefix-code tree. Symbols inserted as a bit sequence in *read order*; decode
 * walks the tree consuming one stream bit per branch. */
class Tree {
  constructor() { this.L = [-1]; this.R = [-1]; this.v = [null]; }
  insert(bits, value) {
    let n = 0;
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      let nx = b ? this.R[n] : this.L[n];
      if (nx < 0) { nx = this.L.length; this.L.push(-1); this.R.push(-1); this.v.push(null); if (b) this.R[n] = nx; else this.L[n] = nx; }
      n = nx;
    }
    this.v[n] = value;
  }
  decode(r) {
    let n = 0;
    while (this.v[n] === null) { n = r.nextBit() ? this.R[n] : this.L[n]; if (n < 0) throw new Error('bad prefix code'); }
    return this.v[n];
  }
}

/* Canonical Huffman from code lengths (shortest code = zeros); codes are matched
 * MSB-first, so insert bits high→low. Symbols with length 0 are omitted. */
function buildCanonical(lengths, numsymbols) {
  const tree = new Tree();
  let maxlen = 0;
  for (let i = 0; i < numsymbols; i++) if (lengths[i] > maxlen) maxlen = lengths[i];
  let code = 0;
  for (let len = 1; len <= maxlen; len++) {
    for (let sym = 0; sym < numsymbols; sym++) {
      if (lengths[sym] !== len) continue;
      const bits = new Array(len);
      for (let bp = len - 1, i = 0; bp >= 0; bp--, i++) bits[i] = (code >>> bp) & 1;
      tree.insert(bits, sym);
      code++;
    }
    code <<= 1;
  }
  return tree;
}

/* The meta-code, matched low-bit-first (bit k = (code >> k) & 1). */
function buildMetaCode() {
  const tree = new Tree();
  for (let i = 0; i < META_CODES.length; i++) {
    const c = META_CODES[i], len = META_LENGTHS[i], bits = new Array(len);
    for (let k = 0; k < len; k++) bits[k] = (c >>> k) & 1;
    tree.insert(bits, i);
  }
  return tree;
}

/* Decode a run-length-encoded list of `numcodes` code lengths via the meta-code
 * (mirrors XADStuffIt13Handle -allocAndParseCodeOfSize:). */
function parseCodeLengths(r, meta, numcodes) {
  const lengths = new Array(numcodes + 16).fill(0);
  let length = 0;
  for (let i = 0; i < numcodes; i++) {
    const val = meta.decode(r);
    switch (val) {
      case 31: length = -1; break;
      case 32: length++; break;
      case 33: length--; break;
      case 34: if (r.nextBit()) lengths[i++] = length; break;
      case 35: { let c = r.nextBits(3) + 2; while (c--) lengths[i++] = length; break; }
      case 36: { let c = r.nextBits(6) + 10; while (c--) lengths[i++] = length; break; }
      default: length = val + 1; break;
    }
    lengths[i] = length;
  }
  return lengths;
}

/* Decompress one method-13 stream to `expectedLen` bytes. */
function unstuff13(comp, expectedLen) {
  const r = new BitLE(comp, 0);
  const header = r.nextByte();
  const code = header >> 4;
  let firstcode, secondcode, offsetcode;
  if (code === 0) {
    const meta = buildMetaCode();
    firstcode = buildCanonical(parseCodeLengths(r, meta, 321), 321);
    secondcode = (header & 0x08) ? firstcode : buildCanonical(parseCodeLengths(r, meta, 321), 321);
    const offN = (header & 0x07) + 10;
    offsetcode = buildCanonical(parseCodeLengths(r, meta, offN), offN);
  } else {
    throw new Error('StuffIt method 13 static tables not implemented (not used by EV data)');
  }

  const out = new Uint8Array(expectedLen);
  const WIN = 65536, mask = WIN - 1, win = new Uint8Array(WIN);
  let pos = 0, curr = firstcode, matchlen = 0, matchoff = 0;
  while (pos < expectedLen) {
    if (matchlen === 0) {
      const val = curr.decode(r);
      if (val < 0x100) { curr = firstcode; win[pos & mask] = val; out[pos++] = val; continue; }
      curr = secondcode;
      let length;
      if (val < 0x13e) length = val - 0x100 + 3;
      else if (val === 0x13e) length = r.nextBits(10) + 65;
      else if (val === 0x13f) length = r.nextBits(15) + 65;
      else break;                                   // XADLZSSEnd
      const bl = offsetcode.decode(r);
      const offset = bl === 0 ? 1 : bl === 1 ? 2 : (1 << (bl - 1)) + r.nextBits(bl - 1) + 1;
      matchoff = pos - offset; matchlen = length;
    }
    matchlen--;
    const byte = win[matchoff++ & mask];
    win[pos & mask] = byte; out[pos++] = byte;
  }
  // A clean decode fills exactly expectedLen; reaching XADLZSSEnd early means the
  // stream is truncated/corrupt. Fail fast rather than return a zero-padded tail
  // (same rationale as the bit-reader's throw-on-exhaustion).
  if (pos < expectedLen)
    throw new Error('StuffIt method 13: stream ended early (' + pos + '/' + expectedLen + ' bytes)');
  return out;
}

/* Decode a StuffIt entry name. Names are MacRoman; use EVRSRC's decoder when it's
 * on the global (the loader exposes it) so non-ASCII names (e.g. the "ƒ" folder)
 * read correctly, else fall back to Latin-1. Only the ASCII fork names matter for
 * extraction, so the fallback is cosmetic. */
function sitName(sub) {
  const G = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (G.EVRSRC && G.EVRSRC.macRomanToString) return G.EVRSRC.macRomanToString(sub);
  let s = ''; for (let k = 0; k < sub.length; k++) s += String.fromCharCode(sub[k]); return s;
}

/* ---------------- StuffIt 5 archive parser ----------------
 * Walk the entry tree and return one record per fork:
 *   { path, name, isResource, method, offset, compLength, length }
 * Reimplemented from the format documented by XADStuffIt5Parser. Only method 13
 * (uncompressed 0 also passes through) is decompressed by extractForks below. */
function parseSit(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sig = String.fromCharCode(...u8.slice(0, 16));
  if (sig !== 'StuffIt (c)1997-') throw new Error('not a StuffIt 5 archive');

  let p = 82;
  const u8r = () => u8[p++];
  const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };

  const version = u8r();
  if (version !== 5) throw new Error('unsupported StuffIt version ' + version);
  const flags = u8r();
  u32();                                  // total size
  u32();                                  // ?
  const numfiles = u16();
  const firstoffs = u32();
  u16();                                  // crc
  if (flags & 0x10) p += 14;
  let commentsize = 0, lengthb = 0;
  if (flags & 0x20) { commentsize = u16(); lengthb = u16(); }
  if (flags & 0x80) throw new Error('encrypted archive not supported');
  if (flags & 0x40) { const n = u16(); p += n * 22; }
  if (flags & 0x20) { if (commentsize) p += commentsize; p += lengthb; }

  p = firstoffs;
  const entries = [], dirs = {};
  let count = numfiles;
  for (let i = 0; i < count; i++) {
    const offs = p;
    if (u32() !== 0xa5a5a5a5) throw new Error('bad entry id at ' + offs);
    const ver = u8r();
    p += 1;
    const headersize = u16(); const headerend = offs + headersize;
    p += 1;
    const eflags = u8r();
    p += 8;                               // creation + modification date
    p += 4; p += 4;                       // prev, next offset
    const diroffs = u32();
    const namelength = u16();
    u16();                                // header crc
    const datalength = u32();
    const datacomplen = u32();
    u16(); p += 2;                        // data crc + pad

    let datamethod = 0, numsub = 0;
    if (eflags & 0x40) {                  // directory
      numsub = u16();
      if (datalength === 0xffffffff) { count++; continue; }
    } else {
      datamethod = u8r();
      const passlen = u8r();
      if (passlen) throw new Error('encrypted entry not supported');
    }

    // namelength is untrusted: bound it to the file (and the entry header) and
    // build the string without a spread, which would throw "too many arguments"
    // or spike memory on a crafted huge length.
    if (p + namelength > u8.length || (headersize && p + namelength > headerend))
      throw new Error('StuffIt entry name length out of bounds');
    const name = sitName(u8.subarray(p, p + namelength));
    p += namelength;
    if (p < headerend) { const cs = u16(); p += 2; p += cs; } // comment

    const something = u16(); p += 2;
    p += 4; p += 4;                       // filetype, creator
    p += 2;                               // finder flags
    p += (ver === 1 ? 22 : 18);

    let rlen = 0, rcomp = 0, rmethod = 0;
    const hasresource = something & 0x01;
    if (hasresource) {
      rlen = u32(); rcomp = u32(); u16(); p += 2; rmethod = u8r();
      const passlen = u8r();
      if (passlen) throw new Error('encrypted entry not supported');
    }
    const datastart = p;

    const parent = dirs[diroffs] || '';
    const path = parent ? parent + '/' + name : name;

    if (eflags & 0x40) {
      dirs[offs] = path;
      p = datastart;
      count += numsub;
    } else {
      if (hasresource)
        entries.push({ path, name, isResource: true, method: rmethod, offset: datastart, compLength: rcomp, length: rlen });
      if (datalength || !hasresource)
        entries.push({ path, name, isResource: false, method: datamethod, offset: datastart + rcomp, compLength: datacomplen, length: datalength });
      p = datastart + rcomp + datacomplen;
    }
  }
  return entries;
}

// Classic-Mac resource forks top out near 16 MB (24-bit resource-data offsets);
// this cap is generous headroom that still stops a crafted header from asking
// for a multi-GB allocation and OOM-ing the browser tab.
const MAX_FORK_LEN = 256 * 1024 * 1024;

/* Decompress a single parsed fork entry to its bytes. */
function extractFork(bytes, entry) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { offset, compLength, length, method } = entry;
  // entry.* come straight from the untrusted archive headers. Validate before
  // slicing or allocating: the compressed range must lie inside the archive,
  // and the declared uncompressed length (unstuff13 allocates it up-front) must
  // be non-negative and bounded.
  if (!Number.isInteger(offset) || !Number.isInteger(compLength) ||
      offset < 0 || compLength < 0 || offset + compLength > u8.length)
    throw new Error('StuffIt entry compressed range out of bounds');
  if (!Number.isInteger(length) || length < 0 || length > MAX_FORK_LEN)
    throw new Error('StuffIt entry declares an implausible fork length (' + length + ')');
  const comp = u8.subarray(offset, offset + compLength);
  if (method === 0) {                                   // stored
    if (compLength !== length) throw new Error('StuffIt stored entry length mismatch');
    return comp.slice();
  }
  if (method === 13) return unstuff13(comp, length);
  throw new Error('unsupported StuffIt method ' + method);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { unstuff13, parseSit, extractFork };
if (typeof self !== 'undefined') { self.unstuff13 = unstuff13; self.parseSit = parseSit; self.extractFork = extractFork; }
