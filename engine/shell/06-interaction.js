/*
 * engine/shell/06-interaction.js — part of the browser flight shell.
 *
 * The shell modules are concatenated (in order.json order) into one <script>
 * in flight.html by `evexport --flight` and the loader, so they share a single
 * scope — treat them as one file split for readability, not as ES modules.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- landing ---------------- */

/* ---- targeting & messages ---- */

let navTarget = null;   // spob (landing/nav target)
let shipTarget = null;  // AI entity (comm/targeting)
let msgTimer = null;

let lastMsg = '';
function showMsg(text) {
  lastMsg = text;
  const el = document.getElementById('msg');
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.style.opacity = 0; }, 3500);
}

const distTo = o => Math.hypot(o.x - player.x, o.y - player.y);

function nearestLandable() {
  let best = null, bd = Infinity;
  for (const p of spobs) {
    if (p.$sem && !p.$sem.canLand) continue;
    const d = distTo(p);
    if (d < bd) { bd = d; best = p; }
  }
  return best; // any distance — targeting decides what to do with it
}
/* Cycling past the farthest target clears the selection (un-target). */
function cyclePlanetTarget() {
  if (!spobs.length) { showMsg('No stellar objects in this system.'); return; }
  const sorted = [...spobs].sort((a, b) => distTo(a) - distTo(b));
  const i = navTarget ? sorted.indexOf(navTarget) : -1;
  navTarget = (i + 1 < sorted.length) ? sorted[i + 1] : null;
  if (!navTarget) showMsg('Navigation target cleared.');
  playSnd(150, 0.5);
}
function cycleShipTarget() {
  if (!aiShips.length) { showMsg('No ships on scope.'); shipTarget = null; return; }
  const sorted = [...aiShips].sort((a, b) => distTo(a) - distTo(b));
  const i = shipTarget ? sorted.indexOf(shipTarget) : -1;
  shipTarget = (i + 1 < sorted.length) ? sorted[i + 1] : null;
  if (!shipTarget) showMsg('Target cleared.');
  playSnd(150, 0.5);
}

/* hail (Y): govt greeting lists live at STR# 7000+(govt-128), generic at
 * 6999; stellar comm strings at 3002. Lines of "*" or "" mean silence. */
function pickLine(listId) {
  const l = DATA.strings[listId] && DATA.strings[listId].list
    .filter(s => s && s !== '*');
  return l && l.length ? l[Math.floor(Math.random() * l.length)] : null;
}
/* Pick a random line from a slice of a STR# list (used for the grouped
 * stellar-comm responses in list 3002). */
function pickFrom(listId, lo, hi) {
  const l = DATA.strings[listId] && DATA.strings[listId].list;
  if (!l) return null;
  const opts = l.slice(lo, hi + 1).filter(s => s && s.trim() && s !== '*' && !s.startsWith('<'));
  return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
}

/* ---- hail dialog (Y): a modal that pauses the sim while open ---- */
let hailOpen = false, hailTarget = null;
const subdued = new Set(); // spob ids whose defense fleet you've just cleared (session)
/* Called when any ship is destroyed; tracks defense-fleet defeat. */
/* Mark a spöb subdued once none of its defense-fleet ships remain. Called
 * both when a defender is destroyed AND when one is boarded/plundered —
 * either way that ship is out of the fight. */
function checkDefenseCleared(defOf, excluding) {
  if (defOf == null) return;
  if (aiShips.some(x => x !== excluding && x.defOf === defOf)) return;
  subdued.add(defOf);
  const p = spobById(defOf);
  if (p) showMsg(`${p.name}'s defenses are broken — hail it to demand tribute.`);
}
function onShipDestroyed(s) {
  if (s.misnId != null) onMissionShipDestroyed(s);
  if (s.killedByPlayer) creditKill(s); // combat rating + legal consequences
  checkDefenseCleared(s.defOf, s);
}
function openHail(kind, obj) {
  clearTimeout(hailCloseTimer); // don't let a pending auto-close hit a new hail
  hailOpen = true; hailTarget = { kind, obj }; renderHail();
}
function closeHail() {
  clearTimeout(hailCloseTimer);
  hailOpen = false; hailTarget = null;
  document.getElementById('hail').style.display = 'none';
}
function hailSay(text) { hailTarget.said = text; renderHail(); }

// Defense fleet size per wave (DefCount>1000 encodes waves; last digit = ships/wave).
const defWave = p => { const c = p.DefCount; return c > 1000 ? Math.max(1, c % 10) : Math.max(0, c); };

