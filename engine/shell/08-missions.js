/*
 * engine/shell/08-missions.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ================= missions (spec: "Missions") ================= */

const misns = DATA.types.misn;
const govts = DATA.types.govt;
const pers = DATA.types.pers || {};       // named characters (ship-offered missions)
const MISN_ALL = params.has('allmissions'); // test: ignore AvailRandom roll
const allSpobs = () => Object.entries(DATA.types.spob).map(([id, p]) => ({ id: +id, ...p }));
const spobById = id => DATA.types.spob[id];
const systOfSpob = p => p && systs[p.System];
const bitReq = (v, want) => { // AvailBitSet-style code check
  if (v < 0) return true;
  if (v >= 1000) return !missionBits[v - 1000];
  return !!missionBits[v];
};
function setBitCode(v) { // CompBitSet-style: 0-511 set, 1000-1511 clear
  if (v == null || v < 0) return;      // classic misn lacks some Nova bit fields
  if (v >= 1000) missionBits[v - 1000] = 0; else missionBits[v] = 1;
}
const field = (m, k, dflt = -1) => (m[k] == null ? dflt : m[k]); // classic vs Nova

// govt relations (from $sem flags we don't have allies as data; use gövt Ally/Enemy)
function govtAllies(g) { const r = govts[g]; return r ? [r.Ally].filter(a => a >= 128) : []; }
function govtEnemies(g) { const r = govts[g]; return r ? [r.Enemy].filter(a => a >= 128) : []; }

/* ---- legal record & combat rating (spec: "Legal record") ---- */
// Player's legal record with a govt, defaulting to the govt's InitialRec.
function legalOf(g) {
  if (g < 128) g = 128;                       // independent systems use govt 128
  if (reputation[g] != null) return reputation[g];
  return govts[g] ? govts[g].InitialRec : 0;
}
// STR# 134 status label, scaled by the govt's crime tolerance (bible App. II:
// enough good/evil to equal CrimeTol counts as 1 unit).
const EVIL_STEPS = [[4096, 'Galactic Scourge'], [1024, 'Prime Evil'], [256, 'Public Enemy'],
  [64, 'Fugitive'], [16, 'Felon'], [4, 'Criminal'], [1, 'Offender']];
const GOOD_STEPS = [[4096, 'Honored Leader'], [1024, 'Pillar of Society'], [256, 'Role Model'],
  [64, 'Upstanding Citizen'], [16, 'Good Egg'], [4, 'Decent Individual']];
function legalStatus(g) {
  if (g < 128) g = 128;
  const rec = govts[g]; if (!rec) return 'Clean';
  const v = legalOf(g) / Math.max(rec.CrimeTol, 1);
  if (v <= -1) for (const [t, label] of EVIL_STEPS) if (-v >= t) return label;
  if (v >= 4)  for (const [t, label] of GOOD_STEPS) if (v >= t) return label;
  return 'Clean';
}
function isCriminalWith(g) { // over the crime-tolerance threshold → warships attack
  if (g < 128) g = 128;
  const rec = govts[g]; if (!rec) return false;
  return legalOf(g) <= -Math.max(rec.CrimeTol, 1);
}
// Combat rating from total crew destroyed (bible App. I / STR# 138).
const RATING_STEPS = [[25600, 10], [12800, 9], [6400, 8], [3200, 7], [1600, 6],
  [800, 5], [400, 4], [200, 3], [100, 2], [1, 1], [0, 0]];
function combatRating() {
  for (const [t, idx] of RATING_STEPS) if (S.kills >= t)
    return DATA.strings[138].list[idx] || 'Harmless';
  return 'Harmless';
}

/* Resolve an AvailStel/TravelStel/ReturnStel code to a concrete spob id.
 * `here` is the spob the mission is being offered/accepted at. Returns a
 * spob id, or null if unresolvable. */
function resolveStel(code, here) {
  const inhabited = () => allSpobs().filter(p => p.$sem && !p.$sem.uninhabited && p.$sem.canLand);
  const uninhab = () => allSpobs().filter(p => p.$sem && p.$sem.uninhabited);
  const pick = arr => arr.length ? arr[Math.floor(Math.random() * arr.length)].id : null;
  if (code === -1) return null;              // no specific dest / any (caller decides)
  if (code === -2) return pick(inhabited());
  if (code === -3) return pick(uninhab());
  if (code === -4) return here ? here.id : null;
  if (code >= 128 && code <= 1627) return spobById(code) ? code : null;
  const govtPick = (g, filter) => pick(inhabited().filter(p => filter(p.Govt, g)));
  if (code >= 9999 && code <= 10127) return govtPick(code - 9999, (pg, g) => pg === g);
  if (code >= 15000 && code <= 15127) return govtPick(code - 15000, (pg, g) => govtAllies(g).includes(pg));
  if (code >= 20000 && code <= 20127) return govtPick(code - 20000, (pg, g) => pg !== g);
  if (code >= 25000 && code <= 25127) return govtPick(code - 25000, (pg, g) => govtEnemies(g).includes(pg));
  return null;
}

/* Does mission m's AvailStel match the spob `p`? */
function availStelMatch(code, p) {
  if (code === -1) return p.$sem && !p.$sem.uninhabited && p.$sem.canLand;
  if (code >= 128 && code <= 1627) return p.id === code;
  const g = c => code - c;
  if (code >= 9999 && code <= 10127) return p.Govt === g(9999);
  if (code >= 15000 && code <= 15127) return govtAllies(g(15000)).includes(p.Govt);
  if (code >= 20000 && code <= 20127) return p.Govt !== g(20000);
  if (code >= 25000 && code <= 25127) return govtEnemies(g(25000)).includes(p.Govt);
  return false;
}

/* Which goal types can we actually complete? Others aren't offered. */
function goalSupported(m) {
  if (m.ShipCount > 0 && m.ShipGoal >= 0) return [0, 1, 2, 3, 4, 5, 6].includes(m.ShipGoal);
  return true; // cargo delivery / plain go-to
}
function playerAI() { return ships[S.playerShipId].InherentAI; }

