import {
  wallet,
  COMMODITIES,
  S,
  hold,
  drawGfxFit,
  drawSpin,
  gfxImg,
  preloadSprites,
  ships,
  spinOfShip,
  spinOfSpob,
  sprites,
  systs,
} from '../01-state.js';
import { html } from './html.js';
import { fuelMax, holds, player, poolKey } from '../04-combat.js';
import { updateTouchUI } from '../05-input.js';
import { distTo } from '../06-interaction.js';
import { cargoNames } from '../07-trade.js';

/*
 * engine/shell/ui/render.js — the canvas HUD/scene renderer (was 10-render.js).
 * Presentation moved under ui/ per OOP_DESIGN.md's "Separating UI from logic"
 * (slice 5). Pure drawing: it reads game state and paints the frame + sidebar
 * panel; no game logic lives here.
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
addEventListener('resize', resize);
resize();

export function starsIn(cx, cy, layer) {
  let h = (cx * 73856093) ^ (cy * 19349663) ^ (layer * 83492791);
  const out = [];
  for (let i = 0; i < 5; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const x = h % 512;
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const y = h % 512;
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    out.push([x, y, h % 3 === 0 ? 2 : 1]);
  }
  return out;
}
export function drawStars(camX, camY, w, h, streak) {
  for (const [layer, par, alpha] of [
    [1, 0.3, 0.5],
    [2, 0.6, 0.9],
  ]) {
    const ox = camX * par,
      oy = camY * par;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.strokeStyle = `rgba(200,220,255,${alpha})`;
    const c0x = Math.floor((ox - w / 2) / 512),
      c1x = Math.floor((ox + w / 2) / 512);
    const c0y = Math.floor((oy - h / 2) / 512),
      c1y = Math.floor((oy + h / 2) / 512);
    for (let cx = c0x; cx <= c1x; cx++)
      for (let cy = c0y; cy <= c1y; cy++)
        for (const [sx, sy, r] of starsIn(cx, cy, layer)) {
          const x = cx * 512 + sx - ox + w / 2,
            y = cy * 512 + sy - oy + h / 2;
          if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
          if (streak > 0) {
            const a = EV.rad(player.heading);
            const len = streak * 6 * par;
            ctx.beginPath();
            ctx.moveTo(x, y);
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
  const off = (meta ? meta.frameH : 24) / 2 + 3;
  ctx.save();
  ctx.translate(x - Math.sin(a) * off, y + Math.cos(a) * off);
  ctx.rotate(a);
  ctx.fillStyle = 'rgba(255,170,60,.85)';
  ctx.beginPath();
  ctx.moveTo(-3, 0);
  ctx.lineTo(3, 0);
  ctx.lineTo(0, 7 + Math.random() * 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Classic-style corner brackets around a target.
export function drawBrackets(x, y, half, color) {
  const arm = Math.max(6, half * 0.45);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
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

/* A lumpy grey asteroid (spec: "Asteroids"). Its outline is a fixed irregular
 * polygon derived from the rock's seed, so the shape holds steady as it spins; a
 * shaded rim and a lighter facet give it a bit of relief. Pure scenery — drawn at
 * the entity layer, but ships and fire pass straight over it. */
