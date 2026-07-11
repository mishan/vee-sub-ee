// engine/shell/main.js — ES-module entry for the browser flight shell. esbuild
// bundles this into engine/shell.bundle.js (the /*__SHELL__*/ payload). The
// import list below is the canonical module load order; 01-state must stay first
// (it's the leaf that initializes the shared state every other module reads).
// Each alias mNN matches its file number, so the list is easy to audit.
import * as m01 from './01-state.js';
import * as m02 from './02-spawning.js';
import * as m03 from './03-sound.js';
import * as m04 from './04-combat.js';
import * as m05 from './05-input.js';
import * as m06 from './06-interaction.js';
import * as m07 from './07-trade.js';
import * as m08 from './08-missions.js';
import * as m09 from './09-step.js';
import * as m10 from './10-render.js';
import * as m11 from './11-title.js';
import * as m12 from './12-boarding.js';
import * as m13 from './13-legal.js';
import * as m14 from './14-landing.js';
import * as m15 from './15-main.js';

// Inline HTML event handlers (onclick="closeService()", the 2x pill's
// toggleFastForward(), dialog buttons, …) can only reach GLOBAL names, but the
// bundle scopes everything inside its IIFE — so re-expose every module's
// exports, plus the shared state object S, on globalThis as the HTML bridge.
// Inside the shell, modules still use explicit imports; this is only for the
// inline handlers. (Primitives a handler reassigns live on S, so the handler
// mutates the same object the module reads.) Runs after all bodies initialize.
Object.assign(globalThis, m01, m02, m03, m04, m05, m06, m07, m08, m09, m10, m11, m12, m13, m14, m15);