function demandTribute(p) {
  const govt = p.Govt;
  if (govt < 128) { hailSay(pickFrom(3002, 5, 9) || 'They ignore you.'); return; }
  if (dominated.has(p.id)) {
    hailSay('They have already submitted to you.'); return;
  }
  // still defended? refuse and scramble the defense fleet.
  const defendersHere = aiShips.some(s => s.defOf === p.id);
  if (defWave(p) > 0 && !subdued.has(p.id)) {
    hailSay(pickFrom(3002, 10, 14) || 'You will regret this.');
    if (!defendersHere) spawnDefenseFleet(p);
    closeHailSoon();
    return;
  }
  // subdued: pay tribute (one-time). Amount is a convention (no tribute
  // field in classic spöb data): scales with tech level.
  dominated.add(p.id);
  const amt = 2000 * (p.TechLevel + 1);
  credits += amt;
  hailSay(`${pickFrom(3002, 25, 26) || 'They agree to pay you tribute.'} (+${amt.toLocaleString('en-US')} cr)`);
  playSnd(150, 0.5);
}
function spawnDefenseFleet(p) {
  const dude = dudes[p.DefDude];
  if (!dude) return;
  const n = Math.min(defWave(p), 6);
  for (let i = 0; i < n; i++) {
    const shipId = weighted(dudeShipPairs(dude));
    if (shipId == null) continue;
    const a = Math.random() * Math.PI * 2, r = 500 + Math.random() * 300;
    const e = EV.makeShip(ships[shipId], player.x + Math.cos(a) * r, player.y + Math.sin(a) * r, Math.random() * 360);
    e.shipId = shipId; e.govt = dude.Govt; e.aiType = 3;
    e.booty = dude.Booty || 0;
    e.defOf = p.id; e.hostile = true; e.warpIn = 18;
    e.target = spobs.length ? spobs[Math.floor(Math.random() * spobs.length)] : null;
    armShip(e, ships[shipId]);
    aiShips.push(e);
  }
  showMsg(`${p.name} launches its defense fleet!`);
}
let hailCloseTimer = null;
function closeHailSoon() { clearTimeout(hailCloseTimer); hailCloseTimer = setTimeout(closeHail, 1400); }

const hailClick = () => playSnd(153, 0.5);       // comm-panel beep (snd 153)
const FUEL_PRICE = 1500;                         // full refuel from a passing ship

// Greeting depends on disposition — hostiles snarl, others are cordial.
function shipGreeting(s) {
  if (s.hostile) return pickFrom(3000, 10, 14) || 'What do you want?';
  return pickLine(7000 + (s.govt - 128)) || pickFrom(3000, 20, 29) || 'Channel open.';
}

function requestAssistance(s) {
  hailClick();
  if (s.hostile) { hailSay(pickFrom(3000, 95, 99) || pickFrom(3000, 50, 59)); return; }
  if (fuel >= fuelMax) { hailSay(pickFrom(3000, 70, 74) || 'You look fine to me.'); return; }
  hailTarget.mode = 'fuel';                       // offer fuel for a price
  hailSay(pickFrom(3000, 140, 144) || 'I can spare fuel, for a price.');
}
function payFuel(full) {
  hailClick();
  const price = full ? FUEL_PRICE : Math.round(FUEL_PRICE / 2);
  // a low-ball offer only lands if the pilot is in a good mood
  if (!full && Math.random() < 0.5) {
    hailTarget.mode = 'main';
    hailSay(pickFrom(3000, 120, 124) || 'Bad mood today — no deal.');
    return;
  }
  if (credits < price) { hailSay(pickFrom(3000, 60, 64) || 'You can’t afford it.'); return; }
  credits -= price;
  fuel = fuelMax;
  hailTarget.mode = 'main';
  hailSay((full ? pickFrom(3000, 100, 104) : pickFrom(3000, 115, 119)) +
    ` (−${price.toLocaleString('en-US')} cr, refuelled)`);
  playSnd(150, 0.4);
}
function begForMercy(s) {
  hailClick();
  if (Math.random() < 0.45) {                     // they'll entertain a bribe
    hailTarget.mode = 'mercy';
    hailTarget.bribe = Math.max(500, Math.min(5000, Math.round(credits * 0.2)));
    hailSay(`They'll let you go... for ${hailTarget.bribe.toLocaleString('en-US')} credits.`);
  } else {
    hailSay(pickFrom(3000, 15, 19) || 'Calling to beg for your life?');
    closeHailSoon();
  }
}
function payBribe(s) {
  hailClick();
  if (credits < hailTarget.bribe) { hailSay(pickFrom(3000, 60, 64) || 'You can’t afford it.'); return; }
  credits -= hailTarget.bribe;
  s.hostile = false; s.fleeing = true;            // breaks off and runs
  hailSay(pickFrom(3000, 135, 139) || 'All right, I’ll leave you alone.');
  playSnd(150, 0.4);
  closeHailSoon();
}
function demandSurrender(s) {
  hailClick();
  if (!s.disabled) { hailSay(pickFrom(3002, 7, 9) || 'Surrender? To you? Ha!'); return; }
  const loot = 500 + Math.floor(Math.random() * 2000);
  credits += loot;
  // same consequences as boarding: it's piracy, and the ship is gone once
  // plundered (was repeatable free loot, and left defenders "in the fight").
  commitCrime(s.govt, penaltyOf(s.govt, 'BoardPenalty'));
  const i = aiShips.indexOf(s);
  if (i >= 0) aiShips.splice(i, 1);
  if (shipTarget === s) shipTarget = null;
  checkDefenseCleared(s.defOf, s);
  showMsg(`You plunder the disabled ship. (+${loot.toLocaleString('en-US')} cr)`);
  closeHail(); // a comm demand, not a physical boarding — no airlock sound
}

