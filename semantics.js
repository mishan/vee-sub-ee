/*
 * semantics.js — Meaning for the raw fields that TMPL-generated schemas
 * decode. The schemas give field names and values; this module gives flag
 * bits, enums, and ID conventions.
 *
 * Source: "Escape Velocity Resource Bible" by Matt Burch (the EV Override
 * edition, archived at cytheraguides.com — local copy in EV_data/). Override
 * is the same engine family as classic EV 1.0.5; every table below has been
 * verified against classic data where possible (all 107 spöb flag values
 * conform to the price-nibble encoding, spöb Type 0–33 matches STR# 1100's
 * 34 stellar-type strings, wëap Guidance 99 = fighter bay is present in
 * classic data, etc.). Bits that Override added beyond classic will simply
 * never appear set in classic files.
 */

'use strict';

/* ---------------- spöb ---------------- */

const SPOB_FLAGS = {
  0x00000001: 'canLand',
  0x00000002: 'commodityExchange',
  0x00000004: 'outfitter',
  0x00000008: 'shipyard',
  0x00000010: 'station',        // else planet
  0x00000020: 'uninhabited',    // no traffic control
  0x00000040: 'bar',
};

// Commodity price levels live in nibbles 7..2 of spöb Flags (1/2/4 = low/med/high).
const COMMODITY_NIBBLES = [
  ['food', 7], ['industrial', 6], ['medical', 5],
  ['luxury', 4], ['metal', 3], ['equipment', 2],
];
const PRICE_LEVEL = { 0: null, 1: 'low', 2: 'medium', 4: 'high' };

function decodeSpobFlags(flags) {
  const f = flags >>> 0;
  const out = { prices: {} };
  for (const [bit, name] of Object.entries(SPOB_FLAGS)) out[name] = !!(f & bit);
  for (const [commodity, nibble] of COMMODITY_NIBBLES) {
    const lvl = PRICE_LEVEL[(f >>> (nibble * 4)) & 0xF];
    if (lvl === undefined) out.prices[commodity] = `invalid(${(f >>> (nibble * 4)) & 0xF})`;
    else if (lvl) out.prices[commodity] = lvl;
  }
  return out;
}

/* ---------------- gövt ---------------- */

const GOVT_FLAGS = {
  0x0001: 'xenophobic',               // warships attack everyone but allies
  0x0002: 'enforcesLawsEverywhere',   // attacks player-criminals in non-allied systems
  0x0004: 'alwaysAttacksPlayer',
  0x0010: 'retreatsAt25pctShields',
  0x0020: 'ignoredByGoodSamaritan',
  0x0040: 'neverAttacksPlayer',       // player's weapons can't hit them either
  0x0100: 'persNoEscapePod',
  0x0200: 'warshipsTakeBribes',
  0x0400: 'cannotHail',
  0x0800: 'startsDisabled',           // derelicts
  0x1000: 'plundersEnemies',
  0x2000: 'freightersTakeBribes',
  0x4000: 'planetsTakeBribes',
  0x8000: 'greedyBribes',             // demand more, planets always take bribes
};

/* ---------------- mïsn ---------------- */

const MISN_FLAGS = {
  0x0001: 'autoAborting',
  0x0002: 'noDestinationArrows',
  0x0004: 'cannotRefuse',
  0x0010: 'infiniteAuxShips',
  0x0020: 'removePrepaidOutfitOnFail',
  0x0040: 'abortReversal5xCompReward',
  0x0080: 'jettisonPenalty',          // ignored by engine
  0x0100: 'greenArrowInBriefing',
  0x0200: 'arrowOnShipSyst',
  0x1000: 'critical',                 // offered before others in the bar
  0x2000: 'notForCargoShips',         // player inherentAI 1-2
  0x4000: 'notForWarships',           // player inherentAI 3-4
};

/* ---------------- përs ---------------- */

const PERS_FLAGS = {
  0x0001: 'holdsGrudge',
  0x0002: 'escapePodAndAfterburner',
  0x0004: 'quoteOnlyOnGrudge',
  0x0008: 'quoteOnlyWhenLikesPlayer',
  0x0010: 'quoteOnlyOnAttack',
  0x0020: 'quoteOnlyWhenDisabled',
  0x0040: 'replaceShipOnLinkMission',
  0x0080: 'quoteOnce',
  0x0100: 'deactivateAfterLinkMission',
  0x0200: 'linkMissionOnBoard',
  0x0400: 'noQuoteIfLinkMissionUnavailable',
  0x0800: 'leaveAfterLinkMission',
  0x1000: 'notOfferedToWimpyFreighter',
  0x2000: 'notOfferedToBeefyFreighter',
  0x4000: 'notOfferedToWarship',
  0x8000: 'disasterInfoOnHail',
};

