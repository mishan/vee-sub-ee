#!/usr/bin/env node
/*
 * evrsrc.js — Extraction pipeline for Escape Velocity (classic Mac) data files.
 *
 * Pipeline stages:
 *   1. Container unwrap: MacBinary (.bin), AppleDouble (._foo / .rsrc from
 *      macOS zips), or a raw resource fork.
 *   2. Resource fork parse: walk the resource map -> types, IDs, names.
 *   3. Extraction: dump raw resources to disk for downstream decoders
 *      (e.g. resource_dasm for PICT/snd — don't reimplement QuickDraw).
 *   4. Record decode: schema-driven big-endian struct reader, so field
 *      layouts live in JSON (fill from the EV Bible / EVNEW source).
 *
 * Zero dependencies. Node >= 16.
 *
 * Usage:
 *   node evrsrc.js info     <file>
 *   node evrsrc.js list     <file> [type]
 *   node evrsrc.js extract  <file> -o <dir> [type]
 *   node evrsrc.js decode   <file> <type> <id> --schema <schema.json>
 *   node evrsrc.js strings  <file> <id>          # decode a STR# resource
 *   node evrsrc.js selftest
 *
 * Types may be given in ASCII alias form ("ship"), literal MacRoman-in-UTF8
 * form ("shïp"), or hex ("0x7368957 0"-style via hex:73689570).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* MacRoman                                                            */
/* ------------------------------------------------------------------ */

// High half (0x80–0xFF) of the MacRoman charset.
const MACROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü' +
  '†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»…\u00A0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ' +
  '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uF8FFÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function macRomanToString(buf) {
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : MACROMAN_HIGH[b - 0x80];
  return s;
}

function stringToMacRoman(str) {
  const out = Buffer.alloc(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const cc = c.charCodeAt(0);
    if (cc < 0x80) { out[i] = cc; continue; }
    const hi = MACROMAN_HIGH.indexOf(c);
    if (hi < 0) throw new Error(`Character '${c}' not representable in MacRoman`);
    out[i] = 0x80 + hi;
  }
  return out;
}

/*
 * EV resource types use MacRoman "accented" letters because Apple reserved
 * all-ASCII type codes. Aliases below cover classic EV / Override / Nova.
 */
const TYPE_ALIASES = {
  ship: 'shïp', spob: 'spöb', syst: 'sÿst', weap: 'wëap', misn: 'mïsn',
  dude: 'düde', govt: 'gövt', spin: 'spïn', desc: 'dësc', outf: 'oütf',
  char: 'chär', pers: 'përs', boom: 'bööm', intf: 'ïntf', cron: 'crön',
  nebu: 'nëbu', junk: 'jünk', oops: 'öops', rank: 'ränk', roid: 'röid',
  flet: 'flët', shan: 'shän', rled: 'rlëD', colr: 'cölr',
};

function resolveType(arg) {
  if (arg.startsWith('hex:')) {
    const b = Buffer.from(arg.slice(4), 'hex');
    if (b.length !== 4) throw new Error('hex type must be 4 bytes');
    return b;
  }
  const named = TYPE_ALIASES[arg.toLowerCase()] || arg;
  const b = stringToMacRoman(named);
  if (b.length !== 4) throw new Error(`Type '${arg}' is not 4 characters`);
  return b;
}

/* ------------------------------------------------------------------ */
/* Stage 1: container unwrapping                                       */
/* ------------------------------------------------------------------ */

function looksLikeResourceFork(buf) {
  if (buf.length < 16) return false;
  const dataOff = buf.readUInt32BE(0), mapOff = buf.readUInt32BE(4);
  const dataLen = buf.readUInt32BE(8), mapLen = buf.readUInt32BE(12);
  return dataOff >= 16 && mapLen >= 30 &&
    dataOff + dataLen <= buf.length &&
    mapOff + mapLen <= buf.length &&
    mapOff >= dataOff + dataLen;
}

