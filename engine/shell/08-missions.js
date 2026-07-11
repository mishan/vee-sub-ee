import {
  wallet,
  S,
  dominated,
  dudes,
  missionLog,
  outfits,
  params,
  legal,
  ships,
  showMsg,
  systs,
} from './01-state.js';
import { weighted } from './02-spawning.js';
import { applyShipStats, armShip, player } from './04-combat.js';
import { legalOf, applyGovtDelta, pardonGovt } from './13-legal.js';

/*
 * engine/shell/08-missions.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ================= missions (spec: "Missions") ================= */

export const misns = DATA.types.misn;
export const govts = DATA.types.govt;
export const pers = DATA.types.pers || {}; // named characters (ship-offered missions)
export const MISN_ALL = params.has('allmissions'); // test: ignore AvailRandom roll
export const allSpobs = () => Object.entries(DATA.types.spob).map(([id, p]) => ({ id: +id, ...p }));
export const spobById = (id) => DATA.types.spob[id];
export const systOfSpob = (p) => p && systs[p.System];
export const bitReq = (v) => {
  // AvailBitSet-style code check
  if (v < 0) return true;
  if (v >= 1000) return !missionLog.bit(v - 1000);
  return missionLog.bit(v);
};
export function setBitCode(v) {
  // CompBitSet-style: 0-511 set, 1000-1511 clear
  if (v == null || v < 0) return; // classic misn lacks some Nova bit fields
  if (v >= 1000) missionLog.clearBit(v - 1000);
  else missionLog.setBit(v);
}
export const field = (m, k, dflt = -1) => (m[k] == null ? dflt : m[k]); // classic vs Nova

// govt relations (from $sem flags we don't have allies as data; use gövt Ally/Enemy)
export function govtAllies(g) {
  const r = govts[g];
  return r ? [r.Ally].filter((a) => a >= 128) : [];
}
export function govtEnemies(g) {
  const r = govts[g];
  return r ? [r.Enemy].filter((a) => a >= 128) : [];
}

/* Resolve an AvailStel/TravelStel/ReturnStel code to a concrete spob id.
 * `here` is the spob the mission is being offered/accepted at. Returns a
 * spob id, or null if unresolvable. */
export function resolveStel(code, here) {
  const inhabited = () => allSpobs().filter((p) => p.$sem && !p.$sem.uninhabited && p.$sem.canLand);
  const uninhab = () => allSpobs().filter((p) => p.$sem && p.$sem.uninhabited);
  const pick = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)].id : null);
  if (code === -1) return null; // no specific dest / any (caller decides)
  if (code === -2) return pick(inhabited());
  if (code === -3) return pick(uninhab());
  if (code === -4) return here ? here.id : null;
  if (code >= 128 && code <= 1627) return spobById(code) ? code : null;
  const govtPick = (g, filter) => pick(inhabited().filter((p) => filter(p.Govt, g)));
  if (code >= 9999 && code <= 10127) return govtPick(code - 9999, (pg, g) => pg === g);
  if (code >= 15000 && code <= 15127)
    return govtPick(code - 15000, (pg, g) => govtAllies(g).includes(pg));
  if (code >= 20000 && code <= 20127) return govtPick(code - 20000, (pg, g) => pg !== g);
  if (code >= 25000 && code <= 25127)
    return govtPick(code - 25000, (pg, g) => govtEnemies(g).includes(pg));
  return null;
}

/* Does mission m's AvailStel match the spob `p`? */
export function availStelMatch(code, p) {
  if (code === -1) return p.$sem && !p.$sem.uninhabited && p.$sem.canLand;
  if (code >= 128 && code <= 1627) return p.id === code;
  const g = (c) => code - c;
  if (code >= 9999 && code <= 10127) return p.Govt === g(9999);
  if (code >= 15000 && code <= 15127) return govtAllies(g(15000)).includes(p.Govt);
  if (code >= 20000 && code <= 20127) return p.Govt !== g(20000);
  if (code >= 25000 && code <= 25127) return govtEnemies(g(25000)).includes(p.Govt);
  return false;
}

/* Which goal types can we actually complete? Others aren't offered. */
export function goalSupported(m) {
  if (m.ShipCount > 0 && m.ShipGoal >= 0) return [0, 1, 2, 3, 4, 5, 6].includes(m.ShipGoal);
  return true; // cargo delivery / plain go-to
}
export function playerAI() {
  return ships[S.playerShipId].InherentAI;
}