/* Is mission m available at spob p (in this system), for the given loc? */
function missionAvailable(m, p, loc) {
  if (m.AvailLoc !== loc) return false;
  if (!goalSupported(m)) return false;
  if (!availStelMatch(m.AvailStel, p)) return false;
  if (!bitReq(m.AvailBitSet)) return false;
  if (m.AvailBitClr >= 0 && missionBits[m.AvailBitClr]) return false;
  // combat rating gate: -1 ignore, else kills must be at least AvailRating
  if (m.AvailRating >= 0 && S.kills < m.AvailRating) return false;
  // legal-record gate (record with this spöb's govt): 0 ignore, positive =
  // at least this good, negative = at least this criminal, -32000 = must
  // have dominated this spöb.
  if (m.AvailRecord === -32000) { if (!dominated.has(p.id)) return false; }
  else if (m.AvailRecord > 0) { if (legalOf(p.Govt) < m.AvailRecord) return false; }
  else if (m.AvailRecord < 0) { if (legalOf(p.Govt) > m.AvailRecord) return false; }
  const ai = playerAI();
  if ((m.Flags & 0x2000) && ai <= 2) return false;
  if ((m.Flags & 0x4000) && ai >= 3) return false;
  const ast = m.AvailShipType;
  if (ast >= 128 && ast <= 255 && S.playerShipId !== ast) return false;
  if (ast >= 1128 && ast <= 1255 && S.playerShipId === ast - 1000) return false;
  if (ast >= 2128 && ast <= 2255 && ships[S.playerShipId].InherentGovt !== ast - 2000) return false;
  // AvailRandom rerolled per system arrival, cached on the spob-visit
  if (!MISN_ALL && m.AvailRandom > 0 && m.AvailRandom < 100) {
    S.availRandom[m.id] = S.availRandom[m.id] ?? (Math.random() * 100);
    if (S.availRandom[m.id] >= m.AvailRandom) return false;
  }
  return true;
}
S.availRandom = {}; // misnId -> rolled %, reset each system arrival

function offeredMissions(p, loc) {
  const out = [];
  for (const [id, m] of Object.entries(misns)) {
    if (S.activeMissions.some(a => a.id === +id)) continue; // already accepted (raw records have no id)
    if (missionAvailable(m, p, loc)) out.push({ id: +id, ...m });
  }
  // critical missions (Flags 0x1000) first, else by id
  out.sort((a, b) => (b.Flags & 0x1000) - (a.Flags & 0x1000) || a.id - b.id);
  return out;
}

/* A game "date": gameDay counts days since a fixed epoch. Classic EV shows
 * real calendar dates; we render day N of an in-fiction year for flavor. */
function formatDate(day) {
  const YEAR0 = 1177, DPY = 365;
  const y = YEAR0 + Math.floor(day / DPY);
  return `day ${day % DPY + 1}, NC ${y}`;
}

/* Substitute EV mission text placeholders from a resolved offer/mission A.
 * (See the bible's token table: <DST> <DSY> <RST> <RSY> <CT> <CQ> <DL> ...) */
function subst(text, A) {
  if (!text) return text;
  const stel = id => (id != null ? stelName(id) : null);
  const sysOf = id => { const p = spobById(id); const s = p && systs[p.System]; return s && s.name; };
  const map = {
    DST: (A && stel(A.travelStel)) || 'your destination',
    DSY: (A && sysOf(A.travelStel)) || 'the target system',
    RST: (A && stel(A.returnStel)) || (A && stel(A.travelStel)) || 'your destination',
    RSY: (A && sysOf(A.returnStel)) || (A && sysOf(A.travelStel)) || 'the target system',
    CT:  (A && A.cargoName) || 'cargo',
    // null-check, not truthiness: a legitimate quantity of 0 must render as
    // "0", not fall through to "the".
    CQ:  A && A.cargoQty != null ? String(A.cargoQty) : 'the',
    DL:  A && A.deadline != null ? formatDate(A.deadline) : 'the deadline',
    PN:  'Captain',
    PSN: ships[S.playerShipId] ? ships[S.playerShipId].name : 'your ship',
    OSN: (A && A.osn) || 'the ship',   // offering ship name (ship-offered missions)
  };
  return text.replace(/<(DST|DSY|RST|RSY|CT|CQ|DL|PN|PSN|OSN)>/g, (_, k) => map[k]);
}
const descText = (id, A) => {
  const d = DATA.types.desc[id];
  return d && d.Description ? subst(d.Description, A) : '';
};
/* Mission names carry tokens too (e.g. "Ferry Passengers to <DST>"). */
const misnName = (m, A) => subst(m.name, A);
const misnCargoName = m => {
  if (m.CargoType < 0) return null;
  if (m.CargoType === 1000) return DATA.strings[4000].list[Math.floor(Math.random() * 6)];
  return DATA.strings[4000].list[m.CargoType] || 'cargo';
};

/* Resolve a mission's random fields ONCE per offer, so the briefing shows
 * the real destination/cargo/deadline and accepting yields the same thing
 * (classic EV fixes these when the mission is first shown). Cached by id,
 * per system visit (cleared alongside availRandom in loadSystem). */
S.resolvedOffers = {};
/* id is passed explicitly: raw misn records (misns[id]) carry no `id`
 * field, so keying off m.id silently collapsed every offer onto one
 * cache slot — the bug where every briefing showed the same destination. */
function getOffer(id, here) {
  // Key by mission AND offering spöb: ReturnStel −4 ("return here") resolves
  // relative to `here`, so the same mission offered at a second spöb in the
  // same system must not reuse the first spöb's resolution.
  const key = `${id}@${here ? here.id : ''}`;
  if (S.resolvedOffers[key]) return S.resolvedOffers[key];
  const m = misns[id];
  const qty = m.CargoQty <= -2 ? Math.round(Math.abs(m.CargoQty) * (0.5 + Math.random()))
            : Math.max(m.CargoQty, 0);
  const o = {
    id,
    travelStel: resolveStel(m.TravelStel, here),
    returnStel: m.ReturnStel === -1 ? null : resolveStel(m.ReturnStel, here),
    cargoName: misnCargoName(m),
    cargoQty: qty,
    deadline: m.TimeLimit > 0 ? S.gameDay + m.TimeLimit : null,
  };
  S.resolvedOffers[key] = o;
  return o;
}

/* ---------- përs (named characters) & ship-offered missions ----------
 * A mïsn with AvailLoc 2 is carried by a përs ship (bible): you hail the
 * character and it offers its LinkMission. See spec "Ship-offered missions". */
const PF = { GRUDGE: 0x0001, REPLACE: 0x0040, DEACTIVATE: 0x0100, ONBOARD: 0x0200,
             LEAVE: 0x0800, NOT_WIMPY: 0x1000, NOT_BEEFY: 0x2000, NOT_WARSHIP: 0x4000 };

