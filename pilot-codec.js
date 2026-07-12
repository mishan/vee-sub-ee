/*
 * pilot-codec.js — original EV Classic pilot-file decoding, shared by the Node
 * CLI (evpilot.js) and the in-browser importer (engine/shell/ui/pilot-import.js)
 * so the two can't drift.
 *
 * Pure and environment-agnostic: it reads bytes with DataView over a Uint8Array
 * (Node Buffers are Uint8Arrays too), so it needs no fs/Buffer and runs in the
 * browser once esbuild bundles it. Only MpïL (EV Classic/Override) is supported;
 * Nova (NpïL) uses a different key and struct and is rejected.
 *
 * Struct layout (decrypted MpïL 128), reverse-engineered from real pilots:
 *   0x0000 i16   docked spöb (−128)        0x0014 i16   date month
 *   0x0002 i16   ship type (−128)          0x0016 i16   date day
 *   0x0004 i16×6 cargo tons/commodity      0x0018 i16   date year
 *   0x001a i16×108 exploration per system  0x07ea i16×128 outfit counts (ID−128)
 *   0x08ea i16×108 legal record per system 0x11ba u32   credits
 *   0x124e misn×6 (382B each; see MISN)
 *   0x251a i16×72 escorts (−1 empty…)      0x25ac i16   kills → combat rating
 * Exploration values: ≤0 unexplored, 1 visited, 2 visited+landed (per the EV Nova
 * pilot-format doc, whose PlayerFileDataStruct field order EV Classic shares:
 * https://andrews05.github.io/evstuff/guides/pilotformat.txt).
 * The ship name is the name of MpïL resource 129; the pilot name is the file name.
 */
'use strict';

const KEY_CLASSIC = 0xabcd1234;
const KEY_NOVA = 0xb36a210f;
const u32 = (x) => x >>> 0;

// Standard EV commodity order; the second is Vₑ's own key set (01-state.js).
const COMMODITIES = ['Food', 'Industrial', 'Medical', 'Luxury Goods', 'Metal', 'Equipment'];
const VE_COMMODITIES = ['food', 'industrial', 'medical', 'luxury', 'metal', 'equipment'];
const OFF = { spob: 0x00, ship: 0x02, cargo: 0x04, month: 0x14, day: 0x16, year: 0x18 };
const EXPLORE = { off: 0x1a, count: 108 }; // per-system exploration: ≤0 none, 1 seen, 2 landed
// Outfit inventory: how many of each outfit the ship carries, indexed by outf
// ID−128. Unlike EV Nova (which splits itemCount/weapCount/ammo), Classic keeps
// weapons AND ammo in this one array too — a weapon's count sits at its outf ID,
// its ammo at the ammo outfit's ID (verified against real pilots).
const OUTFITS = { off: 0x07ea, count: 128 };
const LEGAL = { off: 0x08ea, count: 108 };
const ESCORTS = { off: 0x251a, count: 72 };
const CREDITS = 0x11ba;
const KILLS = 0x25ac;
// Per-mission slot (382B). Classic denormalizes the whole mission into the
// pilot — it never stores the misn resource id — so we fingerprint the id back
// (see reconstructMissions) from the copied fields and read the *rolled* dynamic
// values (dest/cargo) straight from the slot, exactly as the original engine
// runs off these copies. Offsets verified against real pilots + the misn schema:
//   dest 0x00 (travelStel−128)  cargoType 0x10 (resolved)  cargoQty 0x12 (rolled)
//   reward 0x26  active 0x36 (u8)  qk 0x3a (QuickBrief id)  comp 0x40 (CompText id)
//   flags 0x50 (Flags)  desc 0x7e (Pascal name string)
const MISN = {
  off: 0x124e,
  size: 0x17e,
  max: 6,
  dest: 0,
  cargoType: 0x10,
  cargoQty: 0x12,
  reward: 0x26,
  active: 0x36,
  qk: 0x3a,
  comp: 0x40,
  flags: 0x50,
  desc: 0x7e,
};
const MIN_LEN = KILLS + 2; // highest fixed offset read

