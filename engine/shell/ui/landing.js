/*
 * engine/shell/ui/landing.js — the planet-side landing screen (presentation).
 *
 * The hub that links a docked pilot to the shops and mission boards. Split from
 * 14-landing.js per OOP_DESIGN.md's "Separating UI from logic" (slice 5): this
 * module owns the screen's markup, its Dialog, and the small piece of
 * presentation state it shows (missionNotes — the delivery/completion lines from
 * the last landing, set by 14-landing's tryLand). The flight-side logic
 * (tryLand/takeOff) stays in 14-landing.js.
 *
 * esbuild bundles the shell modules (entry: main.js). Normative: ENGINE_SPEC.md.
 */

import { missionLog, wallet, S } from '../01-state.js';
import { html } from './html.js';
import { holds } from '../04-combat.js';
import { cargoUsed, outfitterStock, shipyardStock } from '../07-trade.js';
import { offeredMissions } from '../08-missions.js';
import { openService } from './services.js';
import { Dialog } from './dialog.js';

// Delivery/completion lines queued by the last landing, shown atop the hub.
// tryLand (14-landing) sets these via setMissionNotes; takeOff clears them.
export let missionNotes = [];
export const setMissionNotes = (notes) => {
  missionNotes = notes;
};

/* The planet-side landing screen is a Dialog over this pure render function: it
 * mounts in the `landed` panel/card and its service buttons carry data-action
 * (routed to landedActions) instead of inline onclick="openService(…)", so the
 * hub no longer relies on the globalThis bridge. The Take Off button lives on the
 * panel itself (outside the card), so it stays a plain template handler, like the
 * service dialogs' Back button. */
function landedBody() {
  const p = S.landedAt;
  if (!p) return '';
  const m = p.$sem || {};
  const desc = DATA.types.desc[p.id];
  const compOffers = offeredMissions(p, 0).length;
  const barOffers = offeredMissions(p, 1).length;
  const svc = ['commodityExchange', 'outfitter', 'shipyard', 'bar']
    .filter((k) => m[k])
    .filter((k) => k !== 'outfitter' || outfitterStock(p).length) // flags lie on
    .filter((k) => k !== 'shipyard' || shipyardStock(p).length) // low-tech worlds
    .map(
      (k) =>
        ({
          commodityExchange: 'trade center',
          outfitter: 'outfitter',
          shipyard: 'shipyard',
          bar: 'bar',
        })[k],
    )
    .join(' · ');
  // Landscape: CustPicID overrides; standard is PICT (10000 + Type) in EV
  // Titles — 34 landscapes matching the 34 stellar types. If a custom PICT
  // is missing from the data (e.g. Darkstar's 11001 in 1.0.5), fall back
  // to the standard, then give up.
  const scape = p.CustPicID >= 0 ? p.CustPicID : 10000 + p.Type;
  let out =
    '' +
    html`<img class="scape" src="evassets/titles/PICT_${scape}.png"
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
  out += html`<div>${m.commodityExchange ? html`<button class="svc" data-action="service" data-arg="exchange">Commodity Exchange</button>` : ''}${
    m.outfitter && outfitterStock(p).length
      ? html`<button class="svc" data-action="service" data-arg="outfitter">Outfitter</button>`
      : ''
  }${
    m.shipyard && shipyardStock(p).length
      ? html`<button class="svc" data-action="service" data-arg="shipyard">Shipyard</button>`
      : ''
  }${
    m.bar
      ? html`<button class="svc" data-action="service" data-arg="bar">Spaceport Bar${barOffers ? ` (${barOffers})` : ''}</button>`
      : ''
  }${
    m.canLand && compOffers
      ? html`<button class="svc" data-action="service" data-arg="missioncomputer">Mission BBS (${compOffers})</button>`
      : ''
  }</div>`;
  out += html`<div class="wallet"><b>${wallet.credits.toLocaleString('en-US')}</b> credits ·
    cargo ${cargoUsed()}/${holds} tons${missionLog.count ? ` · ${missionLog.count} active mission${missionLog.count > 1 ? 's' : ''}` : ''}</div>
    <div class="hint">Take Off ▲ (top-right) — or press Esc</div>`;
  return out;
}

const landedActions = { service: (kind) => openService(kind) };
export const landedDialog = new Dialog('landed', 'landedCard', landedBody, landedActions);
// Re-render the hub in place (e.g. closeService refreshes the wallet line on
// returning from a shop). Kept as renderPlanetScreen so existing callers, which
// relied on its innerHTML side effect, need no change.
export function renderPlanetScreen() {
  landedDialog.refresh();
}
// Closing a landed service (ui/services.closeService) fires this so the hub
// refreshes without ui/services having to import — and depend on — this module.
document.addEventListener('ve:serviceclosed', () => renderPlanetScreen());
