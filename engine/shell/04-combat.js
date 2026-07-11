/*
 * engine/shell/04-combat.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- player ----------------
 * This player-state init leads the combat module (rather than living with the
 * rest of the game state in 01-state) purely to preserve top-level execution
 * order: it originally sat right before the audio section, and splitting sound
 * into its own module moved it here. It's referenced lazily everywhere else, so
 * the position is safe; it's grouped with combat only by adjacency. */

const player = EV.makeShip(ships[playerShipId],
  +(params.get('x') || 0), +(params.get('y') || 300), +(params.get('heading') || 0));
player.shipId = playerShipId;
let fuel = ships[playerShipId].Fuel;
let fuelMax = ships[playerShipId].Fuel;
let holds = ships[playerShipId].Holds;
let landedAt = null;

/* ---- combat state (spec: "Combat") ---- */
const weaps = DATA.types.weap;
let shots = [], beams = [], explosions = [];
let gameOver = false;

// ammo pool key for a weapon record (AmmoType 0-63 -> weapon 128+n's pool)
const poolKey = rec => rec.AmmoType >= 0 && rec.AmmoType <= 63 ? 128 + rec.AmmoType : null;

/* Give an entity combat stats + stock loadout from its shïp record. */
function armShip(e, rec) {
  e.shieldMax = rec.Shield; e.shields = rec.Shield;
  e.armorMax = rec.Armor; e.armor = rec.Armor;
  e.shieldRe = rec.ShieldRe; e.mass = Math.max(rec.Mass, 1);
  e.deathDelay = rec.DeathDelay;
  // Only AI ships can be disabled and boarded; the player is destroyed
  // outright (no disabled limbo), so damage never returns 'disabled' for it.
  e.disableFrac = e === player ? 0 : (rec.Flags & 0x0010) ? 0.10 : 1 / 3;
  e.deathT = -1; e.disabled = false; e.hostile = false; e.fleeing = false;
  e.weapons = []; e.pools = {}; e.poolCap = {};
  for (let i = 1; i <= 4; i++) {
    const t = rec['WeapType' + i];
    if (t >= 128 && weaps[t]) {
      const w = { id: t, rec: weaps[t], n: Math.max(rec['WeapCount' + i], 1), cool: 0 };
      if (w.rec.Guidance === 99) w.have = w.n;   // fighter bay: fighters docked
      e.weapons.push(w);
      const pk = poolKey(weaps[t]);
      if (pk) {
        e.pools[pk] = (e.pools[pk] || 0) + Math.max(rec['AmmoLoad' + i], 0);
        e.poolCap[pk] = (e.poolCap[pk] || 0) + Math.max(rec['AmmoLoad' + i], 0);
      }
    }
  }
  return e;
}

/* Player loadout = stock + outfitter weapons/ammo (rebuilt on refit). */
function rebuildPlayerWeapons() {
  armShipKeepingCondition(player, effectiveShip());
  for (const [oid, n] of Object.entries(outfits)) {
    const o = DATA.types.outf[oid];
    if (!o || !n || !o.$sem) continue;
    if (o.$sem.modType === 'weapon' && weaps[o.ModVal]) {
      const existing = player.weapons.find(w => w.id === o.ModVal);
      if (existing) existing.n += n;
      else player.weapons.push({ id: o.ModVal, rec: weaps[o.ModVal], n, cool: 0 });
    } else if (o.$sem.modType === 'ammunition' && weaps[o.ModVal]) {
      const pk = poolKey(weaps[o.ModVal]) ?? o.ModVal;
      player.pools[pk] = (player.pools[pk] || 0) + n;
      player.poolCap[pk] = (player.poolCap[pk] || 0) + (o.Max > 0 ? o.Max : n);
    }
  }
  // Fighter bays rearm to full capacity here (rebuild runs on landing, same as
  // the ammo-refill simplification) — every bay's docked count = its size.
  for (const w of player.weapons) if (w.rec.Guidance === 99) w.have = w.n;
  if (!player.weapons.some(w => w === player.selSecondary))
    player.selSecondary = player.weapons.find(w => w.rec.MiscFlags & 2) || null;
}
function armShipKeepingCondition(e, s) {
  const frac = e.shieldMax ? e.shields / e.shieldMax : 1;
  const afrac = e.armorMax ? e.armor / e.armorMax : 1;
  armShip(e, { ...ships[playerShipId], Shield: s.rec.Shield, Armor: s.rec.Armor });
  e.shields = e.shieldMax * frac;
  e.armor = e.armorMax * afrac;
}