/* Does a përs's LinkSyst permit `systId`? Mirrors availStelMatch's govt ranges;
 * an unrecognized encoding falls through to "allowed" so a character isn't
 * silently lost. */
function linkSystMatches(ls, systId) {
  if (ls == null || ls === -1) return true;              // any system
  if (ls >= 128 && ls <= 1127) return ls === systId;     // a specific system
  const sy = systs[systId], pg = sy ? sy.Govt : -1;
  if (ls >= 9999  && ls <= 10127) return pg === ls - 9999;
  if (ls >= 15000 && ls <= 15127) return govtAllies(ls - 15000).includes(pg);
  if (ls >= 20000 && ls <= 20127) return pg !== ls - 20000;
  if (ls >= 25000 && ls <= 25127) return govtEnemies(ls - 25000).includes(pg);
  return true;
}

/* A representative inhabited spöb of the current system, for evaluating a
 * ship-offered mission's spöb-relative gates (AvailStel/AvailRecord). */
function systemSpob() {
  return spobs.find(s => s.$sem && !s.$sem.uninhabited && s.$sem.canLand) || spobs[0]
    || { id: -1, Govt: systemGovt(), System: SYSTEM_ID, $sem: { canLand: true, uninhabited: false } };
}

/* Is a ship-offered mission currently available and not already taken? */
function shipMissionAvailable(id) {
  const m = misns[id];
  if (!m || m.AvailLoc !== 2) return false;
  if (S.activeMissions.some(a => a.id === id)) return false;
  return missionAvailable({ ...m, id }, systemSpob(), 2);
}

/* Player's current ship class excluded by the përs's don't-offer flags? */
function persOffersToPlayer(pr) {
  const ai = playerAI();
  if ((pr.Flags & PF.NOT_WIMPY) && ai === 1) return false;
  if ((pr.Flags & PF.NOT_BEEFY) && ai === 2) return false;
  if ((pr.Flags & PF.NOT_WARSHIP) && ai >= 3) return false;
  return true;
}

/* Would this përs offer a mission here and now? (Spawn-time gate — the
 * player-ship-class filter is applied later, at hail time.) */
function persEligible(id) {
  const pr = pers[id];
  if (!pr || persDone.has(+id) || persGrudge.has(+id) || !ships[pr.ShipType]) return false;
  if (pr.MissionBit >= 0 && pr.MissionBit <= 511 && !missionBits[pr.MissionBit]) return false;
  if (!linkSystMatches(pr.LinkSyst, SYSTEM_ID)) return false;
  return pr.LinkMission >= 128 && shipMissionAvailable(pr.LinkMission);
}

/* Arm a përs ship: stock loadout, then any përs weapon override + shield mod. */
function armShipFromPers(e, pr) {
  armShip(e, ships[pr.ShipType]);
  if ([1, 2, 3, 4].some(i => pr['WeapType' + i] >= 128)) {   // the character's own guns
    e.weapons = []; e.pools = {}; e.poolCap = {};
    for (let i = 1; i <= 4; i++) {
      const t = pr['WeapType' + i];
      if (t >= 128 && weaps[t]) {
        e.weapons.push({ id: t, rec: weaps[t], n: Math.max(pr['WeapCount' + i], 1), cool: 0 });
        const pk = poolKey(weaps[t]);
        if (pk) {
          e.pools[pk] = (e.pools[pk] || 0) + Math.max(pr['AmmoLoad' + i], 0);
          e.poolCap[pk] = (e.poolCap[pk] || 0) + Math.max(pr['AmmoLoad' + i], 0);
        }
      }
    }
  }
  if (pr.ShieldMod) {                                        // % shield tweak (bible)
    e.shieldMax = Math.max(1, Math.round(e.shieldMax * (1 + pr.ShieldMod / 100)));
    e.shields = e.shieldMax;
  }
}

/* Bring a named character into the system if one belongs here and has a job.
 * Rare and at most one per visit — përs are special encounters. Positioned
 * relative to the system centre (like spawnAI), independent of the player. */
function maybeSpawnPers() {
  if (Math.random() > 0.35) return;
  const eligible = Object.keys(pers).map(Number).filter(persEligible);
  if (!eligible.length) return;
  const id = eligible[Math.floor(Math.random() * eligible.length)];
  const pr = pers[id];
  const a = Math.random() * Math.PI * 2, r = 600 + Math.random() * 1400;
  const e = EV.makeShip(ships[pr.ShipType], Math.cos(a) * r, Math.sin(a) * r, Math.random() * 360);
  e.shipId = pr.ShipType;
  e.govt = pr.Govt >= 128 ? pr.Govt : 0;
  e.aiType = pr.AIType >= 1 ? pr.AIType : 1;
  e.booty = 0;
  e.target = spobs.length ? spobs[Math.floor(Math.random() * spobs.length)] : null;
  armShipFromPers(e, pr);
  e.isPers = true; e.persId = id; e.misnName = pr.name;
  e.misnLink = pr.LinkMission; e.persFlags = pr.Flags; e.commQuote = pr.CommQuote;
  e.warpIn = 18;
  S.aiShips.push(e);
}

/* Accept a mission at spob `here`: resolve destinations, load cargo,
 * spawn any special ships if their system is the current one. */
function acceptMission(id, here) {
  const m = misns[id];
  const offer = getOffer(id, here); // reuse what the briefing showed
  const A = {
    id, name: m.name,
    accepted: S.gameDay,
    travelStel: offer.travelStel,
    returnStel: offer.returnStel,
    cargoName: offer.cargoName, cargoQty: offer.cargoQty,
    cargoLoaded: false,
    pickupMode: m.PickupMode, dropoffMode: m.DropoffMode,
    shipGoal: m.ShipCount > 0 ? m.ShipGoal : -1,
    shipsLeft: m.ShipCount > 0 ? m.ShipCount : 0,
    shipTotal: m.ShipCount > 0 ? m.ShipCount : 0,
    shipSyst: m.ShipSyst, shipDude: m.ShipDude, shipBehav: m.ShipBehav, shipNameID: m.ShipNameID,
    observed: false,
    timeLimit: m.TimeLimit,
    deadline: offer.deadline,
  };
  // prepaid outfit (PayVal -30128-g)
  if (m.PayVal >= -30255 && m.PayVal <= -30128) {
    const oid = -m.PayVal - 30000;
    if (DATA.types.outf[oid]) { outfits[oid] = (outfits[oid] || 0) + 1; applyShipStats(); }
  }
  // cargo picked up at accept
  if (A.cargoName && A.pickupMode === 0) A.cargoLoaded = true;
  S.activeMissions.push(A);
  maybeSpawnMissionShips(A);
  showMsg(`Mission accepted: ${misnName(m, A)}`);
}

