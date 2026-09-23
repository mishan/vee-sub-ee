/*
 * evsit.js — decompress StuffIt 5 method 13 ("LZ+Huffman") and method 15
 * ("Arsenic") streams, pure JS.
 *
 * Lets the browser loader accept a dropped `.sit` directly: these are the
 * decompressors; a StuffIt-5 archive parser (entry tree → per-fork streams)
 * sits on top. Copies of EV in the wild use one or the other (the 1.0.5 rip is
 * method 13, Macintosh Garden's 1.0.4 is method 15). Method-13 forks all use the
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
  0x5d8, 0x058, 0x040, 0x0c0, 0x000, 0x078, 0x02b, 0x014, 0x00c, 0x01c, 0x01b, 0x00b, 0x010, 0x020,
  0x038, 0x018, 0x0d8, 0xbd8, 0x180, 0x680, 0x380, 0xf80, 0x780, 0x480, 0x080, 0x280, 0x3d8, 0xfd8,
  0x7d8, 0x9d8, 0x1d8, 0x004, 0x001, 0x002, 0x007, 0x003, 0x008,
];
const META_LENGTHS = [
  11, 8, 8, 8, 8, 7, 6, 5, 5, 5, 5, 6, 5, 6, 7, 7, 9, 12, 10, 11, 11, 12, 12, 11, 11, 11, 12, 12,
  12, 12, 12, 5, 2, 2, 3, 4, 5,
];

/* LSB-first bit reader over a byte array. Reads past the end throw, rather than
 * yielding undefined→0 — otherwise truncated/corrupt input decodes as a stream
 * of zeros and can spin until expectedLen instead of failing fast. */
class BitLE {
  constructor(bytes, start) {
    this.b = bytes;
    this.p = start | 0;
    this.bit = 0;
  }
  nextBit() {
    if (this.p >= this.b.length)
      throw new Error('StuffIt bitstream exhausted (truncated or corrupt data)');
    const v = (this.b[this.p] >> this.bit) & 1;
    if (++this.bit === 8) {
      this.bit = 0;
      this.p++;
    }
    return v;
  }
  nextBits(n) {
    let v = 0;
    for (let k = 0; k < n; k++) v |= this.nextBit() << k;
    return v;
  }
  nextByte() {
    // byte-aligned
    if (this.bit) {
      this.bit = 0;
      this.p++;
    }
    if (this.p >= this.b.length)
      throw new Error('StuffIt bitstream exhausted (truncated or corrupt data)');
    return this.b[this.p++];
  }
}

/* Prefix-code tree. Symbols inserted as a bit sequence in *read order*; decode
 * walks the tree consuming one stream bit per branch. */