const clampArc = (aim, base, arc) => {
  let d = EV.norm(aim - base);
  if (d > 180) d -= 360;
  return EV.norm(base + Math.max(-arc, Math.min(arc, d)));
};
function leadAim(e, t, shotSpeed) {
  const dist = Math.hypot(t.x - e.x, t.y - e.y);
  const dt = shotSpeed > 0 ? dist / shotSpeed : 0;
  return EV.bearing(t.x + t.vx * dt - e.x, t.y + t.vy * dt - e.y);
}

function fire(e, target, primary) {
  for (const w of e.weapons) {
    const sec = (w.rec.MiscFlags & 2) !== 0;
    if (primary ? sec : w !== e.selSecondary) continue;
    if (w.cool > 0) continue;
    const g = w.rec.Guidance;
    if (g === 99) {                    // fighter bay: launch a carried ship (player only)
      if (e === player && launchFighter(w)) {
        w.cool = w.rec.Reload;
        if (w.rec.Sound >= 0) playSnd(200 + w.rec.Sound, attenuate(e.x, e.y));
      }
      continue;
    }
    const pk = poolKey(w.rec);
    if (g === 0 || g === 3) { // beam
      if (pk && !((e.pools[pk] || 0) > 0)) continue;
      if (pk) e.pools[pk]--;
      beams.push({ owner: e, rec: w.rec, life: w.rec.Count, turreted: g === 3, target });
      w.cool = w.rec.Reload + w.rec.Count;
      if (w.rec.Sound >= 0) playSnd(200 + w.rec.Sound, attenuate(e.x, e.y));
      continue;
    }
    let fired = false;
    for (let i = 0; i < w.n; i++) {
      if (pk) { if ((e.pools[pk] || 0) < 1) break; e.pools[pk]--; }
      let aim = e.heading;
      if ((g === 1 || g === 2 || g === 4) && target) aim = leadAim(e, target, EV.shotSpeedOf(w.rec));
      if (g === 7 || g === 8) {
        const base = g === 7 ? e.heading : EV.norm(e.heading + 180);
        aim = target ? clampArc(leadAim(e, target, EV.shotSpeedOf(w.rec)), base, 45) : base;
      }
      aim = EV.norm(aim + (Math.random() * 2 - 1) * w.rec.Inaccuracy);
      const shot = EV.makeShot(w.rec, e, aim);
      shot.owner = e;
      shot.homing = (g === 1 || g === 2) ? target : null;
      shots.push(shot);
      fired = true;
    }
    if (fired) {
      w.cool = w.rec.Reload;
      if (w.rec.Sound >= 0) playSnd(200 + w.rec.Sound, attenuate(e.x, e.y));
    }
  }
}

function spawnExplosion(x, y, type) {
  const spin = 400 + Math.max(0, Math.min(type, 2));
  const meta = MANIFEST.spins[spin];
  if (meta) explosions.push({ x, y, spin, f: 0, frames: meta.frames, tick: 0 });
}
/* Begin a ship's destruction: the fireball plays immediately over the ship
 * as it breaks up (was flash-then-boom, which looked backwards). The ship
 * then fades out over deathDelay frames; big ships get a final blast. */
function beginDestruction(v) {
  v.deathT = Math.max(v.deathDelay, 1);
  v.thrusting = false; // no engine flame on a hull that's breaking up
  spawnExplosion(v.x, v.y, v.deathDelay >= 60 ? 1 : 0);
  playSnd(302, attenuate(v.x, v.y)); // breaking up
}