function abortMission(id) {
  const i = S.activeMissions.findIndex(a => a.id === id);
  if (i < 0) return;
  const m = misns[id];
  const A = S.activeMissions[i];
  if (m.Flags & 0x0040) adjustRep(m.CompGovt, -5 * m.CompReward); // abort reversal
  S.activeMissions.splice(i, 1);
  // clear its mission ships from the system
  S.aiShips = S.aiShips.filter(s => s.misnId !== id);
  showMsg(`Mission abandoned: ${misnName(m, A)}`);
}

function adjustRep(govt, amt) {
  if (govt < 0 || !amt) return;
  reputation[govt] = (reputation[govt] || 0) + amt;
}

/* Spawn a mission's special ships if their target system is the one we're
 * in (called on accept and on each system load). */
function maybeSpawnMissionShips(A) {
  if (A.shipGoal < 0 || A.shipsLeft <= 0) return;
  const sys = A.shipSyst;
  const inThisSystem =
    sys === -6 || sys === -1 ||                             // follow / initial
    (sys >= 128 && sys <= 1127 && sys === SYSTEM_ID) ||
    (A.travelStel && systOfSpob(spobById(A.travelStel)) && sys === -3 &&
       spobById(A.travelStel).System === SYSTEM_ID) ||
    (A.returnStel && sys === -4 && spobById(A.returnStel).System === SYSTEM_ID);
  if (!inThisSystem) return;
  if (S.aiShips.some(s => s.misnId === A.id)) return; // already present
  const dude = dudes[A.shipDude];
  if (!dude) return;
  for (let i = 0; i < A.shipsLeft; i++) {
    const shipId = weighted(dudeShipPairs(dude));
    if (shipId == null) continue;
    const a = Math.random() * Math.PI * 2, r = 900 + Math.random() * 700;
    const e = EV.makeShip(ships[shipId], player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, Math.random() * 360);
    e.shipId = shipId; e.govt = dude.Govt; e.aiType = 3;
    e.booty = dude.Booty || 0; // boardable mission ships plunder like any other
    e.misnId = A.id;
    e.misnGoal = A.shipGoal;
    e.target = spobs.length ? spobs[Math.floor(Math.random() * spobs.length)] : null;
    armShip(e, ships[shipId]);
    // goal-specific setup (spec: "Mission ship goals")
    if (A.shipGoal === 5) { e.disabled = true; e.shields = 0; } // Rescue: start disabled
    if (A.shipGoal === 3) {                                    // Escort: protect, head out
      e.escort = true; e.aiType = 1;                          // flee-style: run for the exit
    } else if (A.shipBehav === 0 || A.shipBehav === 10) {
      e.hostile = true;                                       // attack player
    }
    if (A.shipNameID >= 128 && DATA.strings[A.shipNameID])
      e.misnName = DATA.strings[A.shipNameID].list[i % DATA.strings[A.shipNameID].list.length];
    S.aiShips.push(e);
  }
}
function dudeShipPairs(dude) {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const s = dude['ShipTypes' + i], w = dude['Prob' + i];
    if (s >= 128 && ships[s] && w > 0) out.push([s, w]);
  }
  return out;
}

/* Called when a mission ship is destroyed (from hitShip). */
function onMissionShipDestroyed(s) {
  const A = S.activeMissions.find(a => a.id === s.misnId);
  if (!A) return;
  switch (A.shipGoal) {
    case 3: // escort: any loss fails the mission
      A.escortFailed = true;
      showMsg(`${misnName(misns[A.id], A)}: escort lost — mission failed.`);
      return;
    case 1: // disable: a target already disabled (counted) is fine and must
            // not be counted twice; destroying one that wasn't disabled fails
      if (!s.misnCounted) A.captureLost = true;
      return;
    case 2: case 5: // board/rescue: the target must be boarded, not killed
      A.captureLost = true;
      return;
    default: // destroy (0) / chase-off (6): count it down
      A.shipsLeft--;
      if (A.shipsLeft <= 0)
        showMsg(`${misnName(misns[A.id], A)}: objective complete — return for payment.`);
  }
}

/* Called when a mission ship becomes disabled (from hitShip). Disable goal
 * counts it done; Board/Rescue now allow boarding. */
function onMissionShipDisabled(s) {
  const A = S.activeMissions.find(a => a.id === s.misnId);
  if (!A) return;
  if (A.shipGoal === 1) { // Disable but don't destroy
    if (!s.misnCounted) { s.misnCounted = true; A.shipsLeft--; }
    if (A.shipsLeft <= 0) showMsg(`${misnName(misns[A.id], A)}: targets disabled — return for payment.`);
  } else if (A.shipGoal === 2) {
    showMsg(`Target disabled — approach and press B to board.`);
  }
}

/* Board the nearest disabled ship (spec: "Boarding"). B key. Mission
 * board/rescue targets count toward the goal; any other disabled ship is
 * plundered for cargo (a crime against its government). */
function boardTarget() {
  if (S.landedAt || S.gameOver || hailOpen) return;
  let best = null, bd = 50;
  for (const s of S.aiShips) {
    if (!s.disabled || s.deathT >= 0 || s.looted) continue; // looted ships are done
    const d = Math.hypot(s.x - player.x, s.y - player.y);
    if (d < bd) { bd = d; best = s; }
  }
  if (!best) { showMsg('No disabled ship in boarding range.'); return; }
  if (Math.hypot(player.vx, player.vy) > EV.LAND_SPEED * 2) { showMsg('Slow down to board.'); return; }
  const A = (best.misnGoal === 2 || best.misnGoal === 5)
    ? S.activeMissions.find(a => a.id === best.misnId) : null;
  playSnd(390, 0.7); // Airlock — the boarding sound
  if (A) { // mission boarding: complete the objective, no plunder dialog
    S.aiShips.splice(S.aiShips.indexOf(best), 1);
    if (best === S.shipTarget) S.shipTarget = null;
    checkDefenseCleared(best.defOf, best);
    A.shipsLeft--;
    showMsg(A.shipsLeft > 0
      ? `${misnName(misns[A.id], A)}: boarded (${A.shipsLeft} to go).`
      : `${misnName(misns[A.id], A)}: objective complete — return for payment.`);
    return;
  }
  openHail('board', best); // non-mission: the boarding dialog (loot / capture)
}