/* ---- ship-offered missions: a hailed përs proposes its LinkMission ---- */
/* Is this ship offering a mission to the player right now? */
function shipOffering(s) {
  return !!(s && s.isPers && !s.offered && !s.hostile && s.misnLink >= 128
    && !persDone.has(s.persId) && persOffersToPlayer(pers[s.persId])
    && shipMissionAvailable(s.misnLink));
}
/* The offer panel HTML (comm quote + briefing + destination/pay). */
function shipOfferPanel(s) {
  const m = misns[s.misnLink], here = systemSpob();
  const o = getOffer(s.misnLink, here);
  const A = { ...o, osn: s.misnName };
  const quote = s.commQuote >= 0 && DATA.strings[7100]
    ? DATA.strings[7100].list[s.commQuote] : null;
  const brief = descText(m.BriefText, A) || descText(m.QuickBrief, A) || subst(m.name, A);
  const pay = m.PayVal > 0 ? `${m.PayVal.toLocaleString('en-US')} cr` : 'see briefing';
  const dst = o.travelStel != null ? stelName(o.travelStel)
            : o.returnStel != null ? stelName(o.returnStel) : '—';
  return html`${quote ? html`<div class="say">“${subst(quote, A)}”</div>` : ''}<div class="say" style="max-height:120px;overflow-y:auto">${brief}</div>
    <div class="who">Mission: <b>${subst(m.name, A)}</b> · Destination: ${dst} · Pay: ${pay}</div>`;
}
function acceptShipMission(s) {
  hailClick();
  if (!shipOffering(s)) { closeHail(); return; }
  acceptMission(s.misnLink, systemSpob());
  const f = s.persFlags || 0;
  s.offered = true;                              // don't re-offer this encounter
  if (f & PF.DEACTIVATE) persDone.add(s.persId); // one-shot character: gone for good
  if (f & PF.LEAVE) { s.hostile = false; s.fleeing = true; } // makes its exit
  closeHail();
}
function declineShipMission(s) {
  hailClick();
  s.offered = true;
  const m = misns[s.misnLink];
  const txt = descText(m.RefuseText, { osn: s.misnName });
  if (txt) hailSay(txt); else closeHail();
}