// Andrew Welch's SimpleCrypt — symmetric XOR stream, in place over a Uint8Array.
function simpleCrypt(a, key = KEY_CLASSIC) {
  let k = u32(key);
  const words = a.length >>> 2;
  for (let i = 0; i < words; i++) {
    const o = i * 4;
    a[o] ^= (k >>> 24) & 0xff;
    a[o + 1] ^= (k >>> 16) & 0xff;
    a[o + 2] ^= (k >>> 8) & 0xff;
    a[o + 3] ^= k & 0xff;
    k = u32(u32(k - 0x21524111) ^ 0xdeadbeef);
  }
  const rem = a.length - words * 4;
  for (let j = 0; j < rem; j++) a[words * 4 + j] ^= (k >>> (24 - 8 * j)) & 0xff;
  return a;
}

// --- container unwrap: MacBinary / AppleDouble / raw resource fork → fork bytes
function looksLikeFork(a) {
  if (a.length < 16) return false;
  const d = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const dataOff = d.getUint32(0),
    mapOff = d.getUint32(4),
    dataLen = d.getUint32(8),
    mapLen = d.getUint32(12);
  return (
    dataOff >= 16 &&
    mapLen >= 30 &&
    dataOff + dataLen <= a.length &&
    mapOff + mapLen <= a.length &&
    mapOff >= dataOff + dataLen
  );
}
function unwrapFork(a) {
  const d = new DataView(a.buffer, a.byteOffset, a.byteLength);
  // MacBinary: header byte 0 + version bytes 74/82 zero, name length 1..63
  if (a.length >= 128 && a[0] === 0 && a[74] === 0 && a[82] === 0 && a[1] >= 1 && a[1] <= 63) {
    const dataLen = d.getUint32(83),
      rsrcLen = d.getUint32(87);
    const start = 128 + Math.ceil(dataLen / 128) * 128;
    if (rsrcLen > 0 && start + rsrcLen <= a.length) return a.subarray(start, start + rsrcLen);
  }
  // AppleDouble: magic 0x00051607, entry id 2 is the resource fork
  if (a.length >= 26 && d.getUint32(0) === 0x00051607) {
    const n = d.getUint16(24);
    for (let i = 0; i < n; i++) {
      const e = 26 + i * 12;
      if (e + 12 > a.length) break; // entry count lies — stop rather than overrun
      if (d.getUint32(e) === 2) {
        const off = d.getUint32(e + 4),
          len = d.getUint32(e + 8);
        if (off + len <= a.length) return a.subarray(off, off + len);
        break; // bogus offset/length — fall through to the clean error below
      }
    }
  }
  if (looksLikeFork(a)) return a;
  throw new Error(
    'Not a Mac resource fork (MacBinary, AppleDouble, or raw). Expand any .sit first.',
  );
}

// --- resource map parse → [{ bytes:[4], typeName, resources:[{id,name,data}] }]
function latin1(a) {
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return s;
}
function parseTypes(fork) {
  const d = new DataView(fork.buffer, fork.byteOffset, fork.byteLength);
  const dataOff = d.getUint32(0);
  const mapOff = d.getUint32(4);
  const typeListOff = mapOff + d.getUint16(mapOff + 24);
  const nameListOff = mapOff + d.getUint16(mapOff + 26);
  const nTypes = (d.getUint16(typeListOff) + 1) & 0xffff;
  const types = [];
  for (let t = 0; t < nTypes; t++) {
    const e = typeListOff + 2 + t * 8;
    const bytes = [fork[e], fork[e + 1], fork[e + 2], fork[e + 3]];
    const count = d.getUint16(e + 4) + 1;
    const refOff = typeListOff + d.getUint16(e + 6); // from type-list start
    const resources = [];
    for (let r = 0; r < count; r++) {
      const re = refOff + r * 12;
      const nameOff = d.getUint16(re + 2);
      const dOff = (fork[re + 5] << 16) | (fork[re + 6] << 8) | fork[re + 7];
      const len = d.getUint32(dataOff + dOff);
      const name =
        nameOff === 0xffff
          ? null
          : latin1(
              fork.subarray(
                nameListOff + nameOff + 1,
                nameListOff + nameOff + 1 + fork[nameListOff + nameOff],
              ),
            );
      resources.push({
        id: d.getInt16(re),
        name,
        data: fork.subarray(dataOff + dOff + 4, dataOff + dOff + 4 + len),
      });
    }
    types.push({ bytes, typeName: latin1(new Uint8Array(bytes)), resources });
  }
  return types;
}