function grudge(victim, attacker) {
  if (attacker !== player || !victim.aiType) return;
  const react = s => {
    if (s.aiType >= 3 || s.aiType === 2) s.hostile = true;
    else s.fleeing = true;
  };
  react(victim);
  for (const s of aiShips) if (s.govt === victim.govt && s.govt >= 128) react(s);
  if (victim.isPers) {                        // a character you fired on won't deal with you
    victim.offered = true;
    if (victim.persFlags & PF.GRUDGE) persGrudge.add(victim.persId); // and remembers it
  }
}

function hitShip(victim, rec, heading, attacker) {
  const result = EV.applyDamage(victim, rec);
  const kick = rec.Impact / (10 * victim.mass);
  victim.vx += Math.sin(EV.rad(heading)) * kick;
  victim.vy -= Math.cos(EV.rad(heading)) * kick;
  if (rec.ExplodType >= 0)
    playSnd(rec.ExplodType >= 1 ? 300 : 301, attenuate(victim.x, victim.y) * 0.8);
  if (result === 'destroyed' && victim.deathT < 0) {
    if (attacker === player) victim.killedByPlayer = true; // for legal credit on death
    beginDestruction(victim);
  } else if (result === 'disabled' && !victim.disabled) {
    victim.disabled = true;
    if (attacker === player) commitCrime(victim.govt, penaltyOf(victim.govt, 'DisabPenalty'));
    if (victim.misnId != null && attacker === player) onMissionShipDisabled(victim);
  }
  grudge(victim, attacker);
}

/* ---- legal consequences of combat (spec: "Legal record") ---- */
const penaltyOf = (g, field) => (g >= 128 && govts[g] ? govts[g][field] : 0);
// A crime against govt g costs record with g and (halved) its allies.
function commitCrime(victimGovt, penalty) {
  if (victimGovt < 128 || !penalty) return;
  reputation[victimGovt] = legalOf(victimGovt) - penalty;
  for (const ally of govtAllies(victimGovt))
    reputation[ally] = legalOf(ally) - Math.round(penalty / 2);
}
// A kill: adds to combat rating, penalizes the victim's govt, and rewards
// every govt that considers the victim's govt an enemy (bounty for the deed).
function creditKill(victim) {
  kills += Math.max(1, (ships[victim.shipId] && ships[victim.shipId].Crew) || 1);
  const g = victim.govt;
  if (g < 128) return;
  const kp = penaltyOf(g, 'KillPenalty');
  commitCrime(g, kp);
  // every govt that considers the victim's govt an enemy rewards the deed
  for (const [hid, h] of Object.entries(govts))
    if (h.Enemy === g && +hid !== g) reputation[hid] = legalOf(+hid) + kp;
  // killing a xenophobic aggressor (pirates) is lawful everywhere — the
  // current system's government credits you too, matching classic feel
  const vf = govts[g].$sem ? govts[g].$sem.flags : [];
  if (vf.includes('xenophobic')) {
    const sg = systemGovt();
    if (sg !== g) reputation[sg] = legalOf(sg) + kp;
  }
}

function shipHalf(e) {
  const m = MANIFEST.spins[spinOfShip(e.shipId)];
  return m ? Math.max(m.frameW, m.frameH) / 2 : 16;
}

/* ---- outfits (spec-adjacent; oütf ModType effects from semantics.js) ----
 * outfits: outf id -> count. Effective ship stats = base shïp record plus
 * every owned outfit's effect; outfit Mass consumes the hull's FreeMass. */