function renderHail() {
  const t = hailTarget; if (!t) return;
  let body;   // `buttons`/`tag` below are static trusted markup → raw(); data stays escaped
  if (t.kind === 'board') {
    const s = t.obj;
    const govtName = s.govt >= 128 && govts[s.govt] ? govts[s.govt].name : 'Independent';
    const shipName = ships[s.shipId].name;
    let buttons;
    if (t.mode === 'result') { // capture/loot resolved — the ship is spent
      buttons = `<button onclick="hailClick();closeHail()">Continue</button>`;
    } else if (t.mode === 'captured') { // seized — choose its fate
      const full = escorts.length >= MAX_ESCORTS;
      buttons =
        `<button onclick="takeCapturedShip()">Take command</button>` +
        `<button onclick="escortCapturedShip()"${full ? ' disabled title="Your fleet is full"' : ''}>Add to your fleet</button>`;
    } else {
      const canLoot = (s.booty || 0) !== 0;
      buttons =
        `<button onclick="captureVessel()">Capture vessel (~${Math.round(100 * captureOdds(s))}% chance)</button>` +
        (canLoot ? `<button onclick="lootVessel()">Loot the hold</button>`
                 : `<button disabled title="You are repelled — nothing to plunder">Nothing to loot</button>`) +
        `<button onclick="hailClick();closeHail()">Leave it be</button>`;
    }
    const say = t.said || `You board the disabled ${shipName}. Your crew ${playerCrew()} vs theirs ${ships[s.shipId].Crew || 1}.`;
    body = html`<img class="commpic" src="evassets/graphics/PICT_${5300 + (s.shipId - 128)}.png" onerror="this.remove()">
      <h3>${shipName}</h3>
      <div class="who">${govtName} · <span style="color:#e06c75">DISABLED</span></div>
      <div class="say">${say}</div>
      ${raw(buttons)}`;
    document.getElementById('hailCard').innerHTML = body;
    document.getElementById('hail').style.display = 'flex';
    return;
  }
  if (t.kind === 'ship') {
    const s = t.obj;
    const govtName = s.govt >= 128 && govts[s.govt] ? govts[s.govt].name : 'Independent';
    if (t.said == null) t.said = shipGreeting(s);   // first-time greeting
    const label = s.bounty ? 'Bounty Hunter' : govtName;
    const tag = s.disabled ? ' · <span style="color:#e06c75">DISABLED</span>'
              : s.hostile ? ' · <span style="color:#e06c75">HOSTILE</span>' : '';
    const offering = shipOffering(s);
    let buttons;
    if (t.mode === 'fuel') {
      buttons = `<button onclick="payFuel(true)">Pay ${FUEL_PRICE.toLocaleString('en-US')} cr for fuel</button>
        <button onclick="payFuel(false)">Offer ${Math.round(FUEL_PRICE / 2).toLocaleString('en-US')} cr</button>
        <button onclick="hailTarget.mode='main';renderHail()">Never mind</button>`;
    } else if (t.mode === 'mercy') {
      buttons = `<button onclick="payBribe(hailTarget.obj)">Pay ${t.bribe.toLocaleString('en-US')} cr to be spared</button>
        <button onclick="hailTarget.mode='main';renderHail()">Never mind</button>`;
    } else {
      buttons =
        (offering ? `<button onclick="acceptShipMission(hailTarget.obj)">Accept mission</button>
                     <button onclick="declineShipMission(hailTarget.obj)">Decline</button>` : '') +
        `<button onclick="requestAssistance(hailTarget.obj)">Request assistance</button>` +
        (s.hostile ? `<button onclick="begForMercy(hailTarget.obj)">Beg for mercy</button>` : '') +
        `<button onclick="demandSurrender(hailTarget.obj)"${s.disabled ? '' : ' disabled'}>Demand surrender / plunder</button>`;
    }
    // classic ship comm portrait: PICT 5300 + ship index
    body = html`<img class="commpic" src="evassets/graphics/PICT_${5300 + (s.shipId - 128)}.png" onerror="this.remove()">
      <h3>${s.misnName || ships[s.shipId].name}</h3>
      <div class="who">${label}${raw(tag)}</div>
      <div class="say">“${t.said}”</div>
      ${offering && t.mode !== 'fuel' && t.mode !== 'mercy' ? shipOfferPanel(s) : ''}
      ${raw(buttons)}
      <button onclick="hailClick();closeHail()">Close channel</button>`;
  } else {
    const p = t.obj, m = p.$sem || {};
    const greet = t.said || (pickFrom(3002, 0, 4) || 'Channel open to ') + p.name + '.';
    const dom = dominated.has(p.id);
    body = html`<h3>${p.name}</h3>
      <div class="who">${m.govt || 'Independent'}${dom ? ' · paying tribute' : ''}</div>
      <div class="say">“${greet}”</div>
      <button onclick="hailClick();hailSay(pickFrom(3002,15,24) || 'They have nothing to tell you.')">Request information</button>
      <button onclick="hailClick();demandTribute(hailTarget.obj)"${p.Govt < 128 ? ' disabled' : ''}>Demand tribute</button>
      <button onclick="hailClick();closeHail()">Close channel</button>`;
  }
  document.getElementById('hailCard').innerHTML = body;
  document.getElementById('hail').style.display = 'flex';
}

function hail() {
  if (shipTarget) openHail('ship', shipTarget);
  else if (navTarget) {
    const m = navTarget.$sem || {};
    if (m.uninhabited || !m.canLand) showMsg(`${navTarget.name} does not respond.`);
    else openHail('planet', navTarget);
  } else showMsg('No target to hail. (Tab: ships, N: planets)');
}