// Locate + decrypt the pilot struct. `bytes` is the whole file (any container).
// Returns { d: DataView of decrypted MpïL 128, shipName } or throws.
function parsePilot(bytes) {
  const types = parseTypes(unwrapFork(bytes));
  // MpïL = [0x4d,0x70,0x95,0x4c]; Nova (NpïL) swaps the first byte to 0x4e. Match
  // all four bytes (incl. the MacRoman 'ï' 0x95) so a stray _p_L type can't hit.
  const is = (ty, b0) =>
    ty.bytes[0] === b0 && ty.bytes[1] === 0x70 && ty.bytes[2] === 0x95 && ty.bytes[3] === 0x4c;
  if (types.some((ty) => is(ty, 0x4e)))
    throw new Error('Nova (NpïL) pilots are not supported — only EV Classic / Override.');
  const mp = types.find((ty) => is(ty, 0x4d));
  if (!mp) throw new Error('Not an EV Classic pilot file (no MpïL resource).');
  const r128 = mp.resources.find((r) => r.id === 128);
  const r129 = mp.resources.find((r) => r.id === 129);
  if (!r128) throw new Error('Pilot file is missing its data resource.');
  const b = new Uint8Array(r128.data); // copy (Buffer.slice would be a view in Node)
  simpleCrypt(b);
  if (b.length < MIN_LEN) throw new Error(`Pilot data too short (${b.length} < ${MIN_LEN} bytes).`);
  return {
    d: new DataView(b.buffer, b.byteOffset, b.byteLength),
    shipName: r129 ? r129.name : null,
  };
}

const pilotNameOf = (filename) => filename.replace(/^\._/, '').replace(/\.(rsrc|bin)$/i, '');

// Pascal string (length byte + bytes) at `off`, MacRoman treated as latin1.
const pascalStr = (d, off) => {
  const n = d.getUint8(off);
  let s = '';
  for (let j = 0; j < n; j++) s += String.fromCharCode(d.getUint8(off + 1 + j));
  return s;
};

/* Recover a mission's resource id from the denormalized copy in its pilot slot.
 * Classic doesn't store the id, so we match the copied fields back to the misn
 * DB. Duplicate template resources (e.g. the three identical "Ferry Passengers"
 * missions) are interchangeable, so any match is correct. Tiers relax from a
 * strict all-fields match down to name-only, taking the first hit. */
function fingerprintMisn(misns, fp) {
  const ids = Object.keys(misns);
  const tiers = [
    (m) =>
      m.name === fp.name &&
      m.QuickBrief === fp.qk &&
      m.CompText === fp.comp &&
      m.Flags === fp.flags,
    (m) => m.name === fp.name && m.QuickBrief === fp.qk && m.CompText === fp.comp,
    (m) => m.QuickBrief === fp.qk && m.CompText === fp.comp && m.Flags === fp.flags,
    (m) => m.name === fp.name && m.Flags === fp.flags,
    (m) => m.name === fp.name,
  ];
  for (const test of tiers) {
    const hit = ids.filter((id) => test(misns[id]));
    if (hit.length) return +hit[0];
  }
  return null;
}

