/*
 * engine/shell/landing-rules.js — the pure landing-request state machine, lifted
 * out of 14-landing.js so it imports in node and is unit-tested directly
 * (test/landing-rules.test.mjs). Same UI/logic split as legal-rules /
 * trade-rules / missions-rules (docs/OOP_DESIGN.md "Separating UI from logic").
 *
 * The landing sequence is request → clearance → touchdown (spec: "Landing").
 * These functions decide *what happens*, given plain booleans the shell computes
 * (is a request already active for this planet, is the port denying us, are we
 * in the landing radius, are we moving too fast). 14-landing.js maps the result
 * to messages, the comm sound, S.landing, and doLand — nothing here touches the
 * DOM, the audio, or the live game state.
 */

/* Decide the outcome of pressing L.
 *
 * `active`  — a landing request is already open for this same planet.
 * `denied`  — the port refuses (governed port policing a criminal here).
 * `inRange` — within the landing radius (LAND_DIST).
 * `tooFast` — moving faster than the landing speed cap (LAND_SPEED).
 * `cleared` — the open request has already been cleared for touchdown.
 *
 * Returns { action, cleared? }:
 *   'deny'     — refused; no request is opened/kept.
 *   'request'  — a new request opens; `cleared` says whether the port also
 *                clears you immediately (you were already in range) or puts you
 *                on approach. The opening press never touches down.
 *   'tooFar'   — request already open, still outside the radius.
 *   'tooFast'  — request open and in range, but moving too fast to set down.
 *   'clear'    — in range and slow, but not yet cleared: announce clearance
 *                rather than landing. Keeps request → clearance → touchdown in
 *                order even if the player presses L the same frame they cross
 *                into range, before the per-frame clearance poll has run.
 *   'land'     — cleared, in range, slow: touch down.
 */
export function decideLanding({ active, denied, inRange, tooFast, cleared }) {
  if (denied) return { action: 'deny' };
  if (!active) return { action: 'request', cleared: !!inRange };
  if (!inRange) return { action: 'tooFar' };
  if (tooFast) return { action: 'tooFast' };
  if (!cleared) return { action: 'clear' };
  return { action: 'land' };
}

/* Should the per-frame poll clear the pilot now? True once an open request for
 * the current nav target — not yet cleared, not denied — reaches the landing
 * radius. This is the "got close since initiating" auto-clearance. */
export function shouldClearOnApproach({ hasRequest, sameTarget, cleared, denied, inRange }) {
  return !!(hasRequest && sameTarget && !cleared && !denied && inRange);
}
