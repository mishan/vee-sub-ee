/*
 * engine/shell/ui/map.js — the galaxy map, a DOM overlay (canvas star map plus
 * HTML info panels and buttons), replacing the old canvas-drawn map in
 * 10-render. Systems are coloured by legal status; you plan a hyperspace route
 * of contiguous jumps, then exit (Done/Esc) and press J to fly it one hop at a
 * time. Normative behaviour: engine/ENGINE_SPEC.md ("Galaxy map").
 */
import { S, explored, html, missionLog, pilotBorn, systs } from '../01-state.js';
import { linkedSystems } from '../04-combat.js';
import { govts } from '../08-missions.js';
import { combatRating, govtOf, isCriminalWith, legalOf, legalStatus } from '../13-legal.js';

const COMMODITY_NAMES = ['Food', 'Industrial', 'Medical', 'Luxury Goods', 'Metal', 'Equipment'];
const COMMODITY_KEYS = ['food', 'industrial', 'medical', 'luxury', 'metal', 'equipment'];

// --- element handles (the panel markup lives in flight_template.html) ---
const panel = document.getElementById('map');
const cv = document.getElementById('mapCanvas');
const infoEl = document.getElementById('mapInfo');
const footEl = document.getElementById('mapFooter');

const view = { cx: 0, cy: 0, scale: 1 }; // centre (system coords) + pixels per unit
let sel = null; // selected system id (right-panel subject)

export const mapIsOpen = () => S.mapOpen;

/* All spöbs physically in a system (independent of fog). */
function spobsOf(sysId) {
  const out = [];
  for (const p of Object.values(DATA.types.spob)) if (p && p.System === sysId) out.push(p);
  return out;
}
/* System ids that host an active mission's destination (travel or return). */
function missionDestSystems() {
  const set = new Set();
  for (const a of missionLog.list)
    for (const stel of [a.travelStel, a.returnStel]) {
      const p = stel != null && DATA.types.spob[stel];
      if (p && p.System >= 128) set.add(p.System);
    }
  return set;
}
function isPirate(g) {
  const f = govts[g] && govts[g].$sem ? govts[g].$sem.flags : [];
  return f.includes('xenophobic');
}
/* Can't land anywhere in a system because every inhabited spöb wants a higher
 * legal record than you hold there → "restricted" (orange). */
function isRestricted(sysId) {
  const ports = spobsOf(sysId).filter((p) => p.$sem && p.$sem.canLand && !p.$sem.uninhabited);
  if (!ports.length) return false;
  const rec = legalOf(sysId);
  return ports.every((p) => (p.MinCoolness || 0) > rec);
}
/* Colour a system dot by the player's standing there (spec: "Galaxy map"). */
function systemColor(sysId) {
  const raw = systs[sysId].Govt;
  if (raw < 128) return '#8a93a5'; // independent / no govt → gray
  if (isPirate(raw)) return '#e06c75'; // pirates are hostile on sight → red
  if (legalOf(sysId) < 0 || isCriminalWith(sysId)) return '#e06c75'; // below clean → red
  if (isRestricted(sysId)) return '#e0a038'; // can't land (MinCoolness) → orange
  return '#5aa0e5'; // clean or better → blue
}

// --- view helpers -----------------------------------------------------------
function px(s) {
  return cv.width / 2 + (s.xPos - view.cx) * view.scale;
}
function py(s) {
  return cv.height / 2 + (s.yPos - view.cy) * view.scale;
}
/* Centre on the player's system at a comfortable zoom that shows the neighbours. */
function resetView() {
  const here = systs[S.SYSTEM_ID];
  view.cx = here.xPos;
  view.cy = here.yPos;
  view.scale = 5.5;
}
function zoom(factor) {
  view.scale = Math.max(1.2, Math.min(28, view.scale * factor));
  draw();
}