/* ---- boarding a disabled ship (spec: "Boarding") ----
 * Effective crew for capture odds: the ship's own crew plus any Marines
 * outfit (oütf ModType 25 adds ModVal to the crew complement, per bible). */
function playerCrew() {
  let c = ships[S.playerShipId].Crew || 1;
  for (const [oid, n] of Object.entries(outfits)) {
    const o = DATA.types.outf[oid];
    if (o && o.$sem && o.$sem.modType === 'marines') c += (o.ModVal || 0) * (n || 0);
  }
  return c;
}
const captureOdds = s => { const my = playerCrew(), th = ships[s.shipId].Crew || 1; return my / (my + th); };

function lootVessel() {
  hailClick();
  const s = hailTarget.obj, booty = s.booty || 0, rec = ships[s.shipId];
  const got = [];
  if (booty & 0x40) { // Money — a slice of the hull's purchase price (bible)
    const money = Math.max(200, Math.round((rec.Cost || 0) * (0.03 + Math.random() * 0.07)));
    S.credits += money; got.push(`${money.toLocaleString('en-US')} cr`);
  }
  let free = holds - cargoUsed();          // commodity flags 0x01..0x20 → the six goods
  let noRoom = false;
  for (let i = 0; i < 6; i++) if (booty & (1 << i)) {
    if (free <= 0) { noRoom = true; continue; } // goods aboard, but no hold space
    const take = Math.min(1 + Math.floor(Math.random() * 4), free);
    cargo[COMMODITIES[i]] += take; free -= take; got.push(`${take}t ${cargoNames[i]}`);
  }
  s.looted = true;                          // stays disabled but no longer boardable
  commitCrime(s.govt, penaltyOf(s.govt, 'BoardPenalty'));
  checkDefenseCleared(s.defOf, s);
  hailTarget.mode = 'result';
  hailTarget.said = got.length ? `You strip the hold — ${got.join(', ')}.`
    : noRoom ? 'Cargo aboard, but your hold is full — nothing you can carry.'
    : 'The hold is bare.';
  renderHail();
}

function captureVessel() {
  hailClick();
  const s = hailTarget.obj;
  commitCrime(s.govt, penaltyOf(s.govt, 'BoardPenalty'));
  if (Math.random() < captureOdds(s)) {
    // Seized. Offer the classic choice — fly the prize yourself, or fold it
    // into your fleet — resolved by the player's pick below. The ship stays
    // put (the sim is paused while the boarding dialog is up).
    hailTarget.mode = 'captured';
    hailTarget.said = `Your boarding party seizes the ${ships[s.shipId].name}!`;
    playSnd(150, 0.5);
  } else {
    hailTarget.mode = 'result';
    hailTarget.said = 'The crew repel your party and scuttle the ship!';
    beginDestruction(s);                    // failed capture → self-destruct
    checkDefenseCleared(s.defOf, s);
  }
  renderHail();
}

/* Capture outcome 1: transfer to the prize; your old command stays with you
 * as an escort (per the original — you don't abandon the ship, it joins you). */
function takeCapturedShip() {
  hailClick();
  const s = hailTarget.obj;
  const defOf = s.defOf;                     // read before takeCommand removes s
  const oldShip = S.playerShipId, oldName = shipName;
  takeCommand(s);                            // switch to the captured hull
  const room = escorts.length < MAX_ESCORTS; // is there a slot for the old ship?
  if (room) addEscort(oldShip, oldName);     // former command falls in as escort
  checkDefenseCleared(defOf, s);
  hailTarget.mode = 'result';
  hailTarget.said = room
    ? `You transfer to the ${ships[S.playerShipId].name}. Your old ship falls in as an escort.`
    : `You transfer to the ${ships[S.playerShipId].name}. Your fleet is full, so your old ship is left behind.`;
  renderHail();
}

/* Capture outcome 2: keep your ship; the prize joins your fleet as an escort. */
function escortCapturedShip() {
  hailClick();
  const s = hailTarget.obj;
  if (escorts.length >= MAX_ESCORTS) {       // hard cap — keep the choice open
    showMsg('Your fleet is already full — take command instead, or leave it.');
    return;
  }
  const i = S.aiShips.indexOf(s); if (i >= 0) S.aiShips.splice(i, 1);
  if (S.shipTarget === s) S.shipTarget = null;
  const name = s.misnName || ships[s.shipId].name;  // keep any custom display name
  addEscort(s.shipId, name);
  checkDefenseCleared(s.defOf, s);
  hailTarget.mode = 'result';
  hailTarget.said = `The ${name} joins your fleet as an escort.`;
  renderHail();
}

/* Take command of a captured hull: you abandon your old ship (and its outfits,
 * per classic) and fly the prize away, freshly repaired and fuelled. */
function takeCommand(s) {
  const i = S.aiShips.indexOf(s); if (i >= 0) S.aiShips.splice(i, 1);
  if (S.shipTarget === s) S.shipTarget = null;
  S.playerShipId = s.shipId; player.shipId = S.playerShipId;
  preloadSprites([spinOfShip(S.playerShipId)]); // ensure the new hull's sprite is ready
  player.x = s.x; player.y = s.y; player.heading = s.heading; player.vx = 0; player.vy = 0;
  player.deathT = -1; player.disabled = false;
  for (const k of Object.keys(outfits)) delete outfits[k]; // old ship & upgrades left behind
  applyShipStats();                         // arm the stock captured hull
  S.fuel = fuelMax;
  player.shields = player.shieldMax; player.armor = player.armorMax;
  for (const c of COMMODITIES) cargo[c] = Math.min(cargo[c], holds); // clamp to new hold
  while (cargoUsed() > holds) { const c = COMMODITIES.find(x => cargo[x] > 0); if (!c) break; cargo[c]--; }
}

/* An escort ship reached its destination safely. */
function onMissionEscortArrived(s) {
  const A = S.activeMissions.find(a => a.id === s.misnId);
  if (!A) return;
  if (!S.aiShips.some(x => x.misnId === A.id && x !== s))
    showMsg(`${misnName(misns[A.id], A)}: escort delivered — return for payment.`);
}
/* Escort goal met once all escort ships have arrived (none remain) unharmed. */
function escortArrived(A) {
  return A.shipGoal === 3 && !A.escortFailed &&
    !S.aiShips.some(s => s.misnId === A.id);
}