export function drawAsteroid(a, x, y) {
  const n = 11;
  const lump = (i) => {
    // stable per-vertex value in ~[0.68, 1.0] from the rock's seed and index
    const h = (((a.seed ^ (i * 0x9e3779b1)) >>> 0) * 1103515245 + 12345) >>> 0;
    return 0.68 + (((h >>> 16) & 0xff) / 255) * 0.32;
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(EV.rad(a.rot));
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const rr = a.r * lump(i);
    const vx = Math.cos(ang) * rr,
      vy = Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(vx, vy);
    else ctx.lineTo(vx, vy);
  }
  ctx.closePath();
  ctx.fillStyle = '#7a7a80';
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = '#3c3c44';
  ctx.stroke();
  ctx.fillStyle = 'rgba(196,198,206,.28)'; // top-left facet highlight
  ctx.beginPath();
  ctx.ellipse(-a.r * 0.28, -a.r * 0.28, a.r * 0.42, a.r * 0.3, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
    files.push(`PICT_${5000 + (id - 128)}.png`); // shipyard detail
    files.push(`PICT_${3000 + (id - 128)}.png`); // target schematic
    files.push(`PICT_${5300 + (id - 128)}.png`); // hail comm portrait
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

export const GREEN = '#3ce052',
  DIMGREEN = '#1d7a2e';
export function panelText(
  x,
  y,
  text,
  color = GREEN,
  align = 'left',
  font = '10px Geneva, Verdana, sans-serif',
) {
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

let publishedPanelW = -1; // last --panel-w written to the DOM (see drawPanel)
export function drawPanel(w, h) {
  const pw = 144,
    ph = 480;
  // Shrink the fixed 144×480 sidebar to fit short (mobile landscape) screens;
  // no-op on desktop where the viewport is taller than the panel.
  const psc = Math.min(1, h / ph);
  // Publish the panel's on-screen width (CSS px) so the dialog overlays can inset
  // their dim to its left edge and leave the sidebar's ship stats fully visible.
  // Cached: only touch the DOM when it actually changes (avoids per-frame recalc).
  const cssW = pw * psc;
  if (cssW !== publishedPanelW) {
    publishedPanelW = cssW;
    document.documentElement.style.setProperty('--panel-w', cssW + 'px');
  }
  // Snap the panel origin to a whole device pixel. Vertical-centering with an
  // odd window height (or a fractional DPR) otherwise lands it on a half pixel,
  // smearing the bitmap's 1px beveled separators into wavy lines.
  const snap = (v) => Math.round(v * devicePixelRatio) / devicePixelRatio;
  ctx.save();
  ctx.translate(snap(w - pw * psc), snap(Math.max(0, (h - ph * psc) / 2)));
  ctx.scale(psc, psc);
  const px = 0,
    py = 0;
  if (panelImg.complete && panelImg.naturalWidth) ctx.drawImage(panelImg, px, py);
  else {
    ctx.fillStyle = '#041004';
    ctx.fillRect(px, py, pw, ph);
  }

  /* radar — square, like the original */
  const rx = px + 5,
    ry = py + 4,
    rw = 134,
    rh = 133;
  const rcx = rx + rw / 2,
    rcy = ry + rh / 2,
    scale = rw / 2 / 2600;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  const blip = (o, color, sz) => {
    const x = rcx + (o.x - player.x) * scale,
      y = rcy + (o.y - player.y) * scale;
    if (x < rx || x > rx + rw || y < ry || y > ry + rh) return null;
    ctx.fillStyle = color;
    ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    return [x, y];
  };
  const blinkOn = Math.floor(Date.now() / 350) % 2 === 0;
  const RADAR_GREEN = '#5fe25f';
  // basic radar mode: stellar objects are green circle outlines…
  ctx.strokeStyle = RADAR_GREEN;
  ctx.lineWidth = 1;
  for (const p of S.spobs) {
    const x = rcx + (p.x - player.x) * scale,
      y = rcy + (p.y - player.y) * scale;
    if (x < rx || x > rx + rw || y < ry || y > ry + rh) continue;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 7);
    ctx.stroke();
  }
  // asteroids show as faint grey specks so the field is legible on radar
  for (const a of S.asteroids) blip(a, '#9a9aa2', 1.5);
  // …and ships are brighter green dots (the selected target blinks yellow).
  for (const s of S.aiShips) {
    const isTarget = s === S.shipTarget;
    blip(s, isTarget && blinkOn ? '#ffd479' : RADAR_GREEN, isTarget ? 3 : 2);
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(rcx - 1.5, rcy - 1.5, 3, 3);
  // Nav arrow on the mini nav screen: when the nav target — or, with none set,
  // the nearest stellar object — is off the radar, blink a green arrow at the
  // edge pointing toward it. (Clipped to the radar, so it can't spill out.)
  const navObj = S.navTarget || nearestSpob();
  if (navObj && blinkOn) {
    const bx = rcx + (navObj.x - player.x) * scale,
      by = rcy + (navObj.y - player.y) * scale;
    if (bx < rx || bx > rx + rw || by < ry || by > ry + rh) {
      const ang = Math.atan2(navObj.y - player.y, navObj.x - player.x);
      drawNavArrow(rcx, rcy, ang, rw / 2 - 22, rw / 2 - 10, 6);
    }
  }
  ctx.restore();

  /* shield & fuel bars. Once shields are gone the top bar becomes the ARMOR bar:
   * the panel PICT's baked "Shield:" label is painted over with the panel
   * background and re-lettered "Armor:", and the bar tracks armour instead. */
  const shieldsUp = player.shields > 0;
  if (!shieldsUp) {
    ctx.fillStyle = '#002200'; // panel background — hide the baked "Shield:" label
    ctx.fillRect(px + 8, py + 149, 40, 13);
    panelText(px + 10, py + 160, 'Armor:');
  }
  ctx.fillStyle = GREEN;
  const topFrac = shieldsUp ? player.shields / player.shieldMax : player.armor / player.armorMax;
  ctx.fillRect(px + 60, py + 154, Math.round(74 * Math.max(0, topFrac)), 6);
  ctx.fillRect(px + 60, py + 170, Math.round(74 * (S.fuel / fuelMax)), 6);

  /* navigation pane (slot 1, right below shield/fuel — classic panel order): the
   * hyperspace jump target, or the stellar-navigation (landing) target, with the
   * mode named on the first line the way the original does. */
  const navC = px + 72; // panel content centre
  if (S.jump) {
    panelText(navC, py + 200, 'Hyperspace', GREEN, 'center');
    panelText(navC, py + 214, systs[S.jump.destId].name, '#fff', 'center');
  } else if (S.jumpDest != null && systs[S.jumpDest]) {
    panelText(navC, py + 200, 'Hyperspace', DIMGREEN, 'center');
    // Destination name stays dim until you're clear of the no-jump ring, then
    // lights to white to signal the hyperdrive is ready (paired with the ding).
    panelText(navC, py + 214, systs[S.jumpDest].name, S.jumpReady ? '#fff' : DIMGREEN, 'center');
  } else if (S.navTarget) {
    panelText(navC, py + 200, 'Stellar Navigation', DIMGREEN, 'center');
    panelText(navC, py + 214, S.navTarget.name, '#fff', 'center');
  } else {
    // no destination or landing target — muted, like the original
    panelText(navC, py + 207, 'Nav System Off', DIMGREEN, 'center');
  }

  /* secondary weapon pane (slot 2): name + a compact ammo / fighter count */
  const sw = player.selSecondary;
  if (sw) {
    const pk = poolKey(sw.rec);
    let label = sw.rec.name ?? 'weapon ' + sw.id;
    let color = GREEN;
    if (sw.rec.Guidance === 99) {
      const have = sw.have || 0;
      label += ` ${have}/${sw.n}`;
      color = have > 0 ? GREEN : '#e06c75';
    } else if (pk != null) {
      const cur = player.pools[pk] || 0,
        cap = player.poolCap[pk] || 0;
      label += ` ${cur}${cap > 0 ? '/' + cap : ''}`;
      color = cur > 0 ? GREEN : '#e06c75';
    }
    panelText(navC, py + 250, label, color, 'center');
  } else {
    panelText(navC, py + 250, 'No Secondary Weapon', DIMGREEN, 'center');
  }

  /* target display */
  const tb = { x: px + 5, y: py + 262, w: 134, h: 117 };
  if (S.shipTarget) {
    // classic schematic target pic (PICT 3000 + ship index); sprite fallback
    if (
      !drawGfxFit(ctx, 3000 + (S.shipTarget.shipId - 128), tb.x + tb.w / 2, tb.y + 40, tb.w - 8, 74)
    )
      drawSpin(
        ctx,
        spinOfShip(S.shipTarget.shipId),
        tb.x + tb.w / 2,
        tb.y + 40,
        S.shipTarget.heading,
      );
    const govtName =
      S.shipTarget.govt >= 128 && DATA.types.govt[S.shipTarget.govt]
        ? DATA.types.govt[S.shipTarget.govt].name
        : 'Independent';
    panelText(
      tb.x + tb.w / 2,
      tb.y + 86,
      S.shipTarget.misnName || ships[S.shipTarget.shipId].name,
      '#fff',
      'center',
    );
    panelText(
      tb.x + tb.w / 2,
      tb.y + 98,
      S.shipTarget.bounty ? 'Bounty Hunter' : govtName,
      S.shipTarget.bounty ? '#e06c75' : radarColor(S.shipTarget.govt),
      'center',
    );
    // Status progression: Shields X% → Shields Down (shields gone, armour intact)
    // → DISABLED (crippled). Down is amber, disabled red. No distance/speed — the
    // original HUD shows neither.
    const shp = Math.round((100 * Math.max(0, S.shipTarget.shields)) / S.shipTarget.shieldMax);
    const status = S.shipTarget.disabled
      ? 'DISABLED'
      : shp <= 0
        ? 'Shields Down'
        : `Shields ${shp}%`;
    // disabled → gray (helpless), shields down → amber, otherwise green
    const statusColor = S.shipTarget.disabled ? '#aab2be' : shp <= 0 ? '#e0a038' : GREEN;
    panelText(tb.x + tb.w / 2, tb.y + 110, status, statusColor, 'center');
  } else {
    // A landing/nav target is NOT a combat target: it belongs to the Nav pane
    // above ("Stellar Navigation"), so the target box stays "No target" until a
    // ship is targeted — matching the original HUD.
    panelText(tb.x + tb.w / 2, tb.y + 62, 'No target', DIMGREEN, 'center');
  }

  /* cargo / wallet box */
  const cb = { x: px + 9, y: py + 398 };
  panelText(cb.x, cb.y, `Credits: ${wallet.credits.toLocaleString('en-US')}`);
  panelText(cb.x, cb.y + 13, `Jumps left: ${Math.floor(S.fuel / EV.JUMP_FUEL)}`);
  let cy = cb.y + 30;
  const held = COMMODITIES.map((c, i) => [cargoNames[i], hold.get(c)]).filter(([, q]) => q > 0);
  if (held.length === 0) panelText(cb.x, cy, `Cargo: ${holds} tons free`, DIMGREEN);
  else
    for (const [name, q] of held.slice(0, 4)) {
      panelText(cb.x, cy, `${q}t ${name}`);
      cy += 12;
    }
  ctx.restore();
}

/* Nearest stellar object to the player (by distance), for the off-screen nav
 * arrow when nothing is explicitly targeted. */
function nearestSpob() {
  let best = null,
    bd = Infinity;
  for (const p of S.spobs) {
    const d = (p.x - player.x) ** 2 + (p.y - player.y) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
/* A green arrow centred at (cx,cy) pointing along `ang`: a shaft from radius r0
 * to r1 with an arrowhead of length `head` — the nav pointer on the radar. */
function drawNavArrow(cx, cy, ang, r0, r1, head) {
  const dx = Math.cos(ang),
    dy = Math.sin(ang),
    nx = -dy,
    ny = dx;
  ctx.strokeStyle = GREEN;
  ctx.fillStyle = GREEN;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx + dx * r0, cy + dy * r0);
  ctx.lineTo(cx + dx * r1, cy + dy * r1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + dx * (r1 + head), cy + dy * (r1 + head));
  ctx.lineTo(cx + dx * r1 + nx * head * 0.75, cy + dy * r1 + ny * head * 0.75);
  ctx.lineTo(cx + dx * r1 - nx * head * 0.75, cy + dy * r1 - ny * head * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 1;
}

export function render() {
  updateTouchUI();
  const w = innerWidth,
    h = innerHeight;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;

  const streak = S.jump && S.jump.phase === 'streak' ? S.jump.t : 0;
  drawStars(player.x, player.y, w, h, streak);
  const toScreen = (x, y) => [x - player.x + w / 2, y - player.y + h / 2];

  for (const p of S.spobs) {
    const [x, y] = toScreen(p.x, p.y);
    drawSpin(ctx, spinOfSpob(p), x, y, 0);
    if (p === S.navTarget) {
      const ok = !p.$sem || p.$sem.canLand;
      drawBrackets(
        x,
        y,
        spriteHalf(spinOfSpob(p), 48),
        ok ? 'rgba(120,230,140,.9)' : 'rgba(150,160,180,.7)',
      );
    }
  }
  for (const a of S.asteroids) {
    const [x, y] = toScreen(a.x, a.y);
    if (x < -40 || x > w + 40 || y < -40 || y > h + 40) continue; // cull off-screen
    drawAsteroid(a, x, y);
  }
  for (const s of S.aiShips) {
    const [x, y] = toScreen(s.x, s.y);
    if (x < -100 || x > w + 100 || y < -100 || y > h + 100) continue;
    // disintegration: fade the hull out under the fireball (not a hard flicker)
    if (s.deathT >= 0) ctx.globalAlpha = Math.max(0, s.deathT / Math.max(s.deathDelay, 1));
    if (s.fade != null) ctx.globalAlpha = Math.max(s.fade, 0);
    drawSpin(ctx, spinOfShip(s.shipId), x, y, s.heading);
    drawFlame(s, x, y);
    ctx.globalAlpha = 1;
    if (s === S.shipTarget)
      drawBrackets(
        x,
        y,
        spriteHalf(spinOfShip(s.shipId), 32),
        // disabled → gray (a helpless hull), hostile → red, otherwise amber
        s.disabled
          ? 'rgba(170,178,190,.9)'
          : s.hostile
            ? 'rgba(224,108,117,.9)'
            : 'rgba(255,212,121,.9)',
      );
  }
  if (!S.landedAt && !S.gameOver) {
    if (player.deathT >= 0)
      ctx.globalAlpha = Math.max(0, player.deathT / Math.max(player.deathDelay, 1));
    drawSpin(ctx, spinOfShip(player.shipId), w / 2, h / 2, player.heading);
    drawFlame(player, w / 2, h / 2);
    ctx.globalAlpha = 1;
  }

  /* shots, beams, explosions */
  const BEAM_COLORS = {
    '-2': '#ff5050',
    '-3': '#50ff70',
    '-4': '#5080ff',
    '-5': '#50ffff',
    '-6': '#ff50ff',
    '-7': '#ffff50',
  };
  for (const b of S.beams) {
    const [x1, y1] = toScreen(b.owner.x, b.owner.y);
    const a = EV.rad(b.heading),
      len = b.len ?? b.rec.Speed;
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
    else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
  for (const ex of S.explosions) {
    const [x, y] = toScreen(ex.x, ex.y);
    const meta = MANIFEST.spins[ex.spin];
    const s = sprites.get(ex.spin);
    if (!s || !s.ready) continue;
    const fi = Math.min(ex.f, meta.frames - 1);
    ctx.drawImage(
      s.img,
      (fi % meta.xTiles) * meta.frameW,
      Math.floor(fi / meta.xTiles) * meta.frameH,
      meta.frameW,
      meta.frameH,
      x - meta.frameW / 2,
      y - meta.frameH / 2,
      meta.frameW,
      meta.frameH,
    );
  }
  drawPanel(w, h);

  // System + ship name only — the original HUD shows neither speed nor distance.
  document.getElementById('hud').innerHTML = html`
    <b>${S.syst.name}</b><br>${ships[S.playerShipId].name}`;

  // boardable disabled mission ship in range?
  const boardable = S.landedAt
    ? null
    : S.aiShips.find(
        (s) =>
          s.misnId != null &&
          s.disabled &&
          s.deathT < 0 &&
          (s.misnGoal === 2 || s.misnGoal === 5) &&
          Math.hypot(s.x - player.x, s.y - player.y) < 50,
      );
  const speed = Math.hypot(player.vx, player.vy); // for the "slow down to land" hint
  const near =
    S.landedAt ||
    S.jump ||
    !S.navTarget ||
    (S.navTarget.$sem && !S.navTarget.$sem.canLand) ||
    distTo(S.navTarget) >= EV.LAND_DIST
      ? null
      : S.navTarget;
  document.getElementById('prompt').textContent =
    S.jump && S.jump.phase === 'engage'
      ? S.jump.t < EV.JUMP_WARMUP_FRAMES
        ? 'Hyperdrive spinning up — Esc to abort'
        : 'Entering hyperspace…'
      : boardable
        ? 'Press B to board'
        : near
          ? speed > EV.LAND_SPEED
            ? `Slow down to land on ${near.name}`
            : `Press L to land on ${near.name}`
          : '';
}