// --- rendering --------------------------------------------------------------
function sizeCanvas() {
  const r = cv.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
}
export function draw() {
  if (!S.mapOpen) return;
  sizeCanvas();
  const g = cv.getContext('2d');
  const dpr = devicePixelRatio || 1;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cv.width / dpr,
    H = cv.height / dpr;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#04060c';
  g.fillRect(0, 0, W, H);

  const route = S.route || [];
  const routeSet = new Set(route);
  const linked = linkedSystems();

  // links (fog: only where an endpoint is explored)
  for (const [id, s] of Object.entries(systs)) {
    for (let i = 1; i <= 16; i++) {
      const c = s['Con' + i];
      if (!(c >= 128 && systs[c] && +id < c)) continue;
      if (!(explored.has(+id) || explored.has(c))) continue;
      const routed = onRoute(+id, c, route);
      g.strokeStyle = routed ? '#4fd06a' : 'rgba(90,110,160,.28)';
      g.lineWidth = routed ? (route.length > 1 ? 3 : 2) : 1;
      g.beginPath();
      g.moveTo(px(s), py(s));
      g.lineTo(px(systs[c]), py(systs[c]));
      g.stroke();
    }
  }
  // the just-selected adjacent hop lights green even before it's a committed route
  if (S.jumpDest != null && systs[S.jumpDest] && !route.length) {
    g.strokeStyle = '#4fd06a';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px(systs[S.SYSTEM_ID]), py(systs[S.SYSTEM_ID]));
    g.lineTo(px(systs[S.jumpDest]), py(systs[S.jumpDest]));
    g.stroke();
  }

  const missionDest = missionDestSystems();
  for (const [idStr, s] of Object.entries(systs)) {
    const id = +idStr;
    const x = px(s),
      y = py(s);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const known = explored.has(id);
    g.fillStyle = known ? systemColor(id) : 'rgba(120,130,150,.35)';
    g.beginPath();
    g.arc(x, y, known ? 4 : 2.5, 0, 7);
    g.fill();
    if (id === S.SYSTEM_ID) ring(g, x, y, 8, '#ffffff'); // you are here
    if (routeSet.has(id) || id === S.jumpDest) ring(g, x, y, 7, '#4fd06a');
    if (id === sel) ring(g, x, y, 10, '#ffd479');
    if (missionDest.has(id) && known) missionMark(g, x, y);
    if (known || linked.includes(id)) {
      g.fillStyle = known ? '#cfd6e4' : '#7a869c';
      g.font = '11px system-ui, sans-serif';
      g.fillText(s.name ?? id, x + 9, y + 4);
    }
  }
}
function ring(g, x, y, r, color) {
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(x, y, r, 0, 7);
  g.stroke();
}
function missionMark(g, x, y) {
  g.strokeStyle = '#ff4d4d';
  g.lineWidth = 2;
  const d = 5;
  g.beginPath();
  g.moveTo(x - d, y - d);
  g.lineTo(x + d, y + d);
  g.moveTo(x + d, y - d);
  g.lineTo(x - d, y + d);
  g.stroke();
}
// Is the link a–b part of the planned route (current system → route[0] → …)?
function onRoute(a, b, route) {
  const chain = [S.SYSTEM_ID, ...route];
  for (let i = 0; i + 1 < chain.length; i++) {
    if ((chain[i] === a && chain[i + 1] === b) || (chain[i] === b && chain[i + 1] === a))
      return true;
  }
  return false;
}

// --- info panels ------------------------------------------------------------
function servicesOf(sysId) {
  const svc = new Set();
  for (const p of spobsOf(sysId)) {
    const m = p.$sem || {};
    if (m.commodityExchange) svc.add('Trading');
    if (m.outfitter) svc.add('Outfitter');
    if (m.shipyard) svc.add('Shipyard');
    if (m.bar) svc.add('Bar');
  }
  return [...svc];
}
function goodsOf(sysId) {
  const goods = new Set();
  for (const p of spobsOf(sysId)) {
    const pr = p.$sem && p.$sem.prices;
    if (!pr) continue;
    COMMODITY_KEYS.forEach((k, i) => {
      if (pr[k]) goods.add(COMMODITY_NAMES[i]);
    });
  }
  return [...goods];
}
function hazardsOf(sysId) {
  const s = systs[sysId];
  const hz = [];
  if (s.Asteroids > 0) hz.push('Asteroids');
  if (s.Interference > 0) hz.push('Interference');
  return hz.length ? hz.join(', ') : 'None';
}
function fmtDate() {
  // gameDate() lives in 11-title but pulls pilotBorn; keep the map self-contained
  // with a 4-digit year built from the same rule.
  const base = new Date(pilotBorn || Date.now());
  const d = new Date(base.getFullYear() + 250, base.getMonth(), base.getDate());
  d.setDate(d.getDate() + (S.gameDay || 0));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}