const outfits = {};
if (SAVED && SAVED.outfits) Object.assign(outfits, SAVED.outfits);
function effectiveShip() {
  const rec = { ...ships[playerShipId] };
  let h = rec.Holds, fm = rec.Fuel, massUsed = 0;
  for (const [id, n] of Object.entries(outfits)) {
    const o = DATA.types.outf[id];
    if (!o || !n) continue;
    massUsed += o.Mass * n;
    switch (o.$sem && o.$sem.modType) {
      case 'cargoSpace':     h += o.ModVal * n; break;
      case 'fuelCapacity':   fm += o.ModVal * n; break;
      case 'shieldCapacity': rec.Shield += o.ModVal * n; break;
      case 'armor':          rec.Armor += o.ModVal * n; break;
      case 'accelBoost':     rec.Accel += o.ModVal * n; break;
      case 'speedBoost':     rec.Speed += o.ModVal * n; break;
      case 'turnBoost':      rec.Maneuver += o.ModVal * n; break;
    }
  }
  return { rec, holds: h, fuelMax: fm, massUsed,
           freeMass: ships[playerShipId].FreeMass - massUsed };
}
function applyShipStats() {
  const s = effectiveShip();
  player.rec = s.rec;
  player.maxSpeed = EV.maxSpeedOf(s.rec);
  player.accel = EV.accelOf(s.rec);
  player.turn = EV.turnOf(s.rec);
  holds = s.holds;
  fuelMax = s.fuelMax;
  fuel = Math.min(fuel, fuelMax);
  rebuildPlayerWeapons(); // loadout + shield/armor maxes follow the refit
}

/* jump state: null | {destId, phase:'engage'|'streak', t} */
let jump = null;
let mapOpen = false;
let jumpDest = null; // selected destination system id

function linkedSystems() {
  const out = [];
  for (let i = 1; i <= 16; i++) {
    const c = syst['Con' + i];
    if (c >= 128 && systs[c]) out.push(c);
  }
  return out;
}

function mapBearingTo(destId) {
  const a = systs[SYSTEM_ID], b = systs[destId];
  return EV.bearing(b.xPos - a.xPos, b.yPos - a.yPos);
}

function nearestSpobInfo() {
  let best = null, bd = Infinity;
  for (const p of spobs) {
    const d = Math.hypot(p.x - player.x, p.y - player.y);
    if (d < bd) { bd = d; best = p; }
  }
  return { spob: best, dist: bd };
}
let warpSnd = null;
function beginJump() {
  if (jump || landedAt) return;
  if (jumpDest == null || !linkedSystems().includes(jumpDest)) return;
  if (fuel < EV.JUMP_FUEL) { showMsg('Not enough fuel to jump.'); return; }
  const near = nearestSpobInfo();
  if (near.spob && near.dist < EV.JUMP_MIN_DIST) {
    showMsg(`You are too close to ${near.spob.name} to engage your hyperdrive.`);
    return;
  }
  jump = { destId: jumpDest, phase: 'engage', t: 0 };
  // Warp Up (8.3s spin-up) — kept as a handle so it can be cut on abort;
  // routed through masterVol like every other sound, and adjustable live.
  if (soundOn && masterVol > 0) {
    warpSnd = sndEl(128).cloneNode();
    warpSnd._baseVol = 1;
    warpSnd.volume = Math.min(masterVol, 1);
    warpSnd.play().catch(() => {});
  } else warpSnd = null;
}
function abortJump() {
  jump = null;
  stopSnd(warpSnd); warpSnd = null;
}
function completeJump() {
  const from = SYSTEM_ID;
  gameDay++;                    // a day passes each hyperspace jump (spec)
  if (fightersOut()) recallFighters(); // fighters dock before the carrier jumps out
  loadSystem(jump.destId);
  // placeAtArrival wants the inbound bearing (origin → dest); from the
  // destination, mapBearingTo(origin) is the reverse bearing, so flip it.
  EV.placeAtArrival(player, EV.norm(mapBearingTo(from) + 180));
  spawnEscorts();               // fleet jumps in around the now-placed player
  fuel -= EV.JUMP_FUEL;
  jump = null; jumpDest = null;
  checkExpiredMissions();
  chargeEscortUpkeep();          // pay the fleet's salaries; the unpaid quit here
  warpSnd = null; // Warp Up ends naturally as the streak completes
  playSnd(130); // Warp Out
}