/* ---------------- enums ---------------- */

// Note: the Override bible marks guidance 2 "unused", but classic EV uses it:
// 1 = Torpedos, 2 = Missiles/Seeker Drones — two homing variants (different
// seeker/jamming behavior) that Override later merged into 1.
const GUIDANCE = {
  '-1': 'unguided', 0: 'beam', 1: 'homing', 2: 'homing2', 3: 'turretedBeam',
  4: 'turret', 5: 'freefallBomb', 6: 'rocket',
  7: 'frontQuadrantTurret', 8: 'rearQuadrantTurret',
  99: 'fighterBay',       // AmmoType is the shïp class ID
};

const MOD_TYPES = {
  1: 'weapon', 2: 'cargoSpace', 3: 'ammunition', 4: 'shieldCapacity',
  5: 'shieldRecharge', 6: 'armor', 7: 'accelBoost', 8: 'speedBoost',
  9: 'turnBoost', 10: 'ecm', 11: 'escapePod', 12: 'fuelCapacity',
  13: 'densityScanner', 14: 'iff', 15: 'afterburner', 16: 'map',
  17: 'cloakingDevice', 18: 'fuelScoop', 19: 'autoRefueller',
  20: 'autoEject', 21: 'cleanLegalRecord', 22: 'hyperspaceSpeedMod',
};

const AI_TYPES = { 1: 'wimpyTrader', 2: 'braveTrader', 3: 'warship', 4: 'interceptor' };

// Reserved spïn ID ranges (per resource bible).
const SPIN_BASES = { ship: 128, weapon: 200, stellar: 300, explosion: 400, box: 500 };

// STR# roles, straight from the resource names in EV Data.
const STRING_ROLES = {
  134: 'legalStatus', 138: 'combatRatings', 1100: 'stellarTypes',
  4000: 'cargoNames', 4001: 'cargoNamesLC', 4002: 'cargoAbbrev',
  4004: 'cargoBasePrices', 5000: 'outfitNames', 5001: 'shipyardNames',
  5002: 'shipLongNames', 6000: 'govtTransponders',
};

/* ---------------- decoding helpers ---------------- */

function flagNames(map, value) {
  const out = [];
  for (const [bit, name] of Object.entries(map)) if (value & bit) out.push(name);
  return out;
}

const ref = (db, type, id) => {
  const r = db.types[type] && db.types[type][id];
  return r ? r.name : null;
};

/*
 * decorate(db) — add a `$sem` object to every record in an evexport bundle.
 * Mutates and returns db. Raw fields are never touched.
 */
function decorate(db) {
  const stellarTypes = db.strings[1100] ? db.strings[1100].list : [];
  const each = (type, fn) => {
    for (const [id, r] of Object.entries(db.types[type] || {})) r.$sem = fn(r, +id);
  };

  each('spob', p => ({
    ...decodeSpobFlags(p.Flags),
    stellarType: stellarTypes[p.Type] || null,
    spinID: SPIN_BASES.stellar + p.Type,
    system: ref(db, 'syst', p.System),
    govt: ref(db, 'govt', p.Govt),
  }));
  each('syst', s => ({
    govt: ref(db, 'govt', s.Govt),
  }));
  each('govt', g => ({ flags: flagNames(GOVT_FLAGS, g.Flags) }));
  each('weap', w => ({
    guidance: GUIDANCE[w.Guidance] ?? `unknown(${w.Guidance})`,
    carriedShip: w.Guidance === 99 ? ref(db, 'ship', w.AmmoType) : undefined,
  }));
  each('outf', o => ({ modType: MOD_TYPES[o.ModType] ?? `unknown(${o.ModType})` }));
  each('dude', u => ({
    aiType: AI_TYPES[u.AIType] ?? `unknown(${u.AIType})`,
    govt: ref(db, 'govt', u.Govt),
  }));
  each('pers', p => ({
    aiType: AI_TYPES[p.AIType] ?? `unknown(${p.AIType})`,
    flags: flagNames(PERS_FLAGS, p.Flags),
    govt: ref(db, 'govt', p.Govt),
    ship: ref(db, 'ship', p.ShipType),
  }));
  each('misn', m => ({ flags: flagNames(MISN_FLAGS, m.Flags) }));
  each('ship', s => ({
    inherentAI: AI_TYPES[s.InherentAI] ?? `unknown(${s.InherentAI})`,
    inherentGovt: ref(db, 'govt', s.InherentGovt),
  }));
  return db;
}

module.exports = {
  SPOB_FLAGS, GOVT_FLAGS, MISN_FLAGS, PERS_FLAGS,
  GUIDANCE, MOD_TYPES, AI_TYPES, SPIN_BASES, STRING_ROLES, PRICE_LEVEL,
  decodeSpobFlags, flagNames, decorate,
};