/* Is mission m available at spob p (in this system), for the given loc? */
export function missionAvailable(m, p, loc) {
  if (m.AvailLoc !== loc) return false;
  if (!goalSupported(m)) return false;
  if (!availStelMatch(m.AvailStel, p)) return false;
  if (!bitReq(m.AvailBitSet)) return false;
  if (m.AvailBitClr >= 0 && missionLog.bit(m.AvailBitClr)) return false;
  // combat rating gate: -1 ignore, else kills must be at least AvailRating
  if (m.AvailRating >= 0 && legal.kills < m.AvailRating) return false;
  // legal-record gate (record with this spöb's govt): 0 ignore, positive =
  // at least this good, negative = at least this criminal, -32000 = must
  // have dominated this spöb.
  if (m.AvailRecord === -32000) {
    if (!dominated.has(p.id)) return false;
  } else if (m.AvailRecord > 0) {
    if (legalOf(S.SYSTEM_ID) < m.AvailRecord) return false; // record in THIS system
  } else if (m.AvailRecord < 0) {
    if (legalOf(S.SYSTEM_ID) > m.AvailRecord) return false;
  }
  const ai = playerAI();
  if (m.Flags & 0x2000 && ai <= 2) return false;
  if (m.Flags & 0x4000 && ai >= 3) return false;
  const ast = m.AvailShipType;
  if (ast >= 128 && ast <= 255 && S.playerShipId !== ast) return false;
  if (ast >= 1128 && ast <= 1255 && S.playerShipId === ast - 1000) return false;
  if (ast >= 2128 && ast <= 2255 && ships[S.playerShipId].InherentGovt !== ast - 2000) return false;
  // AvailRandom rerolled per system arrival, cached on the spob-visit
  if (!MISN_ALL && m.AvailRandom > 0 && m.AvailRandom < 100) {
    missionLog.availRandom[m.id] = missionLog.availRandom[m.id] ?? Math.random() * 100;
    if (missionLog.availRandom[m.id] >= m.AvailRandom) return false;
  }
  return true;
}

export function offeredMissions(p, loc) {
  const out = [];
  for (const [id, m] of Object.entries(misns)) {
    if (missionLog.has(+id)) continue; // already accepted (raw records have no id)
    // Attach the id before the check: missionAvailable keys its AvailRandom roll
    // on m.id, so a raw (id-less) record would collide all missions into one slot.
    const offer = { id: +id, ...m };
    if (missionAvailable(offer, p, loc)) out.push(offer);
  }
  // critical missions (Flags 0x1000) first, else by id
  out.sort((a, b) => (b.Flags & 0x1000) - (a.Flags & 0x1000) || a.id - b.id);
  return out;
}

/* A game "date": gameDay counts days since a fixed epoch. Classic EV shows
 * real calendar dates; we render day N of an in-fiction year for flavor. */
export function formatDate(day) {
  const YEAR0 = 1177,
    DPY = 365;
  const y = YEAR0 + Math.floor(day / DPY);
  return `day ${(day % DPY) + 1}, NC ${y}`;
}

/* Substitute EV mission text placeholders from a resolved offer/mission A.
 * (See the bible's token table: <DST> <DSY> <RST> <RSY> <CT> <CQ> <DL> ...) */
export function subst(text, A) {
  if (!text) return text;
  const stel = (id) => (id != null ? stelName(id) : null);
  const sysOf = (id) => {
    const p = spobById(id);
    const s = p && systs[p.System];
    return s && s.name;
  };
  const map = {
    DST: (A && stel(A.travelStel)) || 'your destination',
    DSY: (A && sysOf(A.travelStel)) || 'the target system',
    RST: (A && stel(A.returnStel)) || (A && stel(A.travelStel)) || 'your destination',
    RSY: (A && sysOf(A.returnStel)) || (A && sysOf(A.travelStel)) || 'the target system',
    CT: (A && A.cargoName) || 'cargo',
    // null-check, not truthiness: a legitimate quantity of 0 must render as
    // "0", not fall through to "the".
    CQ: A && A.cargoQty != null ? String(A.cargoQty) : 'the',
    DL: A && A.deadline != null ? formatDate(A.deadline) : 'the deadline',
    PN: 'Captain',
    PSN: ships[S.playerShipId] ? ships[S.playerShipId].name : 'your ship',
    OSN: (A && A.osn) || 'the ship', // offering ship name (ship-offered missions)
  };
  return text.replace(/<(DST|DSY|RST|RSY|CT|CQ|DL|PN|PSN|OSN)>/g, (_, k) => map[k]);
}
export const descText = (id, A) => {
  const d = DATA.types.desc[id];
  return d && d.Description ? subst(d.Description, A) : '';
};
/* Mission names carry tokens too (e.g. "Ferry Passengers to <DST>"). */
export const misnName = (m, A) => subst(m.name, A);
export const misnCargoName = (m) => {
  if (m.CargoType < 0) return null;
  if (m.CargoType === 1000) return DATA.strings[4000].list[Math.floor(Math.random() * 6)];
  return DATA.strings[4000].list[m.CargoType] || 'cargo';
};