/* Goal met? (used at ReturnStel). */
function goalMet(A) {
  if (A.shipGoal === 0 || A.shipGoal === 6) return A.shipsLeft <= 0;
  if (A.shipGoal === 1) return A.shipsLeft <= 0 && !A.captureLost;
  if (A.shipGoal === 2 || A.shipGoal === 5) return A.shipsLeft <= 0 && !A.captureLost;
  if (A.shipGoal === 3) return escortArrived(A); // all escorts must arrive, not just survive
  if (A.shipGoal === 4) return A.observed;
  return true; // cargo / go-to: arriving at returnStel is the goal
}
/* An unwinnable goal (target killed / escort lost) should fail at ReturnStel
 * even without a time limit, rather than stranding the mission forever. */
function goalFailed(A) {
  return !!A.captureLost || !!A.escortFailed;
}

/* Handle landing on spob p for every active mission: cargo pickup/dropoff
 * at TravelStel, and completion/failure at ReturnStel. Returns dialog
 * chunks to append to the planet screen. */
function missionLandingEvents(p) {
  const notes = [];
  for (const A of [...S.activeMissions]) {
    const m = misns[A.id];
    // cargo pickup at TravelStel
    if (A.cargoName && !A.cargoLoaded && A.pickupMode === 1 && A.travelStel === p.id) {
      A.cargoLoaded = true;
      notes.push(descText(m.LoadCargText) || `Loaded ${A.cargoQty}t of ${A.cargoName}.`);
    }
    // cargo dropoff at TravelStel
    if (A.cargoName && A.cargoLoaded && A.dropoffMode === 0 && A.travelStel === p.id) {
      A.cargoLoaded = false;
      notes.push(descText(m.DropCargText, A) || `Delivered ${A.cargoQty}t of ${A.cargoName}.`);
    }
    // completion / failure at ReturnStel
    const ret = A.returnStel != null ? A.returnStel : (A.travelStel === p.id ? p.id : null);
    const isReturn = (A.returnStel != null && A.returnStel === p.id) ||
                     (A.returnStel == null && A.travelStel === p.id);
    if (isReturn) {
      const expired = A.timeLimit > 0 && S.gameDay - A.accepted > A.timeLimit;
      if (!expired && !goalFailed(A) && goalMet(A)) {
        notes.push(descText(m.CompText, A) || `Mission complete: ${misnName(m, A)}.`);
        payMission(m);
        setBitCode(m.CompBitSet); setBitCode(m.CompBitSet2); setBitCode(m.CompBitSet4);
        adjustRep(m.CompGovt, m.CompReward);
        removeMission(A.id);
      } else if (expired || goalFailed(A) || m.CanAbort) {
        notes.push(descText(m.FailText, A) || `Mission failed: ${misnName(m, A)}.`);
        setBitCode(m.FailBitSet); setBitCode(m.FailBitSet2);
        adjustRep(m.CompGovt, -Math.round(m.CompReward / 2));
        removeMission(A.id);
      }
    }
  }
  return notes;
}
function removeMission(id) {
  S.activeMissions = S.activeMissions.filter(a => a.id !== id);
  S.aiShips = S.aiShips.filter(s => s.misnId !== id);
}
function checkExpiredMissions() {
  for (const A of [...S.activeMissions]) {
    if (A.timeLimit > 0 && S.gameDay - A.accepted > A.timeLimit) {
      const m = misns[A.id];
      setBitCode(m.FailBitSet); setBitCode(m.FailBitSet2);
      adjustRep(m.CompGovt, -Math.round(m.CompReward / 2));
      removeMission(A.id);
      showMsg(`Mission failed (out of time): ${misnName(misns[A.id], A)}`);
    }
  }
}
/* I in flight: briefing for the active missions (QuickBrief). */
function showMissionBriefing() {
  if (!S.activeMissions.length) { showMsg('No active missions.'); return; }
  const lines = S.activeMissions.map(a => {
    const destId = a.travelStel != null ? a.travelStel : a.returnStel;
    const dest = destId != null
      ? `${stelName(destId)}${systOfSpob(spobById(destId)) ? ' (' + systOfSpob(spobById(destId)).name + ')' : ''}`
      : '—';
    const days = a.timeLimit > 0 ? `, ${Math.max(0, a.timeLimit - (S.gameDay - a.accepted))}d left` : '';
    const goal = a.shipsLeft > 0 ? `${a.shipsLeft} ships remain` :
                 a.cargoName ? `deliver ${a.cargoQty}t ${a.cargoName}` : `go to ${dest}`;
    return `${a.name}: ${goal} → ${dest}${days}`;
  });
  showMsg(lines.join('  |  '));
}
function payMission(m) {
  const v = m.PayVal;
  if (v > 0) S.credits += v;
  else if (v >= -20255 && v <= -20128) { const oid = -v - 20000; if (DATA.types.outf[oid]) { outfits[oid] = (outfits[oid] || 0) + 1; applyShipStats(); } }
  else if (v >= -40099 && v <= -40001) S.credits = Math.round(S.credits * (1 - (-v - 40000) / 100));
  // -10128..-10255 clean legal record: reputation reset with that govt
  else if (v >= -10255 && v <= -10128) reputation[-v - 10000] = Math.max(0, reputation[-v - 10000] || 0);
}

/* ---- mission bar / computer dialog ---- */

let selMisnId = null;
function stelName(id) { const p = spobById(id); return p && p.name ? p.name : (id != null ? 'stellar ' + id : '—'); }

