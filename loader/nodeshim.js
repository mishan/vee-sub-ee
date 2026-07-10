/*
 * nodeshim.js — minimal Node `Buffer` for the browser, enough for evrsrc.js's
 * read path (parseFork / decodeRecord / decodeStrList / findType). Load before
 * evrsrc.js in the loader page. A subclass of Uint8Array, so `.subarray()`
 * returns a Buffer (species) and views share the underlying bytes.
 */
'use strict';
(function (g) {
  if (g.Buffer) return;
  class B extends Uint8Array {
    static alloc(n) { return new B(n); }
    static from(x, enc) {
      if (typeof x === 'string') {
        if (enc === 'hex') { const a = new B(x.length >> 1); for (let i = 0; i < a.length; i++) a[i] = parseInt(x.substr(i * 2, 2), 16); return a; }
        const a = new B(x.length); for (let i = 0; i < x.length; i++) a[i] = x.charCodeAt(i) & 0xff; return a;
      }
      const a = new B(x.length); a.set(x); return a;
    }
    static concat(parts) { let n = 0; for (const p of parts) n += p.length; const o = new B(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
    readUInt8(o) { return this[o]; }
    readInt8(o) { return (this[o] << 24) >> 24; }
    readUInt16BE(o) { return (this[o] << 8) | this[o + 1]; }
    readInt16BE(o) { return ((this[o] << 8) | this[o + 1]) << 16 >> 16; }
    readUInt32BE(o) { return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
    readInt32BE(o) { return (this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]; }
    writeUInt16BE(v, o) { this[o] = (v >>> 8) & 0xff; this[o + 1] = v & 0xff; }
    writeInt16BE(v, o) { this.writeUInt16BE(v & 0xffff, o); }
    writeUInt32BE(v, o) { this[o] = (v >>> 24) & 0xff; this[o + 1] = (v >>> 16) & 0xff; this[o + 2] = (v >>> 8) & 0xff; this[o + 3] = v & 0xff; }
    // Node's Buffer.copy(target, targetStart=0, sourceStart=0, sourceEnd=length):
    // copies the [sourceStart, sourceEnd) slice, truncated to the room left in
    // target, and returns the number of bytes written. evrsrc.js's fork-writing
    // path uses the ranged form, so the full signature matters.
    copy(target, tstart = 0, sstart = 0, send = this.length) {
      if (send > this.length) send = this.length;
      let len = send - sstart;
      const room = target.length - tstart;
      if (len > room) len = room;
      if (len <= 0) return 0;
      target.set(this.subarray(sstart, sstart + len), tstart);
      return len;
    }
    equals(o) { if (!o || o.length !== this.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false; return true; }
    toString(enc) {
      if (enc === 'hex') { let s = ''; for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0'); return s; }
      let s = ''; for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]); return s;
    }
  }
  g.Buffer = B;
})(typeof self !== 'undefined' ? self : this);