class Tree {
  constructor() {
    this.L = [-1];
    this.R = [-1];
    this.v = [null];
  }
  insert(bits, value) {
    let n = 0;
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      let nx = b ? this.R[n] : this.L[n];
      if (nx < 0) {
        nx = this.L.length;
        this.L.push(-1);
        this.R.push(-1);
        this.v.push(null);
        if (b) this.R[n] = nx;
        else this.L[n] = nx;
      }
      n = nx;
    }
    this.v[n] = value;
  }
  decode(r) {
    let n = 0;
    while (this.v[n] === null) {
      n = r.nextBit() ? this.R[n] : this.L[n];
      if (n < 0) throw new Error('bad prefix code');
    }
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
    const c = META_CODES[i],
      len = META_LENGTHS[i],
      bits = new Array(len);
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
      case 31:
        length = -1;
        break;
      case 32:
        length++;
        break;
      case 33:
        length--;
        break;
      case 34:
        if (r.nextBit()) lengths[i++] = length;
        break;
      case 35: {
        let c = r.nextBits(3) + 2;
        while (c--) lengths[i++] = length;
        break;
      }
      case 36: {
        let c = r.nextBits(6) + 10;
        while (c--) lengths[i++] = length;
        break;
      }
      default:
        length = val + 1;
        break;
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
    secondcode = header & 0x08 ? firstcode : buildCanonical(parseCodeLengths(r, meta, 321), 321);
    const offN = (header & 0x07) + 10;
    offsetcode = buildCanonical(parseCodeLengths(r, meta, offN), offN);
  } else {
    throw new Error('StuffIt method 13 static tables not implemented (not used by EV data)');
  }

  const out = new Uint8Array(expectedLen);
  const WIN = 65536,
    mask = WIN - 1,
    win = new Uint8Array(WIN);
  let pos = 0,
    curr = firstcode,
    matchlen = 0,
    matchoff = 0;
  while (pos < expectedLen) {
    if (matchlen === 0) {
      const val = curr.decode(r);
      if (val < 0x100) {
        curr = firstcode;
        win[pos & mask] = val;
        out[pos++] = val;
        continue;
      }
      curr = secondcode;
      let length;
      if (val < 0x13e) length = val - 0x100 + 3;
      else if (val === 0x13e) length = r.nextBits(10) + 65;
      else if (val === 0x13f) length = r.nextBits(15) + 65;
      else break; // XADLZSSEnd
      const bl = offsetcode.decode(r);
      const offset = bl === 0 ? 1 : bl === 1 ? 2 : (1 << (bl - 1)) + r.nextBits(bl - 1) + 1;
      matchoff = pos - offset;
      matchlen = length;
    }
    matchlen--;
    const byte = win[matchoff++ & mask];
    win[pos & mask] = byte;
    out[pos++] = byte;
  }
  // A clean decode fills exactly expectedLen; reaching XADLZSSEnd early means the
  // stream is truncated/corrupt. Fail fast rather than return a zero-padded tail
  // (same rationale as the bit-reader's throw-on-exhaustion).
  if (pos < expectedLen)
    throw new Error(
      'StuffIt method 13: stream ended early (' + pos + '/' + expectedLen + ' bytes)',
    );
  return out;
}

/* ---------------- StuffIt method 15 ("Arsenic") ----------------
 * StuffIt 5's default compressor, used by e.g. the Macintosh Garden copy of EV:
 * an adaptive binary arithmetic coder over a Burrows–Wheeler block transform
 * with move-to-front and zero-run coding, then a bzip2-style RLE (four equal
 * bytes are followed by a repeat count). Reimplemented from the format as
 * documented by XADMaster (XADStuffItArsenicHandle) — the algorithm and its
 * constants, not their code. The arithmetic coder reads bits MSB-first. */
const ARS_BITS = 26,
  ARS_ONE = 1 << (ARS_BITS - 1),
  ARS_HALF = 1 << (ARS_BITS - 2);

/* MSB-first bit reader; like BitLE, reading past the end throws. */
class BitBE {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
    this.bit = 7;
  }
  nextBit() {
    if (this.p >= this.b.length)
      throw new Error('StuffIt bitstream exhausted (truncated or corrupt data)');
    const v = (this.b[this.p] >> this.bit) & 1;
    if (--this.bit < 0) {
      this.bit = 7;
      this.p++;
    }
    return v;
  }
}

/* Adaptive frequency model over symbols first..last. Each hit adds `inc`; when
 * the total passes `limit` every frequency is halved (rounding up). */
class ArsModel {
  constructor(first, last, inc, limit) {
    this.first = first;
    this.inc = inc;
    this.limit = limit;
    this.freq = new Int32Array(last - first + 1);
    this.reset();
  }
  reset() {
    this.freq.fill(this.inc);
    this.total = this.inc * this.freq.length;
  }
  bump(n) {
    this.freq[n] += this.inc;
    this.total += this.inc;
    if (this.total > this.limit) {
      this.total = 0;
      for (let i = 0; i < this.freq.length; i++) {
        this.freq[i] = (this.freq[i] + 1) >> 1;
        this.total += this.freq[i];
      }
    }
  }
}