/* Resolve a mission's random fields ONCE per offer, so the briefing shows
 * the real destination/cargo/deadline and accepting yields the same thing
 * (classic EV fixes these when the mission is first shown). Cached by id,
 * per system visit (cleared alongside availRandom in loadSystem). */
/* id is passed explicitly: raw misn records (misns[id]) carry no `id`
 * field, so keying off m.id silently collapsed every offer onto one
 * cache slot — the bug where every briefing showed the same destination. */
export function getOffer(id, here) {
  // Key by mission AND offering spöb: ReturnStel −4 ("return here") resolves
  // relative to `here`, so the same mission offered at a second spöb in the
  // same system must not reuse the first spöb's resolution.
  const key = `${id}@${here ? here.id : ''}`;
  if (missionLog.resolvedOffers[key]) return missionLog.resolvedOffers[key];
  const m = misns[id];
  const qty =
    m.CargoQty <= -2
      ? Math.round(Math.abs(m.CargoQty) * (0.5 + Math.random()))
      : Math.max(m.CargoQty, 0);
  const o = {
    id,
    travelStel: resolveStel(m.TravelStel, here),
    returnStel: m.ReturnStel === -1 ? null : resolveStel(m.ReturnStel, here),
    cargoName: misnCargoName(m),
    cargoQty: qty,
    deadline: m.TimeLimit > 0 ? S.gameDay + m.TimeLimit : null,
  };
  missionLog.resolvedOffers[key] = o;
  return o;
}

/* Accept a mission at spob `here`: resolve destinations, load cargo,
 * spawn any special ships if their system is the current one. */
export function acceptMission(id, here) {
  const m = misns[id];
  const offer = getOffer(id, here); // reuse what the briefing showed
  const A = {
    id,
    name: m.name,
    accepted: S.gameDay,
    travelStel: offer.travelStel,
    returnStel: offer.returnStel,
    cargoName: offer.cargoName,
    cargoQty: offer.cargoQty,
    cargoLoaded: false,
    pickupMode: m.PickupMode,
    dropoffMode: m.DropoffMode,
    shipGoal: m.ShipCount > 0 ? m.ShipGoal : -1,
    shipsLeft: m.ShipCount > 0 ? m.ShipCount : 0,
    shipTotal: m.ShipCount > 0 ? m.ShipCount : 0,
    shipSyst: m.ShipSyst,
    shipDude: m.ShipDude,
    shipBehav: m.ShipBehav,
    shipNameID: m.ShipNameID,
    observed: false,
    timeLimit: m.TimeLimit,
    deadline: offer.deadline,
  };
  // prepaid outfit (PayVal -30128-g)
  if (m.PayVal >= -30255 && m.PayVal <= -30128) {
    const oid = -m.PayVal - 30000;
    if (DATA.types.outf[oid]) {
      outfits[oid] = (outfits[oid] || 0) + 1;
      applyShipStats();
    }
  }
  // cargo picked up at accept
  if (A.cargoName && A.pickupMode === 0) A.cargoLoaded = true;
  missionLog.add(A);
  maybeSpawnMissionShips(A);
  showMsg(`Mission accepted: ${misnName(m, A)}`);
}

export function abortMission(id) {
  const A = missionLog.find(id);
  if (!A) return;
  const m = misns[id];
  if (m.Flags & 0x0040) applyGovtDelta(m.CompGovt, -5 * m.CompReward); // abort reversal
  missionLog.remove(id);
  // clear its mission ships from the system
  S.aiShips = S.aiShips.filter((s) => s.misnId !== id);
  showMsg(`Mission abandoned: ${misnName(m, A)}`);
}

/* Spawn a mission's special ships if their target system is the one we're
 * in (called on accept and on each system load). */
