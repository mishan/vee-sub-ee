import { COMMODITIES, S, cargo, drawGfxFit, drawSpin, explored, gfxImg, html, preloadSprites, ships, spinOfShip, spinOfSpob, sprites, systs } from './01-state.js';
import { fuelMax, holds, linkedSystems, player, poolKey } from './04-combat.js';
import { TOUCH, updateTouchUI } from './05-input.js';
import { distTo } from './06-interaction.js';
import { cargoNames } from './07-trade.js';
import { govts } from './08-missions.js';
import { combatRating, isCriminalWith, legalStatus } from './13-legal.js';

/*
 * engine/shell/10-render.js — part of the browser flight shell.
 *
 * esbuild bundles the shell modules (entry: main.js) into engine/shell.bundle.js,
 * injected into flight.html by `evexport --flight` and the loader. 01-state is
 * the leaf holding the shared state object S; modules import what they use.
 * Normative behavior: engine/ENGINE_SPEC.md.
 */
/* ---------------- rendering ---------------- */

export const canvas = document.getElementById('game');
export const ctx = canvas.getContext('2d');
export function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
}
addEventListener('resize', resize); resize();

export function starsIn(cx, cy, layer) {
  let h = (cx * 73856093) ^ (cy * 19349663) ^ (layer * 83492791);
  const out = [];
  for (let i = 0; i < 5; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const x = (h % 512); h = (h * 1103515245 + 12345) & 0x7fffffff;
    const y = (h % 512); h = (h * 1103515245 + 12345) & 0x7fffffff;
    out.push([x, y, (h % 3) === 0 ? 2 : 1]);
  }
  return out;
}
export function drawStars(camX, camY, w, h, streak) {
  for (const [layer, par, alpha] of [[1, 0.3, 0.5], [2, 0.6, 0.9]]) {
    const ox = camX * par, oy = camY * par;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.strokeStyle = `rgba(200,220,255,${alpha})`;
    const c0x = Math.floor((ox - w / 2) / 512), c1x = Math.floor((ox + w / 2) / 512);
    const c0y = Math.floor((oy - h / 2) / 512), c1y = Math.floor((oy + h / 2) / 512);
    for (let cx = c0x; cx <= c1x; cx++)
      for (let cy = c0y; cy <= c1y; cy++)
        for (const [sx, sy, r] of starsIn(cx, cy, layer)) {
          const x = cx * 512 + sx - ox + w / 2, y = cy * 512 + sy - oy + h / 2;
          if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
          if (streak > 0) {
            const a = EV.rad(player.heading);
            const len = streak * 6 * par;
            ctx.beginPath(); ctx.moveTo(x, y);
            ctx.lineTo(x - Math.sin(a) * len, y + Math.cos(a) * len);
            ctx.stroke();
          } else ctx.fillRect(x, y, r, r);
        }
  }
}

export function radarColor(govtId) {
  if (govtId == null || govtId < 128) return '#9aa5b8'; // no/independent govt → neutral
  const hues = ['#e5c07b', '#61afef', '#e06c75', '#98c379', '#c678dd', '#56b6c2'];
  return hues[(govtId - 128) % hues.length];
}

export function drawFlame(ship, x, y) {
  if (!ship.thrusting) return;
  const a = EV.rad(ship.heading);
  const meta = (sprites.get(spinOfShip(ship.shipId)) || {}).meta;
  const off = ((meta ? meta.frameH : 24) / 2) + 3;
  ctx.save();
  ctx.translate(x - Math.sin(a) * off, y + Math.cos(a) * off);
  ctx.rotate(a);
  ctx.fillStyle = 'rgba(255,170,60,.85)';
  ctx.beginPath();
  ctx.moveTo(-3, 0); ctx.lineTo(3, 0); ctx.lineTo(0, 7 + Math.random() * 4);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Classic-style corner brackets around a target.
export function drawBrackets(x, y, half, color) {
  const arm = Math.max(6, half * 0.45);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath();
    ctx.moveTo(x + sx * half, y + sy * (half - arm));
    ctx.lineTo(x + sx * half, y + sy * half);
    ctx.lineTo(x + sx * (half - arm), y + sy * half);
    ctx.stroke();
  }
}
export function spriteHalf(spinId, fallback) {
  const m = (sprites.get(spinId) || {}).meta;
  return (m ? Math.max(m.frameW, m.frameH) : fallback) / 2 + 6;
}