function renderPanels() {
  const id = sel != null ? sel : S.SYSTEM_ID;
  const s = systs[id];
  const known = explored.has(id);
  const g = govtOf(id);
  const govtName = systs[id].Govt >= 128 && govts[g] ? govts[g].name : 'Independent';
  const status = legalStatus(id);
  const crim = isCriminalWith(id) || legalOf(id) < 0;
  const goods = known ? goodsOf(id) : [];
  const svc = known ? servicesOf(id) : [];
  const row = (label, val, color) =>
    html`<div class="mrow">
      <div class="mlabel">${label}</div>
      <div class="mval" style="${color ? `color:${color}` : ''}">${val}</div>
    </div>`;
  infoEl.innerHTML = html`
    ${row('Destination System', s.name ?? id)} ${row('Government', known ? govtName : 'Unknown')}
    ${row('Legal Status', known ? status : 'Unknown', crim ? '#e06c75' : status === 'Clean' ? '' : '#98c379')}
    ${row('Goods Traded', goods.length ? goods.join('\n') : '—')}
    ${row('Services', svc.length ? svc.join(', ') : '—')}
  `;
  const ports = known
    ? spobsOf(id)
        .filter((p) => p.$sem && p.$sem.canLand)
        .map((p) => p.name)
    : [];
  footEl.innerHTML = html`
    <div><b>Ports:</b> ${ports.length ? ports.join(', ') : 'None'}</div>
    <div><b>Navigation Hazards:</b> ${known ? hazardsOf(id) : 'Unknown'}</div>
    <div class="mrating">Combat rating: ${combatRating()} · ${fmtDate()}</div>
  `;
}

// --- selection + routing ----------------------------------------------------
function pickSystem(mx, my) {
  let best = null,
    bd = 18;
  for (const [id, s] of Object.entries(systs)) {
    if (!explored.has(+id) && !linkedSystems().includes(+id)) continue;
    const d = Math.hypot(mx - px(s), my - py(s));
    if (d < bd) {
      bd = d;
      best = +id;
    }
  }
  return best;
}
function conOf(sysId) {
  const out = [];
  const s = systs[sysId];
  for (let i = 1; i <= 16; i++)
    if (s['Con' + i] >= 128 && systs[s['Con' + i]]) out.push(s['Con' + i]);
  return out;
}
// Extend/replace the route. Shift = append a contiguous waypoint; plain click =
// select the system, and if it's adjacent to the current system, start a route.
function selectAt(mx, my, shift) {
  const id = pickSystem(mx, my);
  if (id == null) return;
  sel = id;
  const route = S.route || [];
  if (shift && route.length) {
    // append if adjacent to the current route end
    if (conOf(route[route.length - 1]).includes(id) && !route.includes(id) && id !== S.SYSTEM_ID)
      route.push(id);
  } else if (linkedSystems().includes(id)) {
    S.route = [id]; // start a fresh single-hop route
    S.jumpDest = id;
    renderPanels();
    draw();
    return;
  } else {
    // a non-adjacent plain click just inspects the system
    renderPanels();
    draw();
    return;
  }
  S.route = route;
  S.jumpDest = route[0];
  renderPanels();
  draw();
}
export function clearRoute() {
  S.route = [];
  S.jumpDest = null;
  draw();
  renderPanels();
}

// --- open / close -----------------------------------------------------------
export function openMap() {
  S.mapOpen = true;
  sel = S.jumpDest != null ? S.jumpDest : S.SYSTEM_ID;
  resetView();
  panel.style.display = 'flex';
  requestAnimationFrame(() => {
    draw();
    renderPanels();
  });
}
export function closeMap() {
  S.mapOpen = false;
  panel.style.display = 'none';
  // one hop at a time: leaving the map arms the next waypoint as the jump target
  S.jumpDest = S.route && S.route.length ? S.route[0] : null;
}
export function toggleMap() {
  if (S.mapOpen) closeMap();
  else openMap();
}

// --- wiring -----------------------------------------------------------------
cv.addEventListener('pointerdown', (e) => {
  if (!S.mapOpen) return;
  const r = cv.getBoundingClientRect();
  selectAt(e.clientX - r.left, e.clientY - r.top, e.shiftKey);
});
cv.addEventListener(
  'wheel',
  (e) => {
    if (!S.mapOpen) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  },
  { passive: false },
);
document.getElementById('mapDone').onclick = closeMap;
document.getElementById('mapZoomIn').onclick = () => zoom(1.25);
document.getElementById('mapZoomOut').onclick = () => zoom(1 / 1.25);
document.getElementById('mapClearRoute').onclick = clearRoute;
addEventListener('resize', () => {
  if (S.mapOpen) draw();
});