/* Rebuild the shell's live-mission objects (the `A` shape from 08-missions.js
 * acceptMission) from the pilot's active slots. Static gameplay fields come from
 * the recovered misn resource; the rolled/dynamic ones (destination, cargo) come
 * from the slot copy. Needs the game DB for the misn table + cargo names.
 *
 * Known approximations (not stored in the Classic slot, or offset not yet
 * mapped): `accepted` day, `deadline` (timed missions get a fresh full timer at
 * load), in-progress `cargoLoaded`/`shipsLeft`/`observed`, and `returnStel` for
 * return-here missions. Simple ferry/cargo/freight deliveries reconstruct fully;
 * combat/timed missions carry the right identity + payoff but reset their
 * progress counters. */
function reconstructMissions(d, DATA) {
  const misns = (DATA && DATA.types && DATA.types.misn) || {};
  const cargoNames = (DATA && DATA.strings && DATA.strings[4000] && DATA.strings[4000].list) || [];
  const out = [];
  for (let i = 0; i < MISN.max; i++) {
    const s = MISN.off + i * MISN.size;
    if (d.getUint8(s + MISN.active) !== 1) continue;
    const id = fingerprintMisn(misns, {
      name: pascalStr(d, s + MISN.desc),
      qk: d.getInt16(s + MISN.qk),
      comp: d.getInt16(s + MISN.comp),
      flags: d.getInt16(s + MISN.flags),
    });
    if (id == null) continue; // unidentifiable — skip rather than import a broken mission
    const m = misns[id];
    const dest = d.getInt16(s + MISN.dest) + 128;
    const cargoType = d.getInt16(s + MISN.cargoType);
    const cargoName = cargoType >= 0 ? cargoNames[cargoType] || 'cargo' : null;
    const hasShips = m.ShipCount > 0;
    out.push({
      id,
      name: m.name,
      accepted: 0,
      travelStel: dest >= 128 ? dest : null,
      returnStel: m.ReturnStel >= 128 ? m.ReturnStel : null,
      cargoName,
      cargoQty: d.getInt16(s + MISN.cargoQty),
      cargoLoaded: !!cargoName && m.PickupMode === 0,
      pickupMode: m.PickupMode,
      dropoffMode: m.DropoffMode,
      shipGoal: hasShips ? m.ShipGoal : -1,
      shipsLeft: hasShips ? m.ShipCount : 0,
      shipTotal: hasShips ? m.ShipCount : 0,
      shipSyst: m.ShipSyst,
      shipDude: m.ShipDude,
      shipBehav: m.ShipBehav,
      shipNameID: m.ShipNameID,
      observed: false,
      timeLimit: m.TimeLimit,
      deadline: null,
    });
  }
  return out;
}

/* Rich, human-readable decode of the mapped fields (used by the CLI `summary`). */
function readSummary(bytes, filename) {
  const { d, shipName } = parsePilot(bytes);
  const cargo = {};
  for (let i = 0; i < 6; i++) {
    const v = d.getInt16(OFF.cargo + 2 * i);
    if (v) cargo[COMMODITIES[i]] = v;
  }
  const escorts = [];
  for (let i = 0; i < ESCORTS.count; i++) {
    const v = d.getInt16(ESCORTS.off + 2 * i);
    if (v >= 0) escorts.push(v + 128);
  }
  const outfits = {};
  for (let i = 0; i < OUTFITS.count; i++) {
    const v = d.getInt16(OUTFITS.off + 2 * i);
    if (v) outfits[128 + i] = v;
  }
  const legalBySystem = {};
  for (let i = 0; i < LEGAL.count; i++) {
    const v = d.getInt16(LEGAL.off + 2 * i);
    if (v !== 0) legalBySystem[128 + i] = v;
  }
  const missions = [];
  for (let i = 0; i < MISN.max; i++) {
    const slot = MISN.off + i * MISN.size;
    if (d.getUint8(slot + MISN.active) !== 1) continue;
    missions.push({
      destSpob: d.getInt16(slot + MISN.dest) + 128,
      reward: d.getInt16(slot + MISN.reward),
      desc: pascalStr(d, slot + MISN.desc),
    });
  }
  return {
    pilotName: pilotNameOf(filename),
    shipName,
    dockedSpob: d.getInt16(OFF.spob) + 128,
    shipType: d.getInt16(OFF.ship) + 128,
    date: { year: d.getInt16(OFF.year), month: d.getInt16(OFF.month), day: d.getInt16(OFF.day) },
    credits: d.getUint32(CREDITS),
    kills: d.getInt16(KILLS),
    cargo,
    outfits,
    escorts,
    missions,
    legalBySystem,
  };
}