export function maybeSpawnMissionShips(A) {
  if (A.shipGoal < 0 || A.shipsLeft <= 0) return;
  const sys = A.shipSyst;
  const inThisSystem =
    sys === -6 ||
    sys === -1 || // follow / initial
    (sys >= 128 && sys <= 1127 && sys === S.SYSTEM_ID) ||
    (A.travelStel &&
      systOfSpob(spobById(A.travelStel)) &&
      sys === -3 &&
      spobById(A.travelStel).System === S.SYSTEM_ID) ||
    (A.returnStel && sys === -4 && spobById(A.returnStel).System === S.SYSTEM_ID);
  if (!inThisSystem) return;
  if (S.aiShips.some((s) => s.misnId === A.id)) return; // already present
  const dude = dudes[A.shipDude];
  if (!dude) return;
  for (let i = 0; i < A.shipsLeft; i++) {
    const shipId = weighted(dudeShipPairs(dude));
    if (shipId == null) continue;
    const a = Math.random() * Math.PI * 2,
      r = 900 + Math.random() * 700;
    const e = EV.makeShip(
      ships[shipId],
      player.x + Math.cos(a) * r,
      player.y + Math.sin(a) * r,
      Math.random() * 360,
    );
    e.shipId = shipId;
    e.govt = dude.Govt;
    e.aiType = 3;
    e.booty = dude.Booty || 0; // boardable mission ships plunder like any other
    e.misnId = A.id;
    e.misnGoal = A.shipGoal;
    e.target = S.spobs.length ? S.spobs[Math.floor(Math.random() * S.spobs.length)] : null;
    armShip(e, ships[shipId]);
    // goal-specific setup (spec: "Mission ship goals")
    if (A.shipGoal === 5) {
      e.disabled = true;
      e.shields = 0;
    } // Rescue: start disabled
    if (A.shipGoal === 3) {
      // Escort: protect, head out
      e.escort = true;
      e.aiType = 1; // flee-style: run for the exit
    } else if (A.shipBehav === 0 || A.shipBehav === 10) {
      e.hostile = true; // attack player
    }
    if (A.shipNameID >= 128 && DATA.strings[A.shipNameID])
      e.misnName = DATA.strings[A.shipNameID].list[i % DATA.strings[A.shipNameID].list.length];
    S.aiShips.push(e);
  }
}
export function dudeShipPairs(dude) {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const s = dude['ShipTypes' + i],
      w = dude['Prob' + i];
    if (s >= 128 && ships[s] && w > 0) out.push([s, w]);
  }
  return out;
}