function renderMissionBoard(loc, topHtml = '') { // loc 0 = computer, 1 = bar
  const p = S.landedAt;
  const offers = offeredMissions(p, loc);
  const active = S.activeMissions;
  if (selMisnId == null || !offers.some(o => o.id === selMisnId))
    selMisnId = offers.length ? offers[0].id : null;
  const sel = selMisnId != null ? misns[selMisnId] : null;

  const listItems = [];
  if (active.length) {
    listItems.push(html`<div class="meta" style="margin:0 0 4px">Active missions</div>`);
    for (const a of active) {
      const days = a.timeLimit > 0 ? html` <span class="sub">(${Math.max(0, a.timeLimit - (S.gameDay - a.accepted))}d left)</span>` : '';
      listItems.push(html`<div class="row" style="color:#98c379">${misnName(misns[a.id], a)}${days}</div>`);
    }
    listItems.push(html`<hr style="border-color:#26304a;margin:8px 0">`);
  }
  listItems.push(html`<div class="meta" style="margin:0 0 4px">Available here (${offers.length})</div>`);
  if (!offers.length) listItems.push(html`<div class="sub">Nothing right now.</div>`);
  for (const o of offers)
    listItems.push(html`<div class="row" style="cursor:pointer;color:${o.id === selMisnId ? '#ffd479' : '#cfd6e4'}"
      onclick="selMisnId=${o.id};refreshView()">${misnName(o, getOffer(o.id, p))}</div>`);
  const list = html`<div style="flex:1;min-width:210px;max-height:340px;overflow-y:auto">${listItems}</div>`;

  let paneBody;
  if (sel) {
    const offer = getOffer(selMisnId, p);                // resolved once, stable
    const brief = descText(sel.BriefText, offer) || descText(sel.QuickBrief, offer)
      || 'No further details are offered.';
    const pay = sel.PayVal > 0 ? `${sel.PayVal.toLocaleString('en-US')} cr` :
      sel.PayVal <= -20128 && sel.PayVal >= -20255 ? 'an outfit' : 'see briefing';
    const goalTxt = ['Destroy the ships', null, 'Board', 'Escort', 'Observe', 'Rescue', 'Drive off the ships'][sel.ShipGoal] || null;
    // Delivery missions go to the destination; return-only missions come back here.
    const destId = offer.travelStel != null ? offer.travelStel : offer.returnStel;
    const destShown = destId != null
      ? `${stelName(destId)}${systOfSpob(spobById(destId)) ? ' (' + systOfSpob(spobById(destId)).name + ')' : ''}`
        + (destId === p.id ? ' — return here' : '')
      : 'no fixed destination';
    paneBody = html`<h3>${misnName(sel, offer)}</h3>
      <div class="desc" style="max-height:150px;overflow-y:auto">${brief}</div>
      <div class="row">Destination: <b>${destShown}</b></div>
      ${offer.cargoName && offer.cargoQty ? html`<div class="row">Cargo: <b>${offer.cargoQty}t ${offer.cargoName}</b></div>` : ''}
      ${sel.ShipCount > 0 && goalTxt ? html`<div class="row">Objective: <b>${goalTxt}</b> (${sel.ShipCount})</div>` : ''}
      ${offer.deadline != null ? html`<div class="row">Deliver by: <b>${formatDate(offer.deadline)}</b> <span class="sub">(${sel.TimeLimit} days)</span></div>` : ''}
      <div class="row">Pay: <b>${pay}</b></div>
      <div style="margin-top:10px">
        <button class="svc" onclick="doAcceptMission(${selMisnId})">Accept</button>
      </div>`;
  } else if (active.length) {
    paneBody = html`<div class="sub">Select an available mission, or check your active missions (press I in flight for the briefing).</div>`;
  } else {
    paneBody = html`<div class="sub">No missions are available here right now. Try the ${loc === 0 ? 'bar' : 'mission computer'}, or another world.</div>`;
  }
  const pane = html`<div style="flex:1.3;min-width:240px">${paneBody}</div>`;

  return html`<h2>${loc === 0 ? 'Mission Computer' : 'Spaceport Bar'}</h2>
     <div class="meta">${p.name}</div>${topHtml}
     <div class="shop">${list}${pane}</div>
     <div class="wallet">${S.credits.toLocaleString('en-US')} credits · cargo ${cargoUsed()}/${holds} tons · day ${S.gameDay}</div>
     <div style="margin-top:10px"><button class="svc" onclick="closeService()">Done (Esc)</button></div>`;
}

/* The bar hosts two boards — the mission BBS and the hire-escort dialog —
 * toggled by a pair of tabs (spec: "Escorts for hire"). */
let barTab = 'missions';
function barTabs() {
  const t = (k, label) => html`<button class="svc" onclick="barTab='${k}';refreshView()"${barTab === k ? ' disabled' : ''}>${label}</button>`;
  return html`<div style="margin:6px 0 2px">${t('missions', 'Missions')} ${t('hire', 'Hire Escorts')}</div>`;
}
function renderBar() { return barTab === 'hire' ? renderHireBoard() : renderMissionBoard(1, barTabs()); }
function renderComputer() { return renderMissionBoard(0); }

function renderHireBoard() {
  const p = S.landedAt;
  const totalUpkeep = escorts.reduce((n, e) => n + (e.upkeep || 0), 0);

  const fleetItems = [];
  if (!escorts.length) fleetItems.push(html`<div class="sub">You have no escorts yet.</div>`);
  for (const e of escorts) {
    const r = ships[e.shipId], kind = e.upkeep ? `~${e.upkeep.toLocaleString('en-US')} cr/jump` : 'captured';
    fleetItems.push(html`<div class="row" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span>${e.name} <span class="sub">${r ? r.name : ''} · ${kind}</span></span>
      <button class="svc" style="padding:2px 8px" onclick="dismissEscort(${e.id})">Dismiss</button></div>`);
  }
  if (totalUpkeep) fleetItems.push(html`<div class="row sub" style="margin-top:6px">Payroll: ~${totalUpkeep.toLocaleString('en-US')} cr / jump</div>`);
  const fleet = html`<div style="flex:1;min-width:210px;max-height:340px;overflow-y:auto">
    <div class="meta" style="margin:0 0 4px">Your fleet (${escorts.length}/${MAX_ESCORTS})</div>${fleetItems}</div>`;

  const hireItems = [];
  for (const id of HIRE_ROSTER) {
    const r = ships[id]; if (!r) continue;
    const fee = hireFee(r), up = upkeepOf(r);
    const full = escorts.length >= MAX_ESCORTS, afford = S.credits >= fee;
    const desc = shipClassDesc(id);
    hireItems.push(html`<div class="row" style="border-bottom:1px solid #26304a;padding:6px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b>${r.name}</b>
        <button class="svc" style="padding:2px 10px" onclick="hireEscort(${id})"${full || !afford ? ' disabled' : ''}>Hire</button>
      </div>
      <div class="sub">Fee ~${fee.toLocaleString('en-US')} cr · ~${up.toLocaleString('en-US')} cr/jump${
        full ? ' · fleet full' : !afford ? ' · can’t afford' : ''}</div>${
        desc ? html`<div class="sub" style="margin-top:3px;max-height:64px;overflow-y:auto">${desc}</div>` : ''}</div>`);
  }
  const hire = html`<div style="flex:1.3;min-width:240px;max-height:340px;overflow-y:auto">
    <div class="meta" style="margin:0 0 4px">Pilots for hire</div>${hireItems}</div>`;

  return html`<h2>Spaceport Bar</h2><div class="meta">${p.name}</div>${barTabs()}
     <div class="shop">${fleet}${hire}</div>
     <div class="wallet">${S.credits.toLocaleString('en-US')} credits · payroll ${totalUpkeep.toLocaleString('en-US')} cr/jump</div>
     <div style="margin-top:10px"><button class="svc" onclick="closeService()">Done (Esc)</button></div>`;
}