function unwrapMacBinary(buf) {
  if (buf.length < 128) return null;
  const nameLen = buf[1];
  if (buf[0] !== 0 || buf[74] !== 0 || buf[82] !== 0) return null;
  if (nameLen < 1 || nameLen > 63) return null;
  const dataLen = buf.readUInt32BE(83);
  const rsrcLen = buf.readUInt32BE(87);
  if (rsrcLen === 0 || 128 + dataLen + rsrcLen > buf.length + 256) return null;
  const rsrcStart = 128 + Math.ceil(dataLen / 128) * 128;
  if (rsrcStart + rsrcLen > buf.length) return null;
  return {
    container: 'MacBinary',
    filename: macRomanToString(buf.subarray(2, 2 + nameLen)),
    type: macRomanToString(buf.subarray(65, 69)),
    creator: macRomanToString(buf.subarray(69, 73)),
    fork: buf.subarray(rsrcStart, rsrcStart + rsrcLen),
  };
}

function unwrapAppleDouble(buf) {
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x00051607) return null;
  const n = buf.readUInt16BE(24);
  for (let i = 0; i < n; i++) {
    const e = 26 + i * 12;
    if (buf.readUInt32BE(e) === 2) { // entry ID 2 = resource fork
      const off = buf.readUInt32BE(e + 4), len = buf.readUInt32BE(e + 8);
      return { container: 'AppleDouble', fork: buf.subarray(off, off + len) };
    }
  }
  return null;
}

function loadFork(file) {
  const buf = fs.readFileSync(file);
  const mb = unwrapMacBinary(buf);
  if (mb) return mb;
  const ad = unwrapAppleDouble(buf);
  if (ad) return ad;
  if (looksLikeResourceFork(buf)) return { container: 'raw fork', fork: buf };
  throw new Error(`${file}: not MacBinary, AppleDouble, or a raw resource fork ` +
    `(if this is a .sit/.cpt archive, expand it first — 'unar' handles StuffIt)`);
}

/* ------------------------------------------------------------------ */
/* Stage 2: resource fork parsing                                      */
/* ------------------------------------------------------------------ */

function parseFork(fork) {
  const dataOff = fork.readUInt32BE(0);
  const mapOff = fork.readUInt32BE(4);
  const map = fork.subarray(mapOff);

  const typeListOff = map.readUInt16BE(24); // from map start
  const nameListOff = map.readUInt16BE(26); // from map start
  const typeList = map.subarray(typeListOff);
  const nTypes = (typeList.readUInt16BE(0) + 1) & 0xffff; // stored as count-1

  const types = [];
  for (let t = 0; t < nTypes; t++) {
    const e = 2 + t * 8;
    const typeBytes = Buffer.from(typeList.subarray(e, e + 4));
    const count = typeList.readUInt16BE(e + 4) + 1;
    const refOff = typeList.readUInt16BE(e + 6); // from type list start
    const resources = [];
    for (let r = 0; r < count; r++) {
      const re = refOff + r * 12;
      const id = typeList.readInt16BE(re);
      const nameOff = typeList.readUInt16BE(re + 2);
      const attrs = typeList[re + 4];
      const dOff = (typeList[re + 5] << 16) | (typeList[re + 6] << 8) | typeList[re + 7];
      const len = fork.readUInt32BE(dataOff + dOff);
      let name = null;
      if (nameOff !== 0xffff) {
        const np = nameListOff + nameOff;
        name = macRomanToString(map.subarray(np + 1, np + 1 + map[np]));
      }
      resources.push({
        id, name, attrs, length: len,
        data: () => fork.subarray(dataOff + dOff + 4, dataOff + dOff + 4 + len),
      });
    }
    types.push({
      typeBytes,
      typeName: macRomanToString(typeBytes),
      typeHex: typeBytes.toString('hex'),
      resources,
    });
  }
  return types;
}

function findType(types, typeArg) {
  const want = resolveType(typeArg);
  return types.find(t => t.typeBytes.equals(want));
}

/* ------------------------------------------------------------------ */
/* Stage 4: schema-driven record decoding                              */
/* ------------------------------------------------------------------ */
/*
 * Schema JSON: { "name": "...", "source": "...", "fields": [ [name, type], ...] }
 * Types: i8 u8 i16 u16 i32 u32 | pstrN (Pascal str in N-byte field) | bytesN
 * Repeat shorthand: ["WeapType", "i16", 4] expands to WeapType1..4.
 */