/* ---- classic sidebar: PICT 128 "Game Panel" (144×480) from EV Titles.
 * Box geometry measured from the asset: radar y3–138, shield/fuel bar
 * slots at x60–134 / y154 & y170, message box y190–227, status strip
 * y235–254, target display y262–378, cargo box y386–476; content x5–138. */
export const panelImg = (() => {
  const i = document.createElement('img');
  i.src = 'evassets/titles/PICT_128_Game Panel.png';
  i.style.display = 'none';
  document.body.appendChild(i);
  return i;
})();

/* shop art: menu sheets + 100×100 dialog pictures, preloaded at parse so
 * the shop dialogs render complete on first open */
{
  const files = ['PICT_5100.png', 'PICT_6100.png'];
  for (const id of Object.keys(ships)) {
    files.push(`PICT_${5000 + (id - 128)}.png`);  // shipyard detail
    files.push(`PICT_${3000 + (id - 128)}.png`);  // target schematic
    files.push(`PICT_${5300 + (id - 128)}.png`);  // hail comm portrait
  }
  for (const id of Object.keys(DATA.types.outf)) files.push(`PICT_${6000 + (id - 128)}.png`);
  for (const f of files) {
    const img = document.createElement('img');
    img.src = 'evassets/graphics/' + f;
    img.style.display = 'none';
    img.onerror = () => img.remove();
    document.body.appendChild(img);
  }
  // warm the canvas PICT cache too (target pics are drawn on the canvas)
  for (const id of Object.keys(ships)) gfxImg(3000 + (id - 128));
  // combat sprites: every weapon graphic + the three explosion sets
  const combatSpins = new Set([400, 401, 402]);
  for (const w of Object.values(DATA.types.weap))
    if (w.Graphic >= 0 && w.Graphic <= 63) combatSpins.add(200 + w.Graphic);
  preloadSprites(combatSpins);
}

