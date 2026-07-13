import { wallet, S, dominated, dudes, persDone, ships, showMsg } from './01-state.js';
import { weighted } from './02-spawning.js';
import { playSnd } from './03-sound.js';
import { armShip, commitCrime, creditKill, fuel, penaltyOf, player } from './04-combat.js';
import {
  acceptMission,
  descText,
  dudeShipPairs,
  misns,
  onMissionShipDestroyed,
  pers,
  spobById,
} from './08-missions.js';
import { PF, persOffersToPlayer, shipMissionAvailable, systemSpob } from './15-pers.js';
import { hailDialog, renderHail } from './ui/hail.js';

/*
 * engine/shell/06-interaction.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- landing ---------------- */

/* ---- targeting & messages ---- */

S.navTarget = null; // spob (landing/nav target)
S.shipTarget = null; // AI entity (comm/targeting)

export const distTo = (o) => Math.hypot(o.x - player.x, o.y - player.y);

export function nearestLandable() {
  let best = null,
    bd = Infinity;
  for (const p of S.spobs) {
    if (p.$sem && !p.$sem.canLand) continue;
    const d = distTo(p);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best; // any distance — targeting decides what to do with it
}
/* Cycling past the farthest target clears the selection (un-target). */
export function cyclePlanetTarget() {
  if (!S.spobs.length) {
    showMsg('No stellar objects in this system.');
    return;
  }
  const sorted = [...S.spobs].sort((a, b) => distTo(a) - distTo(b));
  const i = S.navTarget ? sorted.indexOf(S.navTarget) : -1;
  S.navTarget = i + 1 < sorted.length ? sorted[i + 1] : null;
  if (!S.navTarget) showMsg('Navigation target cleared.');
  playSnd(150, 0.5);
}
export function cycleShipTarget() {
  if (!S.aiShips.length) {
    showMsg('No ships on scope.');
    S.shipTarget = null;
    return;
  }
  const sorted = [...S.aiShips].sort((a, b) => distTo(a) - distTo(b));
  const i = S.shipTarget ? sorted.indexOf(S.shipTarget) : -1;
  S.shipTarget = i + 1 < sorted.length ? sorted[i + 1] : null;
  if (!S.shipTarget) showMsg('Target cleared.');
  playSnd(150, 0.5);
}

/* hail (Y): govt greeting lists live at STR# 7000+(govt-128), generic at
 * 6999; stellar comm strings at 3002. Lines of "*" or "" mean silence. */
export function pickLine(listId) {
  const l = DATA.strings[listId] && DATA.strings[listId].list.filter((s) => s && s !== '*');
  return l && l.length ? l[Math.floor(Math.random() * l.length)] : null;
}
/* Pick a random line from a slice of a STR# list (used for the grouped
 * stellar-comm responses in list 3002). */
export function pickFrom(listId, lo, hi) {
  const l = DATA.strings[listId] && DATA.strings[listId].list;
  if (!l) return null;
  const opts = l.slice(lo, hi + 1).filter((s) => s && s.trim() && s !== '*' && !s.startsWith('<'));
  return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
}

/* ---- hail dialog (Y): a modal that pauses the sim while open ---- */
export let hailOpen = false;
S.hailTarget = null;
export const subdued = new Set(); // spob ids whose defense fleet you've just cleared (session)
/* Called when any ship is destroyed; tracks defense-fleet defeat. */
/* Mark a spöb subdued once none of its defense-fleet ships remain. Called
 * both when a defender is destroyed AND when one is boarded/plundered —
 * either way that ship is out of the fight. */
export function checkDefenseCleared(defOf, excluding) {
  if (defOf == null) return;
  if (S.aiShips.some((x) => x !== excluding && x.defOf === defOf)) return;
  subdued.add(defOf);
  const p = spobById(defOf);
  if (p) showMsg(`${p.name}'s defenses are broken — hail it to demand tribute.`);
}
export function onShipDestroyed(s) {
  if (s.misnId != null) onMissionShipDestroyed(s);
  if (s.killedByPlayer) creditKill(s); // combat rating + legal consequences
  checkDefenseCleared(s.defOf, s);
}
export function openHail(kind, obj) {
  clearTimeout(hailCloseTimer); // don't let a pending auto-close hit a new hail
  hailOpen = true;
  S.hailTarget = { kind, obj };
  hailDialog.open(); // renders hailBody and shows the panel + binds the delegation
  playSnd(150, 0.5); // ding as the comm channel opens
}
export function closeHail() {
  clearTimeout(hailCloseTimer);
  hailOpen = false;
  S.hailTarget = null;
  hailDialog.close();
}
export function hailSay(text) {
  S.hailTarget.said = text;
  renderHail();
}

// Defense fleet size per wave (DefCount>1000 encodes waves; last digit = ships/wave).
export const defWave = (p) => {
  const c = p.DefCount;
  return c > 1000 ? Math.max(1, c % 10) : Math.max(0, c);
};

export function demandTribute(p) {
  const govt = p.Govt;
  if (govt < 128) {
    hailSay(pickFrom(3002, 5, 9) || 'They ignore you.');
    return;
  }
  if (dominated.has(p.id)) {
    hailSay('They have already submitted to you.');
    return;
  }
  // still defended? refuse and scramble the defense fleet.
  const defendersHere = S.aiShips.some((s) => s.defOf === p.id);
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
  wallet.earn(amt);
  hailSay(
    `${pickFrom(3002, 25, 26) || 'They agree to pay you tribute.'} (+${amt.toLocaleString('en-US')} cr)`,
  );
  playSnd(150, 0.5);
}
export function spawnDefenseFleet(p) {
  const dude = dudes[p.DefDude];
  if (!dude) return;
  const n = Math.min(defWave(p), 6);
  for (let i = 0; i < n; i++) {
    const shipId = weighted(dudeShipPairs(dude));
    if (shipId == null) continue;
    const a = Math.random() * Math.PI * 2,
      r = 500 + Math.random() * 300;
    const e = EV.makeShip(
      ships[shipId],
      player.x + Math.cos(a) * r,
      player.y + Math.sin(a) * r,
      Math.random() * 360,
    );
    e.shipId = shipId;
    e.govt = dude.Govt;
    e.aiType = 3;
    e.booty = dude.Booty || 0;
    e.defOf = p.id;
    e.hostile = true;
    e.warpIn = 18;
    e.target = S.spobs.length ? S.spobs[Math.floor(Math.random() * S.spobs.length)] : null;
    armShip(e, ships[shipId]);
    S.aiShips.push(e);
  }
  showMsg(`${p.name} launches its defense fleet!`);
}
export let hailCloseTimer = null;
export function closeHailSoon() {
  clearTimeout(hailCloseTimer);
  hailCloseTimer = setTimeout(closeHail, 1400);
}

export const hailClick = () => playSnd(153, 0.5); // comm-panel beep (snd 153)
export const FUEL_PRICE = 1500; // full refuel from a passing ship

// Greeting depends on disposition — hostiles snarl, others are cordial.
export function shipGreeting(s) {
  if (s.hostile) return pickFrom(3000, 10, 14) || 'What do you want?';
  return pickLine(7000 + (s.govt - 128)) || pickFrom(3000, 20, 29) || 'Channel open.';
}

export function requestAssistance(s) {
  hailClick();
  if (s.hostile) {
    hailSay(pickFrom(3000, 95, 99) || pickFrom(3000, 50, 59));
    return;
  }
  if (fuel.full()) {
    hailSay(pickFrom(3000, 70, 74) || 'You look fine to me.');
    return;
  }
  S.hailTarget.mode = 'fuel'; // offer fuel for a price
  hailSay(pickFrom(3000, 140, 144) || 'I can spare fuel, for a price.');
}
export function payFuel(full) {
  hailClick();
  const price = full ? FUEL_PRICE : Math.round(FUEL_PRICE / 2);
  // a low-ball offer only lands if the pilot is in a good mood
  if (!full && Math.random() < 0.5) {
    S.hailTarget.mode = 'main';
    hailSay(pickFrom(3000, 120, 124) || 'Bad mood today — no deal.');
    return;
  }
  if (!wallet.canAfford(price)) {
    hailSay(pickFrom(3000, 60, 64) || 'You can’t afford it.');
    return;
  }
  wallet.spend(price);
  fuel.refill();
  S.hailTarget.mode = 'main';
  hailSay(
    (full ? pickFrom(3000, 100, 104) : pickFrom(3000, 115, 119)) +
      ` (−${price.toLocaleString('en-US')} cr, refuelled)`,
  );
  playSnd(150, 0.4);
}
export function begForMercy(_s) {
  hailClick();
  if (Math.random() < 0.45) {
    // they'll entertain a bribe
    S.hailTarget.mode = 'mercy';
    S.hailTarget.bribe = Math.max(500, Math.min(5000, Math.round(wallet.credits * 0.2)));
    hailSay(`They'll let you go... for ${S.hailTarget.bribe.toLocaleString('en-US')} credits.`);
  } else {
    hailSay(pickFrom(3000, 15, 19) || 'Calling to beg for your life?');
    closeHailSoon();
  }
}
export function payBribe(s) {
  hailClick();
  if (!wallet.canAfford(S.hailTarget.bribe)) {
    hailSay(pickFrom(3000, 60, 64) || 'You can’t afford it.');
    return;
  }
  wallet.spend(S.hailTarget.bribe);
  s.hostile = false;
  s.fleeing = true; // breaks off and runs
  hailSay(pickFrom(3000, 135, 139) || 'All right, I’ll leave you alone.');
  playSnd(150, 0.4);
  closeHailSoon();
}
export function demandSurrender(s) {
  hailClick();
  if (!s.disabled) {
    hailSay(pickFrom(3002, 7, 9) || 'Surrender? To you? Ha!');
    return;
  }
  const loot = 500 + Math.floor(Math.random() * 2000);
  wallet.earn(loot);
  // same consequences as boarding: it's piracy, and the ship is gone once
  // plundered (was repeatable free loot, and left defenders "in the fight").
  commitCrime(s.govt, penaltyOf(s.govt, 'BoardPenalty'));
  const i = S.aiShips.indexOf(s);
  if (i >= 0) S.aiShips.splice(i, 1);
  if (S.shipTarget === s) S.shipTarget = null;
  checkDefenseCleared(s.defOf, s);
  showMsg(`You plunder the disabled ship. (+${loot.toLocaleString('en-US')} cr)`);
  closeHail(); // a comm demand, not a physical boarding — no airlock sound
}

/* ---- ship-offered missions: a hailed përs proposes its LinkMission ---- */
/* Is this ship offering a mission to the player right now? */
export function shipOffering(s) {
  return !!(
    s &&
    s.isPers &&
    !s.offered &&
    !s.hostile &&
    s.misnLink >= 128 &&
    !persDone.has(s.persId) &&
    persOffersToPlayer(pers[s.persId]) &&
    shipMissionAvailable(s.misnLink)
  );
}
export function acceptShipMission(s) {
  hailClick();
  if (!shipOffering(s)) {
    closeHail();
    return;
  }
  acceptMission(s.misnLink, systemSpob());
  const f = s.persFlags || 0;
  s.offered = true; // don't re-offer this encounter
  if (f & PF.DEACTIVATE) persDone.add(s.persId); // one-shot character: gone for good
  if (f & PF.LEAVE) {
    s.hostile = false;
    s.fleeing = true;
  } // makes its exit
  closeHail();
}
export function declineShipMission(s) {
  hailClick();
  s.offered = true;
  const m = misns[s.misnLink];
  const txt = descText(m.RefuseText, { osn: s.misnName });
  if (txt) hailSay(txt);
  else closeHail();
}

export function hail() {
  if (S.shipTarget) openHail('ship', S.shipTarget);
  else if (S.navTarget) {
    const m = S.navTarget.$sem || {};
    if (m.uninhabited || !m.canLand) showMsg(`${S.navTarget.name} does not respond.`);
    else openHail('planet', S.navTarget);
  } else showMsg('No target to hail. (Tab: ships, N: planets)');
}