class ArsDecoder {
  constructor(bytes) {
    this.r = new BitBE(bytes);
    this.range = ARS_ONE;
    this.code = 0;
    for (let i = 0; i < ARS_BITS; i++) this.code = (this.code << 1) | this.r.nextBit();
  }
  symbol(m) {
    const n = m.freq.length;
    const step = Math.floor(this.range / m.total);
    const target = Math.floor(this.code / step);
    let cum = 0,
      s = 0;
    for (; s < n - 1; s++) {
      if (cum + m.freq[s] > target) break;
      cum += m.freq[s];
    }
    const low = step * cum;
    this.code -= low;
    if (cum + m.freq[s] === m.total) this.range -= low;
    else this.range = m.freq[s] * step;
    while (this.range <= ARS_HALF) {
      this.range <<= 1;
      this.code = (this.code << 1) | this.r.nextBit();
    }
    m.bump(s);
    return s + m.first;
  }
  // `bits` binary symbols, assembled LSB-first.
  bits(m, bits) {
    let v = 0;
    for (let i = 0; i < bits; i++) if (this.symbol(m)) v += 2 ** i;
    return v;
  }
}

// Standard CRC-32 (reflected, poly 0xEDB88320), checked against the stream's own.
let CRC_TABLE = null;
function crc32(u8, len) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Decompress one method-15 stream to `expectedLen` bytes. */
function unstuff15(comp, expectedLen) {
  const fail = (why) => {
    throw new Error('StuffIt method 15: ' + why);
  };
  const d = new ArsDecoder(comp);
  const initial = new ArsModel(0, 1, 1, 256);
  const selector = new ArsModel(0, 10, 8, 1024);
  const mtfModels = [
    new ArsModel(2, 3, 8, 1024),
    new ArsModel(4, 7, 4, 1024),
    new ArsModel(8, 15, 4, 1024),
    new ArsModel(16, 31, 4, 1024),
    new ArsModel(32, 63, 2, 1024),
    new ArsModel(64, 127, 2, 1024),
    new ArsModel(128, 255, 1, 1024),
  ];
  if (d.bits(initial, 8) !== 0x41 || d.bits(initial, 8) !== 0x73) fail('bad signature');
  const blockbits = d.bits(initial, 4) + 9;
  const blocksize = 1 << blockbits;
  let endOfBlocks = d.bits(initial, 1) === 1;
  let streamCrc = null;

  const out = new Uint8Array(expectedLen);
  const block = new Uint8Array(blocksize);
  const next = new Uint32Array(blocksize);
  const mtf = new Uint8Array(256);
  const counts = new Uint32Array(256);
  let pos = 0,
    last = -1,
    run = 0;
  const emit = (b) => {
    if (pos >= expectedLen) fail('output overruns the declared length');
    out[pos++] = b;
  };

  while (!endOfBlocks) {
    for (let i = 0; i < 256; i++) mtf[i] = i;
    const mtfDecode = (k) => {
      const v = mtf[k];
      mtf.copyWithin(1, 0, k);
      mtf[0] = v;
      return v;
    };
    const randomized = d.bits(initial, 1);
    // The randomization table (for blocks the compressor judged degenerate) isn't
    // modeled; no EV archive seen uses it, so refuse rather than corrupt output.
    if (randomized) fail('randomized blocks are not supported');
    let index = d.bits(initial, blockbits);
    let n = 0;
    for (;;) {
      let sel = d.symbol(selector);
      if (sel === 0 || sel === 1) {
        // zero-run: bijective base-2 digits (sel 0 = 1, sel 1 = 2), LSB first
        let weight = 1,
          zeros = 0;
        while (sel < 2) {
          zeros += sel === 0 ? weight : 2 * weight;
          weight *= 2;
          sel = d.symbol(selector);
        }
        if (n + zeros > blocksize) fail('block overflow');
        block.fill(mtfDecode(0), n, n + zeros);
        n += zeros;
      }
      if (sel === 10) break;
      const sym = sel === 2 ? 1 : d.symbol(mtfModels[sel - 3]);
      if (n >= blocksize) fail('block overflow');
      block[n++] = mtfDecode(sym);
    }
    if (index >= n) fail('bad transform index');
    selector.reset();
    for (const m of mtfModels) m.reset();
    if (d.bits(initial, 1)) {
      streamCrc = d.bits(initial, 32) >>> 0;
      endOfBlocks = true;
    }

    // Inverse BWT: next[] links each position to its successor in the text.
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[block[i]]++;
    const start = new Uint32Array(256);
    for (let c = 0, total = 0; c < 256; c++) {
      start[c] = total;
      total += counts[c];
    }
    for (let i = 0; i < n; i++) next[start[block[i]]++] = i;

    // Walk the text, undoing the RLE: after four equal bytes, the next byte is
    // a count of further repeats. The RLE state carries across blocks.
    for (let i = 0; i < n; i++) {
      index = next[index];
      const b = block[index];
      if (run === 4) {
        for (let k = 0; k < b; k++) emit(last);
        run = 0;
      } else {
        if (b === last) run++;
        else {
          run = 1;
          last = b;
        }
        emit(b);
      }
    }
  }
  if (pos < expectedLen) fail('stream ended early (' + pos + '/' + expectedLen + ' bytes)');
  if (streamCrc !== null && crc32(out, pos) !== streamCrc) fail('CRC mismatch');
  return out;
}