function decodeRecord(buf, schema) {
  const out = {};
  let off = 0;
  const fields = [];
  for (const f of schema.fields) {
    const [name, type, repeat] = f;
    if (repeat) for (let i = 1; i <= repeat; i++) fields.push([`${name}${i}`, type]);
    else fields.push([name, type]);
  }
  const size = (t) => ({ i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4 }[t] ??
    +(/(\d+)$/.exec(t) || [0, 0])[1]);
  for (const [name, type] of fields) {
    if (off + size(type) > buf.length) { out.__truncatedAt = name; break; }
    let m;
    if (type === 'i8') { out[name] = buf.readInt8(off); off += 1; }
    else if (type === 'u8') { out[name] = buf.readUInt8(off); off += 1; }
    else if (type === 'i16') { out[name] = buf.readInt16BE(off); off += 2; }
    else if (type === 'u16') { out[name] = buf.readUInt16BE(off); off += 2; }
    else if (type === 'i32') { out[name] = buf.readInt32BE(off); off += 4; }
    else if (type === 'u32') { out[name] = buf.readUInt32BE(off); off += 4; }
    else if ((m = /^pstr(\d+)$/.exec(type))) {
      const n = +m[1];
      out[name] = macRomanToString(buf.subarray(off + 1, off + 1 + Math.min(buf[off], n - 1)));
      off += n;
    } else if ((m = /^bytes(\d+)$/.exec(type))) {
      out[name] = buf.subarray(off, off + +m[1]).toString('hex');
      off += +m[1];
    } else if (type === 'cstr') {
      // Null-terminated C string (TMPL CSTR), variable length.
      let end = buf.indexOf(0, off);
      if (end < 0) end = buf.length;
      out[name] = macRomanToString(buf.subarray(off, end));
      off = Math.min(end + 1, buf.length);
    } else throw new Error(`Unknown field type '${type}'`);
  }
  out.__schemaBytes = off;
  out.__recordBytes = buf.length;
  return out;
}