export const GREEN = '#3ce052', DIMGREEN = '#1d7a2e';
export function panelText(x, y, text, color = GREEN, align = 'left', font = '10px Geneva, Verdana, sans-serif') {
  ctx.fillStyle = color; ctx.font = font; ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

export function drawPanel(w, h) {
  const pw = 144, ph = 480;
  // Shrink the fixed 144×480 sidebar to fit short (mobile landscape) screens;
  // no-op on desktop where the viewport is taller than the panel.
  const psc = Math.min(1, h / ph);
  ctx.save();
  ctx.translate(w - pw * psc, Math.max(0, (h - ph * psc) / 2));
  ctx.scale(psc, psc);
  const px = 0, py = 0;
  if (panelImg.complete && panelImg.naturalWidth) ctx.drawImage(panelImg, px, py);
  else { ctx.fillStyle = '#041004'; ctx.fillRect(px, py, pw, ph); }

  /* radar — square, like the original */
  const rx = px + 5, ry = py + 4, rw = 134, rh = 133;
  const rcx = rx + rw / 2, rcy = ry + rh / 2, scale = (rw / 2) / 2600;
  ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
  const blip = (o, color, sz) => {
    const x = rcx + (o.x - player.x) * scale, y = rcy + (o.y - player.y) * scale;
    if (x < rx || x > rx + rw || y < ry || y > ry + rh) return null;
    ctx.fillStyle = color; ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    return [x, y];
  };
  for (const p of S.spobs) blip(p, '#7fd0ff', 3);
  for (const s of S.aiShips) {
    const at = blip(s, s.playerEscort ? '#67d967' : radarColor(s.govt), 2);
    if (at && s === S.shipTarget) {
      ctx.strokeStyle = '#ffd479'; ctx.strokeRect(at[0] - 3, at[1] - 3, 6, 6);
    }
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(rcx - 1.5, rcy - 1.5, 3, 3);
  ctx.restore();

  /* shield & fuel bars */
  ctx.fillStyle = GREEN;
  ctx.fillRect(px + 60, py + 154,
    Math.round(74 * Math.max(0, player.shields / player.shieldMax)), 6);
  ctx.fillRect(px + 60, py + 170, Math.round(74 * (S.fuel / fuelMax)), 6);

  /* secondary weapon display (classic behavior — not a message mirror) */
  const sw = player.selSecondary;
  if (sw) {
    const pk = poolKey(sw.rec);
    panelText(px + 9, py + 202, sw.rec.name ?? 'weapon ' + sw.id);
    if (sw.rec.Guidance === 99) {                 // fighter bay: docked / capacity
      const have = sw.have || 0;
      panelText(px + 9, py + 214, `Fighters: ${have}/${sw.n}`, have > 0 ? GREEN : '#e06c75');
    } else if (pk != null) {
      const cur = player.pools[pk] || 0, cap = player.poolCap[pk] || 0;
      panelText(px + 9, py + 214, `Ammo: ${cur}${cap > 0 ? '/' + cap : ''}`,
        cur > 0 ? GREEN : '#e06c75');
    } else panelText(px + 9, py + 214, 'Ready', DIMGREEN);
  } else {
    panelText(px + 9, py + 202, 'No secondary', DIMGREEN);
  }

  /* status strip: hyperspace destination */
  const destName = S.jumpDest != null && systs[S.jumpDest] ? systs[S.jumpDest].name : null;
  panelText(px + 9, py + 248,
    S.jump ? `Hyperspace: ${systs[S.jump.destId].name}` :
    destName ? `Dest: ${destName} (J)` : S.syst.name);

  /* target display */
  const tb = { x: px + 5, y: py + 262, w: 134, h: 117 };
  if (S.shipTarget) {
    // classic schematic target pic (PICT 3000 + ship index); sprite fallback
    if (!drawGfxFit(ctx, 3000 + (S.shipTarget.shipId - 128), tb.x + tb.w / 2, tb.y + 40, tb.w - 8, 74))
      drawSpin(ctx, spinOfShip(S.shipTarget.shipId), tb.x + tb.w / 2, tb.y + 40, S.shipTarget.heading);
    const govtName = S.shipTarget.govt >= 128 && DATA.types.govt[S.shipTarget.govt]
      ? DATA.types.govt[S.shipTarget.govt].name : 'Independent';
    panelText(tb.x + tb.w / 2, tb.y + 86, S.shipTarget.misnName || ships[S.shipTarget.shipId].name, '#fff', 'center');
    panelText(tb.x + tb.w / 2, tb.y + 98,
      S.shipTarget.bounty ? 'Bounty Hunter' : govtName,
      S.shipTarget.bounty ? '#e06c75' : radarColor(S.shipTarget.govt), 'center');
    const shp = Math.round(100 * Math.max(0, S.shipTarget.shields) / S.shipTarget.shieldMax);
    panelText(tb.x + tb.w / 2, tb.y + 110,
      S.shipTarget.disabled ? 'DISABLED' : `Shields ${shp}% · ${Math.round(distTo(S.shipTarget))}px`,
      S.shipTarget.disabled ? '#e06c75' : GREEN, 'center');
  } else if (S.navTarget) {
    drawSpin(ctx, spinOfSpob(S.navTarget), tb.x + tb.w / 2, tb.y + 44, 0);
    panelText(tb.x + tb.w / 2, tb.y + 98, S.navTarget.name, '#fff', 'center');
    panelText(tb.x + tb.w / 2, tb.y + 110, `${Math.round(distTo(S.navTarget))}px`, GREEN, 'center');
  } else {
    panelText(tb.x + tb.w / 2, tb.y + 62, 'No target', DIMGREEN, 'center');
  }

  /* cargo / wallet box */
  const cb = { x: px + 9, y: py + 398 };
  panelText(cb.x, cb.y, `Credits: ${S.credits.toLocaleString('en-US')}`);
  panelText(cb.x, cb.y + 13, `Jumps left: ${Math.floor(S.fuel / EV.JUMP_FUEL)}`);
  let cy = cb.y + 30;
  const held = COMMODITIES.map((c, i) => [cargoNames[i], cargo[c]]).filter(([, q]) => q > 0);
  if (held.length === 0) panelText(cb.x, cy, `Cargo: ${holds} tons free`, DIMGREEN);
  else for (const [name, q] of held.slice(0, 4)) { panelText(cb.x, cy, `${q}t ${name}`); cy += 12; }
  ctx.restore();
}

/* ---- galaxy map overlay ---- */

export let mapHit = []; // clickable {x, y, id} in screen coords
export function drawMap(w, h) {
  mapHit = [];
  const mw = Math.min(w * 0.72, 900), mh = Math.min(h * 0.72, 620);
  const mx = (w - mw) / 2, my = (h - mh) / 2;
  ctx.fillStyle = 'rgba(4,6,12,.93)';
  ctx.strokeStyle = '#2a3550';
  ctx.fillRect(mx, my, mw, mh); ctx.strokeRect(mx, my, mw, mh);

  const all = Object.entries(systs);
  const xs = all.map(([, s]) => s.xPos), ys = all.map(([, s]) => s.yPos);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sc = Math.min((mw - 60) / (x1 - x0), (mh - 60) / (y1 - y0));
  const px = s => mx + 30 + (s.xPos - x0) * sc, py = s => my + 30 + (s.yPos - y0) * sc;

  ctx.lineWidth = 1;
  for (const [id, s] of all)
    for (let i = 1; i <= 16; i++) {
      const c = s['Con' + i];
      if (c >= 128 && systs[c] && +id < c &&
          (explored.has(+id) || explored.has(c))) { // fog: known links only
        ctx.strokeStyle = 'rgba(90,110,160,.3)';
        ctx.beginPath(); ctx.moveTo(px(s), py(s)); ctx.lineTo(px(systs[c]), py(systs[c])); ctx.stroke();
      }
    }
  const linked = linkedSystems();
  for (const [id, s] of all) {
    const x = px(s), y = py(s);
    const known = explored.has(+id), adjacent = linked.includes(+id);
    // fog of war (spec: "Map knowledge"): unexplored = dim anonymous dot
    ctx.fillStyle = known ? radarColor(s.Govt) : 'rgba(120,130,150,.35)';
    ctx.beginPath(); ctx.arc(x, y, known ? 3 : 2, 0, 7); ctx.fill();
    if (+id === S.SYSTEM_ID) {
      ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
    }
    if (+id === S.jumpDest) {
      ctx.strokeStyle = '#ffd479'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
    }
    if (adjacent) mapHit.push({ x, y, id: +id });
    if (known || adjacent) {
      ctx.fillStyle = known ? '#cfd6e4' : '#7a869c';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(s.name ?? id, x + 8, y + 4);
    }
  }
  // Legal status for the selected system (destination if chosen, else the
  // current one), plus the player's combat rating.
  const shownId = S.jumpDest >= 128 && systs[S.jumpDest] ? S.jumpDest : S.SYSTEM_ID;
  const shownSys = systs[shownId];
  const statusG = shownSys.Govt >= 128 ? shownSys.Govt : 128;
  const status = legalStatus(statusG);
  const crim = isCriminalWith(statusG);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#8fa3c8';
  ctx.fillText(`${shownSys.name} (${govts[statusG] ? govts[statusG].name : 'Independent'}) — ` +
    `legal status: `, mx + 14, my + mh - 30);
  const w0 = ctx.measureText(`${shownSys.name} (${govts[statusG] ? govts[statusG].name : 'Independent'}) — legal status: `).width;
  ctx.fillStyle = crim ? '#e06c75' : status === 'Clean' ? '#8fa3c8' : '#98c379';
  ctx.fillText(status, mx + 14 + w0, my + mh - 30);
  ctx.fillStyle = '#8fa3c8';
  ctx.fillText(`Combat rating: ${combatRating()}` +
    `   ·   click a linked system, then J to jump` +
    (S.fuel < EV.JUMP_FUEL ? '  (out of fuel!)' : ''), mx + 14, my + mh - 12);
}
canvas.addEventListener('pointerdown', e => {
  if (!S.mapOpen) return;
  for (const t of mapHit) // generous hit radius so it works with a fingertip too
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) < (TOUCH ? 22 : 12)) { S.jumpDest = t.id; return; }
});