/* Convert a pilot file into a Vₑ save (the v2 localStorage blob). `DATA` is the
 * game DB (require('./evdata.json')): resolves the docked spöb to its system and
 * names escort hulls and reconstructs in-flight missions. Plot-bits and the
 * përs/domination flags (resource 129) aren't mapped yet, so they import empty —
 * but the pilot arrives with its real hull, outfits, cargo, credits, standing,
 * combat record, escorts and active missions, docked where it was saved. */
function toSave(bytes, filename, DATA) {
  const { d, shipName } = parsePilot(bytes);
  const dockedSpob = d.getInt16(OFF.spob) + 128;
  const spob = DATA.types.spob[dockedSpob];
  const syst = spob && spob.System >= 128 ? spob.System : 128;
  const cargo = Object.fromEntries(VE_COMMODITIES.map((k) => [k, 0]));
  for (let i = 0; i < 6; i++) cargo[VE_COMMODITIES[i]] = d.getInt16(OFF.cargo + 2 * i);
  // Outfit inventory: outf id -> count (the shell's `outfits` shape). Weapons and
  // ammo live in the same Classic array, so they carry over as their outf ids too.
  const outfits = {};
  for (let i = 0; i < OUTFITS.count; i++) {
    const v = d.getInt16(OUTFITS.off + 2 * i);
    if (v) outfits[128 + i] = v;
  }
  const rep = {};
  for (let i = 0; i < LEGAL.count; i++) {
    const v = d.getInt16(LEGAL.off + 2 * i);
    if (v !== 0) rep[128 + i] = v;
  }
  // Explored systems come from the real per-system exploration array — NOT from
  // which systems have a legal record. The two diverge both ways: legal changes
  // spread to systems you've never visited, and systems you visited cleanly keep
  // a 0 record. exploration[i] ≥ 1 means the player has been to system 128+i.
  const explored = [syst];
  for (let i = 0; i < EXPLORE.count; i++) {
    if (d.getInt16(EXPLORE.off + 2 * i) >= 1) explored.push(128 + i);
  }
  const escorts = [];
  for (let i = 0; i < ESCORTS.count; i++) {
    const v = d.getInt16(ESCORTS.off + 2 * i);
    if (v >= 0)
      escorts.push({
        id: escorts.length + 1,
        shipId: v + 128,
        name: (DATA.types.ship[v + 128] && DATA.types.ship[v + 128].name) || 'Escort',
      });
  }
  const year = d.getInt16(OFF.year),
    month = d.getInt16(OFF.month),
    day = d.getInt16(OFF.day);
  return {
    v: 2,
    syst,
    spob: dockedSpob,
    ship: d.getInt16(OFF.ship) + 128,
    credits: d.getUint32(CREDITS),
    cargo,
    outfits,
    explored: [...new Set(explored)],
    bits: [],
    day: 0,
    born: new Date(year - 250, month - 1, day).getTime(),
    rep,
    kills: d.getInt16(KILLS),
    missions: reconstructMissions(d, DATA),
    dominated: [],
    name: pilotNameOf(filename),
    shipName,
    strict: false,
    escorts,
    persDone: [],
    persGrudge: [],
  };
}

const API = {
  simpleCrypt,
  unwrapFork,
  parseTypes,
  parsePilot,
  readSummary,
  reconstructMissions,
  toSave,
  COMMODITIES,
  VE_COMMODITIES,
  MISN,
  KEY_CLASSIC,
  KEY_NOVA,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