/* STR# — standard Mac string-list resource; format is fully documented. */
function decodeStrList(buf) {
  const n = buf.readUInt16BE(0);
  const out = [];
  let off = 2;
  for (let i = 0; i < n; i++) {
    const len = buf[off];
    out.push(macRomanToString(buf.subarray(off + 1, off + 1 + len)));
    off += 1 + len;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Self-test: synthesize a fork, then parse it back                    */
/* ------------------------------------------------------------------ */

function buildFork(entries) {
  // entries: [{type: Buffer4, id, name?, data: Buffer}]
  const dataParts = [];
  let dOff = 0;
  const withOffsets = entries.map(e => {
    const rec = Buffer.alloc(4 + e.data.length);
    rec.writeUInt32BE(e.data.length, 0);
    e.data.copy(rec, 4);
    dataParts.push(rec);
    const o = dOff; dOff += rec.length;
    return { ...e, dataOffset: o };
  });
  const dataArea = Buffer.concat(dataParts);

  const byType = new Map();
  for (const e of withOffsets) {
    const k = e.type.toString('hex');
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(e);
  }

  const nameParts = [];
  let nameOff = 0;
  for (const e of withOffsets) {
    if (e.name != null) {
      const nb = stringToMacRoman(e.name);
      nameParts.push(Buffer.concat([Buffer.from([nb.length]), nb]));
      e.nameOffset = nameOff; nameOff += 1 + nb.length;
    } else e.nameOffset = 0xffff;
  }
  const nameList = Buffer.concat(nameParts.length ? nameParts : [Buffer.alloc(0)]);

  const nTypes = byType.size;
  const typeHeader = Buffer.alloc(2 + nTypes * 8);
  typeHeader.writeUInt16BE((nTypes - 1) & 0xffff, 0);
  const refLists = [];
  let refOff = 2 + nTypes * 8; // from type list start
  let t = 0;
  for (const [, list] of byType) {
    list[0].type.copy(typeHeader, 2 + t * 8);
    typeHeader.writeUInt16BE(list.length - 1, 2 + t * 8 + 4);
    typeHeader.writeUInt16BE(refOff, 2 + t * 8 + 6);
    const rl = Buffer.alloc(list.length * 12);
    list.forEach((e, i) => {
      rl.writeInt16BE(e.id, i * 12);
      rl.writeUInt16BE(e.nameOffset, i * 12 + 2);
      rl[i * 12 + 4] = 0;
      rl[i * 12 + 5] = (e.dataOffset >> 16) & 0xff;
      rl[i * 12 + 6] = (e.dataOffset >> 8) & 0xff;
      rl[i * 12 + 7] = e.dataOffset & 0xff;
    });
    refLists.push(rl);
    refOff += rl.length;
    t++;
  }
  const typeList = Buffer.concat([typeHeader, ...refLists]);

  const mapHeaderLen = 28;
  const mapLen = mapHeaderLen + typeList.length + nameList.length;
  const map = Buffer.alloc(mapLen);
  map.writeUInt16BE(mapHeaderLen, 24);                    // type list offset
  map.writeUInt16BE(mapHeaderLen + typeList.length, 26);  // name list offset
  typeList.copy(map, mapHeaderLen);
  nameList.copy(map, mapHeaderLen + typeList.length);

  const dataOffset = 256;
  const fork = Buffer.alloc(dataOffset + dataArea.length + mapLen);
  fork.writeUInt32BE(dataOffset, 0);
  fork.writeUInt32BE(dataOffset + dataArea.length, 4);
  fork.writeUInt32BE(dataArea.length, 8);
  fork.writeUInt32BE(mapLen, 12);
  dataArea.copy(fork, dataOffset);
  map.copy(fork, dataOffset + dataArea.length);
  // Also mirror header into map's first 16 bytes, as real forks do.
  fork.copy(fork, dataOffset + dataArea.length, 0, 16);
  return fork;
}

function selftest() {
  const shipType = resolveType('ship');
  const ship = Buffer.alloc(20);
  ship.writeInt16BE(120, 0);   // pretend Holds
  ship.writeInt16BE(4200, 2);  // pretend Shield
  const strs = Buffer.concat([
    Buffer.from([0, 2]),
    Buffer.from([5]), stringToMacRoman('Aurora'),
  ]);
  // deliberate: 'Aurora' is 6 chars but we wrote len 5 -> catches slicing bugs
  const fork = buildFork([
    { type: shipType, id: 128, name: 'Shuttle', data: ship },
    { type: shipType, id: 129, name: 'Kestrel', data: ship },
    { type: resolveType('hex:53545223'), id: 200, data: strs }, // 'STR#'
  ]);

  const assert = (cond, msg) => { if (!cond) throw new Error('selftest: ' + msg); };
  assert(looksLikeResourceFork(fork), 'synthetic fork failed sniff test');
  const types = parseFork(fork);
  assert(types.length === 2, `expected 2 types, got ${types.length}`);
  const st = findType(types, 'ship');
  assert(st && st.typeName === 'shïp', 'shïp type missing or misdecoded');
  assert(st.resources.length === 2, 'expected 2 ships');
  assert(st.resources[0].id === 128 && st.resources[0].name === 'Shuttle', 'ship 128 wrong');
  assert(st.resources[1].name === 'Kestrel', 'ship 129 name wrong');
  assert(st.resources[0].data().readInt16BE(2) === 4200, 'ship payload wrong');
  const strT = findType(types, 'hex:53545223');
  assert(decodeStrList(strT.resources[0].data())[0] === 'Auror', 'STR# decode wrong');

  // Round-trip through MacBinary too.
  const mb = Buffer.alloc(128 + Math.ceil(fork.length / 128) * 128);
  mb[1] = 4; mb.write('test', 2, 'ascii');
  stringToMacRoman('Mpïn').copy(mb, 65);
  mb.write('EV..', 69, 'ascii');
  mb.writeUInt32BE(0, 83);
  mb.writeUInt32BE(fork.length, 87);
  fork.copy(mb, 128);
  const un = unwrapMacBinary(mb);
  assert(un && un.container === 'MacBinary', 'MacBinary unwrap failed');
  assert(un.type === 'Mpïn', 'MacBinary type field misdecoded');
  assert(parseFork(un.fork).length === 2, 'MacBinary round-trip parse failed');

  console.log('selftest: all assertions passed ✓');
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const [, , cmd, ...args] = process.argv;
  const opt = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args.splice(i, 2)[1] : null;
  };

  if (cmd === 'selftest') return selftest();
  if (!cmd || args.length < 1) {
    console.error('usage: evrsrc.js info|list|extract|decode|strings|selftest <file> ...');
    process.exit(1);
  }

  const outDir = opt('-o');
  const schemaPath = opt('--schema');
  const src = loadFork(args[0]);
  const types = parseFork(src.fork);

  if (cmd === 'info') {
    console.log(`container: ${src.container}` +
      (src.filename ? `  name: "${src.filename}"  type/creator: ${src.type}/${src.creator}` : ''));
    console.log(`fork: ${src.fork.length} bytes, ${types.length} resource types, ` +
      `${types.reduce((n, t) => n + t.resources.length, 0)} resources`);
    for (const t of types) {
      const sz = t.resources.reduce((n, r) => n + r.length, 0);
      console.log(`  ${t.typeName.padEnd(4)} (${t.typeHex})  ` +
        `${String(t.resources.length).padStart(4)} resources  ${sz} bytes`);
    }
  } else if (cmd === 'list') {
    const list = args[1] ? [findType(types, args[1])].filter(Boolean) : types;
    for (const t of list)
      for (const r of t.resources)
        console.log(`${t.typeName}  ${String(r.id).padStart(6)}  ` +
          `${String(r.length).padStart(8)}B  ${r.name ?? ''}`);
  } else if (cmd === 'extract') {
    if (!outDir) throw new Error('extract requires -o <dir>');
    const list = args[1] ? [findType(types, args[1])].filter(Boolean) : types;
    let n = 0;
    for (const t of list) {
      const dir = path.join(outDir, t.typeHex + '_' +
        t.typeName.replace(/[^\x20-\x7e]/g, '_').trim());
      fs.mkdirSync(dir, { recursive: true });
      for (const r of t.resources) {
        const safe = r.name ? '_' + r.name.replace(/[^\w-]/g, '_') : '';
        fs.writeFileSync(path.join(dir, `${r.id}${safe}.bin`), r.data());
        n++;
      }
    }
    console.log(`extracted ${n} resources to ${outDir}`);
  } else if (cmd === 'decode') {
    const [, typeArg, idArg] = args;
    if (!schemaPath) throw new Error('decode requires --schema <schema.json>');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const t = findType(types, typeArg);
    if (!t) throw new Error(`type ${typeArg} not present`);
    const r = t.resources.find(r => r.id === +idArg);
    if (!r) throw new Error(`${typeArg} ${idArg} not found`);
    const rec = decodeRecord(r.data(), schema);
    if (rec.__schemaBytes !== rec.__recordBytes)
      console.error(`⚠ schema covers ${rec.__schemaBytes}B but record is ` +
        `${rec.__recordBytes}B — layout is wrong or partial, verify against the Bible`);
    console.log(JSON.stringify({ id: r.id, name: r.name, ...rec }, null, 2));
  } else if (cmd === 'strings') {
    const t = findType(types, 'hex:53545223');
    const r = t && t.resources.find(r => r.id === +args[1]);
    if (!r) throw new Error(`STR# ${args[1]} not found`);
    decodeStrList(r.data()).forEach((s, i) => console.log(`${i}\t${s}`));
  } else {
    throw new Error(`unknown command '${cmd}'`);
  }
}

module.exports = {
  loadFork, parseFork, findType, resolveType, decodeRecord, decodeStrList,
  buildFork, macRomanToString, stringToMacRoman,
};

if (require.main === module) {
  try { main(); } catch (e) { console.error('error:', e.message); process.exit(1); }
}