/* Called when a mission ship is destroyed (from hitShip). */
export function onMissionShipDestroyed(s) {
  const A = missionLog.find(s.misnId);
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
    case 2:
    case 5: // board/rescue: the target must be boarded, not killed
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
export function onMissionShipDisabled(s) {
  const A = missionLog.find(s.misnId);
  if (!A) return;
  if (A.shipGoal === 1) {
    // Disable but don't destroy
    if (!s.misnCounted) {
      s.misnCounted = true;
      A.shipsLeft--;
    }
    if (A.shipsLeft <= 0)
      showMsg(`${misnName(misns[A.id], A)}: targets disabled — return for payment.`);
  } else if (A.shipGoal === 2) {
    showMsg(`Target disabled — approach and press B to board.`);
  }
}

/* An escort ship reached its destination safely. */
export function onMissionEscortArrived(s) {
  const A = missionLog.find(s.misnId);
  if (!A) return;
  if (!S.aiShips.some((x) => x.misnId === A.id && x !== s))
    showMsg(`${misnName(misns[A.id], A)}: escort delivered — return for payment.`);
}
/* Escort goal met once all escort ships have arrived (none remain) unharmed. */
export function escortArrived(A) {
  return A.shipGoal === 3 && !A.escortFailed && !S.aiShips.some((s) => s.misnId === A.id);
}

/* Goal met? (used at ReturnStel). */
export function goalMet(A) {
  if (A.shipGoal === 0 || A.shipGoal === 6) return A.shipsLeft <= 0;
  if (A.shipGoal === 1) return A.shipsLeft <= 0 && !A.captureLost;
  if (A.shipGoal === 2 || A.shipGoal === 5) return A.shipsLeft <= 0 && !A.captureLost;
  if (A.shipGoal === 3) return escortArrived(A); // all escorts must arrive, not just survive
  if (A.shipGoal === 4) return A.observed;
  return true; // cargo / go-to: arriving at returnStel is the goal
}
/* An unwinnable goal (target killed / escort lost) should fail at ReturnStel
 * even without a time limit, rather than stranding the mission forever. */
export function goalFailed(A) {
  return !!A.captureLost || !!A.escortFailed;
}

/* Handle landing on spob p for every active mission: cargo pickup/dropoff
 * at TravelStel, and completion/failure at ReturnStel. Returns dialog
 * chunks to append to the planet screen. */
export function missionLandingEvents(p) {
  const notes = [];
  for (const A of [...missionLog.list]) {
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
    const isReturn =
      (A.returnStel != null && A.returnStel === p.id) ||
      (A.returnStel == null && A.travelStel === p.id);
    if (isReturn) {
      const expired = A.timeLimit > 0 && S.gameDay - A.accepted > A.timeLimit;
      if (!expired && !goalFailed(A) && goalMet(A)) {
        notes.push(descText(m.CompText, A) || `Mission complete: ${misnName(m, A)}.`);
        payMission(m);
        setBitCode(m.CompBitSet);
        setBitCode(m.CompBitSet2);
        setBitCode(m.CompBitSet4);
        applyGovtDelta(m.CompGovt, m.CompReward);
        removeMission(A.id);
      } else if (expired || goalFailed(A) || m.CanAbort) {
        notes.push(descText(m.FailText, A) || `Mission failed: ${misnName(m, A)}.`);
        setBitCode(m.FailBitSet);
        setBitCode(m.FailBitSet2);
        applyGovtDelta(m.CompGovt, -Math.round(m.CompReward / 2));
        removeMission(A.id);
      }
    }
  }
  return notes;
}
export function removeMission(id) {
  missionLog.remove(id);
  S.aiShips = S.aiShips.filter((s) => s.misnId !== id);
}
export function checkExpiredMissions() {
  for (const A of [...missionLog.list]) {
    if (A.timeLimit > 0 && S.gameDay - A.accepted > A.timeLimit) {
      const m = misns[A.id];
      setBitCode(m.FailBitSet);
      setBitCode(m.FailBitSet2);
      applyGovtDelta(m.CompGovt, -Math.round(m.CompReward / 2));
      removeMission(A.id);
      showMsg(`Mission failed (out of time): ${misnName(misns[A.id], A)}`);
    }
  }
}
/* I in flight: briefing for the active missions (QuickBrief). */
export function showMissionBriefing() {
  if (!missionLog.count) {
    showMsg('No active missions.');
    return;
  }
  const lines = missionLog.list.map((a) => {
    const destId = a.travelStel != null ? a.travelStel : a.returnStel;
    const dest =
      destId != null
        ? `${stelName(destId)}${systOfSpob(spobById(destId)) ? ' (' + systOfSpob(spobById(destId)).name + ')' : ''}`
        : '—';
    const days =
      a.timeLimit > 0 ? `, ${Math.max(0, a.timeLimit - (S.gameDay - a.accepted))}d left` : '';
    const goal =
      a.shipsLeft > 0
        ? `${a.shipsLeft} ships remain`
        : a.cargoName
          ? `deliver ${a.cargoQty}t ${a.cargoName}`
          : `go to ${dest}`;
    return `${a.name}: ${goal} → ${dest}${days}`;
  });
  showMsg(lines.join('  |  '));
}
export function payMission(m) {
  const v = m.PayVal;
  if (v > 0) wallet.earn(v);
  else if (v >= -20255 && v <= -20128) {
    const oid = -v - 20000;
    if (DATA.types.outf[oid]) {
      outfits[oid] = (outfits[oid] || 0) + 1;
      applyShipStats();
    }
  } else if (v >= -40099 && v <= -40001) {
    // percentage fine: keep a fraction of the balance, deduct the rest via the
    // Wallet API so the change stays validated like every other transaction
    const kept = Math.round(wallet.credits * (1 - (-v - 40000) / 100));
    wallet.spend(wallet.credits - kept);
  }
  // -10128..-10255 clean legal record: clear a criminal record with that govt
  else if (v >= -10255 && v <= -10128) pardonGovt(-v - 10000);
}

/* stelName: id → display name, shared by the briefing and the board UI. */
export function stelName(id) {
  const p = spobById(id);
  return p && p.name ? p.name : id != null ? 'stellar ' + id : '—';
}