export function render() {
  updateTouchUI();
  const w = innerWidth, h = innerHeight;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;

  const streak = S.jump && S.jump.phase === 'streak' ? S.jump.t : 0;
  drawStars(player.x, player.y, w, h, streak);
  const toScreen = (x, y) => [x - player.x + w / 2, y - player.y + h / 2];

  for (const p of S.spobs) {
    const [x, y] = toScreen(p.x, p.y);
    drawSpin(ctx, spinOfSpob(p), x, y, 0);
    ctx.fillStyle = 'rgba(190,205,230,.55)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y + 50);
    ctx.textAlign = 'left';
    if (p === S.navTarget) {
      const ok = !p.$sem || p.$sem.canLand;
      drawBrackets(x, y, spriteHalf(spinOfSpob(p), 48),
        ok ? 'rgba(120,230,140,.9)' : 'rgba(150,160,180,.7)');
    }
  }
  for (const s of S.aiShips) {
    const [x, y] = toScreen(s.x, s.y);
    if (x < -100 || x > w + 100 || y < -100 || y > h + 100) continue;
    // disintegration: fade the hull out under the fireball (not a hard flicker)
    if (s.deathT >= 0) ctx.globalAlpha = Math.max(0, s.deathT / Math.max(s.deathDelay, 1));
    if (s.warpIn > 0) {                               // hyperspace-in flash
      const t = s.warpIn / 18, half = spriteHalf(spinOfShip(s.shipId), 24);
      ctx.strokeStyle = `rgba(150,200,255,${t})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, half + t * 40, 0, 7); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1 - t;                        // fade the ship IN
    }
    if (s.fade != null) ctx.globalAlpha = Math.max(s.fade, 0);
    if (s.disabled) ctx.globalAlpha = 0.6;
    drawSpin(ctx, spinOfShip(s.shipId), x, y, s.heading);
    drawFlame(s, x, y);
    ctx.globalAlpha = 1;
    if (s === S.shipTarget)
      drawBrackets(x, y, spriteHalf(spinOfShip(s.shipId), 32),
        s.hostile ? 'rgba(224,108,117,.9)' : 'rgba(255,212,121,.9)');
  }
  if (!S.landedAt && !S.gameOver) {
    if (player.deathT >= 0) ctx.globalAlpha = Math.max(0, player.deathT / Math.max(player.deathDelay, 1));
    drawSpin(ctx, spinOfShip(player.shipId), w / 2, h / 2, player.heading);
    drawFlame(player, w / 2, h / 2);
    ctx.globalAlpha = 1;
  }

  /* shots, beams, explosions */
  const BEAM_COLORS = { '-2': '#ff5050', '-3': '#50ff70', '-4': '#5080ff',
    '-5': '#50ffff', '-6': '#ff50ff', '-7': '#ffff50' };
  for (const b of S.beams) {
    const [x1, y1] = toScreen(b.owner.x, b.owner.y);
    const a = EV.rad(b.heading), len = b.len ?? b.rec.Speed;
    ctx.strokeStyle = BEAM_COLORS[b.rec.Graphic] || '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + Math.sin(a) * len, y1 - Math.cos(a) * len);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  for (const shot of S.shots) {
    const [x, y] = toScreen(shot.x, shot.y);
    if (x < -40 || x > w + 40 || y < -40 || y > h + 40) continue;
    const spin = 200 + shot.rec.Graphic;
    if (MANIFEST.spins[spin]) drawSpin(ctx, spin, x, y, shot.heading);
    else { ctx.fillStyle = '#fff'; ctx.fillRect(x - 1, y - 1, 2, 2); }
  }
  for (const ex of S.explosions) {
    const [x, y] = toScreen(ex.x, ex.y);
    const meta = MANIFEST.spins[ex.spin];
    const s = sprites.get(ex.spin);
    if (!s || !s.ready) continue;
    const fi = Math.min(ex.f, meta.frames - 1);
    ctx.drawImage(s.img, (fi % meta.xTiles) * meta.frameW,
      Math.floor(fi / meta.xTiles) * meta.frameH, meta.frameW, meta.frameH,
      x - meta.frameW / 2, y - meta.frameH / 2, meta.frameW, meta.frameH);
  }
  drawPanel(w, h);
  if (S.mapOpen) drawMap(w, h);

  const speed = Math.hypot(player.vx, player.vy);
  document.getElementById('hud').innerHTML = html`
    <b>${S.syst.name}</b><br>${ships[S.playerShipId].name}<br>speed ${(speed * EV.FPS).toFixed(0)} px/s`;

  // boardable disabled mission ship in range?
  const boardable = S.landedAt ? null : S.aiShips.find(s => s.misnId != null && s.disabled &&
    s.deathT < 0 && (s.misnGoal === 2 || s.misnGoal === 5) &&
    Math.hypot(s.x - player.x, s.y - player.y) < 50);
  const near = (S.landedAt || S.jump || !S.navTarget ||
    (S.navTarget.$sem && !S.navTarget.$sem.canLand) ||
    distTo(S.navTarget) >= EV.LAND_DIST) ? null : S.navTarget;
  document.getElementById('prompt').textContent =
    S.jump && S.jump.phase === 'engage'
      ? (S.jump.t < EV.JUMP_WARMUP_FRAMES ? 'Hyperdrive spinning up — Esc to abort'
                                        : 'Entering hyperspace…') :
    boardable ? 'Press B to board' :
    near ? (speed > EV.LAND_SPEED ? `Slow down to land on ${near.name}`
                                  : `Press L to land on ${near.name}`) : '';
}