/* Decode a StuffIt entry name. Names are MacRoman; use EVRSRC's decoder when it's
 * on the global (the loader exposes it) so non-ASCII names (e.g. the "ƒ" folder)
 * read correctly, else fall back to Latin-1. Only the ASCII fork names matter for
 * extraction, so the fallback is cosmetic. */
function sitName(sub) {
  const G =
    typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : {};
  if (G.EVRSRC && G.EVRSRC.macRomanToString) return G.EVRSRC.macRomanToString(sub);
  let s = '';
  for (let k = 0; k < sub.length; k++) s += String.fromCharCode(sub[k]);
  return s;
}

/* ---------------- StuffIt 5 archive parser ----------------
 * Walk the entry tree and return one record per fork:
 *   { path, name, isResource, method, offset, compLength, length }
 * Reimplemented from the format documented by XADStuffIt5Parser. Methods 13 and
 * 15 (and uncompressed 0) are decompressed by extractFork below. */
function parseSit(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sig = String.fromCharCode(...u8.slice(0, 16));
  if (sig !== 'StuffIt (c)1997-') throw new Error('not a StuffIt 5 archive');

  let p = 82;
  const u8r = () => u8[p++];
  const u16 = () => {
    const v = dv.getUint16(p);
    p += 2;
    return v;
  };
  const u32 = () => {
    const v = dv.getUint32(p);
    p += 4;
    return v;
  };

  const version = u8r();
  if (version !== 5) throw new Error('unsupported StuffIt version ' + version);
  const flags = u8r();
  u32(); // total size
  u32(); // ?
  const numfiles = u16();
  const firstoffs = u32();
  u16(); // crc
  if (flags & 0x10) p += 14;
  let commentsize = 0,
    lengthb = 0;
  if (flags & 0x20) {
    commentsize = u16();
    lengthb = u16();
  }
  if (flags & 0x80) throw new Error('encrypted archive not supported');
  if (flags & 0x40) {
    const n = u16();
    p += n * 22;
  }
  if (flags & 0x20) {
    if (commentsize) p += commentsize;
    p += lengthb;
  }

  p = firstoffs;
  const entries = [],
    dirs = {};
  let count = numfiles;
  for (let i = 0; i < count; i++) {
    const offs = p;
    if (u32() !== 0xa5a5a5a5) throw new Error('bad entry id at ' + offs);
    const ver = u8r();
    p += 1;
    const headersize = u16();
    const headerend = offs + headersize;
    p += 1;
    const eflags = u8r();
    p += 8; // creation + modification date
    p += 4;
    p += 4; // prev, next offset
    const diroffs = u32();
    const namelength = u16();
    u16(); // header crc
    const datalength = u32();
    const datacomplen = u32();
    u16();
    p += 2; // data crc + pad

    let datamethod = 0,
      numsub = 0;
    if (eflags & 0x40) {
      // directory
      numsub = u16();
      if (datalength === 0xffffffff) {
        count++;
        continue;
      }
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
    if (p < headerend) {
      const cs = u16();
      p += 2;
      p += cs;
    } // comment

    const something = u16();
    p += 2;
    p += 4;
    p += 4; // filetype, creator
    p += 2; // finder flags
    p += ver === 1 ? 22 : 18;

    let rlen = 0,
      rcomp = 0,
      rmethod = 0;
    const hasresource = something & 0x01;
    if (hasresource) {
      rlen = u32();
      rcomp = u32();
      u16();
      p += 2;
      rmethod = u8r();
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
        entries.push({
          path,
          name,
          isResource: true,
          method: rmethod,
          offset: datastart,
          compLength: rcomp,
          length: rlen,
        });
      if (datalength || !hasresource)
        entries.push({
          path,
          name,
          isResource: false,
          method: datamethod,
          offset: datastart + rcomp,
          compLength: datacomplen,
          length: datalength,
        });
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
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(compLength) ||
    offset < 0 ||
    compLength < 0 ||
    offset + compLength > u8.length
  )
    throw new Error('StuffIt entry compressed range out of bounds');
  if (!Number.isInteger(length) || length < 0 || length > MAX_FORK_LEN)
    throw new Error('StuffIt entry declares an implausible fork length (' + length + ')');
  const comp = u8.subarray(offset, offset + compLength);
  if (method === 0) {
    // stored
    if (compLength !== length) throw new Error('StuffIt stored entry length mismatch');
    return comp.slice();
  }
  if (method === 13) return unstuff13(comp, length);
  if (method === 15) return unstuff15(comp, length);
  throw new Error('unsupported StuffIt method ' + method);
}

/* ---- Node CLI: extract the resource forks needed for local dev ----
 * `node loader/evsit.js extract <archive.sit> <outdir>` decompresses the forks
 * the build consumes (the five EV_data resource files + the EV application, for
 * name suggestions / app strings) straight out of the StuffIt archive — the same
 * decoder the browser loader uses, so no external unstuffer is needed. Written to
 * the standard layout the Makefile's DATA/APP/RAW defaults expect. Guarded so the
 * browser bundle (which has no `require`) never runs it. */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const [verb, sitPath, outDir] = process.argv.slice(2);
  if (verb !== 'extract' || !sitPath || !outDir) {
    console.error('usage: node loader/evsit.js extract <archive.sit> <outdir>');
    process.exit(2);
  }
  // entry name (in the archive) → destination path (relative to outDir).
  const WANT = {
    'EV Data': 'EV Data.rsrc',
    'EV Graphics': 'EV Graphics.rsrc',
    'EV Sounds': 'EV Sounds.rsrc',
    'EV Titles': 'EV Titles.rsrc',
    'EV Music': 'EV Music.rsrc',
    'Escape Velocity': path.join('EV_1.0.5', 'Escape Velocity.rsrc'),
  };
  const sit = new Uint8Array(fs.readFileSync(sitPath));
  const entries = parseSit(sit);
  let wrote = 0;
  for (const name of Object.keys(WANT)) {
    const e = entries.find((x) => x.isResource && x.name === name);
    if (!e) {
      console.error(`  ! ${name}: not found in archive — skipped`);
      continue;
    }
    let fork;
    try {
      fork = extractFork(sit, e);
    } catch (err) {
      console.error(`  ! ${name}: ${err.message} — skipped`);
      continue;
    }
    const dest = path.join(outDir, WANT[name]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fork);
    console.log(`  ${name} → ${dest} (${fork.length} bytes)`);
    wrote++;
  }
  console.log(`extracted ${wrote}/${Object.keys(WANT).length} forks to ${outDir}`);
  if (wrote === 0) process.exit(1);
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = { unstuff13, unstuff15, parseSit, extractFork };
if (typeof self !== 'undefined') {
  self.unstuff13 = unstuff13;
  self.unstuff15 = unstuff15;
  self.parseSit = parseSit;
  self.extractFork = extractFork;
}