function doAcceptMission(id) {
  const m = misns[id];
  const need = (m.CargoType >= 0 && m.CargoQty && m.PickupMode === 0)
    ? (m.CargoQty <= -2 ? Math.abs(m.CargoQty) : m.CargoQty) : 0;
  if (need > holds - cargoUsed()) { showMsg('Not enough cargo space for this mission.'); return; }
  acceptMission(id, S.landedAt);
  savePilot(S.landedAt.id);
  refreshView();
}

let missionNotes = []; // dialog text queued by the last landing
function renderPlanetScreen() {
  const p = S.landedAt;
  const m = p.$sem || {};
  const desc = DATA.types.desc[p.id];
  const compOffers = offeredMissions(p, 0).length;
  const barOffers = offeredMissions(p, 1).length;
  const svc = ['commodityExchange', 'outfitter', 'shipyard', 'bar']
    .filter(k => m[k])
    .filter(k => k !== 'outfitter' || outfitterStock(p).length)  // flags lie on
    .filter(k => k !== 'shipyard' || shipyardStock(p).length)    // low-tech worlds
    .map(k => ({ commodityExchange: 'trade center', outfitter: 'outfitter',
      shipyard: 'shipyard', bar: 'bar' }[k])).join(' · ');
  // Landscape: CustPicID overrides; standard is PICT (10000 + Type) in EV
  // Titles — 34 landscapes matching the 34 stellar types. If a custom PICT
  // is missing from the data (e.g. Darkstar's 11001 in 1.0.5), fall back
  // to the standard, then give up.
  const scape = p.CustPicID >= 0 ? p.CustPicID : 10000 + p.Type;
  let out = '' + html`<img class="scape" src="evassets/titles/PICT_${scape}.png"
    data-fb="${10000 + p.Type}" onerror="
      if (this.dataset.fb && !this.src.endsWith('PICT_' + this.dataset.fb + '.png'))
        this.src = 'evassets/titles/PICT_' + this.dataset.fb + '.png';
      else this.remove()">`;
  out += html`<h2>${p.name}</h2>
    <div class="meta">${(m.stellarType || '').replace(/[()]/g, '')}${m.govt ? ' · ' + m.govt : ''}${svc ? ' · ' + svc : ''} · fuel topped up</div>
    <div class="desc">${desc && desc.Description ? desc.Description : ''}</div>`;
  // mission events from this landing (deliveries, completions) shown up top
  for (const note of missionNotes)
    out += html`<div class="desc" style="color:#98c379;border-left:2px solid #98c379;padding-left:8px">${note}</div>`;
  // services row — a shop with nothing to show doesn't get a button
  out += html`<div>${m.commodityExchange ? html`<button class="svc" onclick="openService('exchange')">Commodity Exchange</button>` : ''}${
    m.outfitter && outfitterStock(p).length ? html`<button class="svc" onclick="openService('outfitter')">Outfitter</button>` : ''}${
    m.shipyard && shipyardStock(p).length ? html`<button class="svc" onclick="openService('shipyard')">Shipyard</button>` : ''}${
    m.bar ? html`<button class="svc" onclick="openService('bar')">Spaceport Bar${barOffers ? ` (${barOffers})` : ''}</button>` : ''}${
    m.canLand && compOffers ? html`<button class="svc" onclick="openService('missioncomputer')">Mission BBS (${compOffers})</button>` : ''}</div>`;
  out += html`<div class="wallet"><b>${S.credits.toLocaleString('en-US')}</b> credits ·
    cargo ${cargoUsed()}/${holds} tons${S.activeMissions.length ? ` · ${S.activeMissions.length} active mission${S.activeMissions.length > 1 ? 's' : ''}` : ''}</div>
    <div class="hint">Take Off ▲ (top-right) — or press Esc</div>`;
  document.getElementById('landedCard').innerHTML = out;
}

/* L: select the nearest landable planet (brackets show it), or — if it's
 * already the target and we're in range and slow — land. Denials explain
 * themselves, like the original. */
function tryLand() {
  if (S.landedAt || S.jump) return;
  const p = (S.navTarget && (!S.navTarget.$sem || S.navTarget.$sem.canLand))
    ? S.navTarget : nearestLandable();
  if (!p) { showMsg('There is nowhere to land in this system.'); return; }
  if (S.navTarget !== p) {
    S.navTarget = p; showMsg(`Targeting ${p.name}.`);
    playSnd(150, 0.5); // target-select beep
    return;
  }
  if (distTo(p) >= EV.LAND_DIST) { showMsg(`Landing on ${p.name}: too far away.`); return; }
  if (Math.hypot(player.vx, player.vy) > EV.LAND_SPEED) {
    showMsg('You are moving too fast to land.'); return;
  }
  S.landedAt = p;
  player.vx = player.vy = 0;
  S.fuel = fuelMax; // landing refuels (spec)
  player.shields = player.shieldMax; // ...and repairs
  player.armor = player.armorMax;
  player.disabled = false;
  rebuildPlayerWeapons(); // rearm (simplification: ammo refills on landing)
  stopAllLoops();
  if (p.CustSndID >= 0) S.ambientSnd = loopSnd(p.CustSndID, 0.6); // planet ambient
  missionNotes = missionLandingEvents(p); // cargo pickup/dropoff, completion
  savePilot(p.id); // classic: the game saves when you land (after mission events)
  renderPlanetScreen();
  document.getElementById('landed').style.display = 'flex';
}
function takeOff() {
  if (!S.landedAt) return;
  if (activeView) closeService();
  const spob = S.landedAt;
  savePilot(spob.id);         // captures docked purchases/trades
  stopAllLoops();
  S.landedAt = null;
  missionNotes = [];
  document.getElementById('landed').style.display = 'none';
  // Rebuild the system fresh: the ships that were here when you landed are
  // gone; loadSystem respawns the ambient population and any mission ships.
  loadSystem(SYSTEM_ID);
  EV.placeAtTakeoff(player, spob); // then place on the pad (loadSystem doesn't move you)
  spawnEscorts();                  // launch the fleet alongside the player
}

