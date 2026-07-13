// engine/shell/main.js — ES-module entry for the browser flight shell. esbuild
// bundles this into engine/shell.bundle.js (the /*__SHELL__*/ payload). Each
// import loads and initializes a module for its side effects; the order below is
// the canonical load order (01-state must stay first — it's the leaf that
// initializes the shared state every other module reads).
//
// There is no globalThis bridge: dialog buttons route through the Dialog's
// data-action delegation, and the few persistent chrome buttons (Take Off,
// ◀ Back, the 2× pill) self-bind with addEventListener in their owning modules,
// so no shell export needs to be exposed as a global. (EV/DATA/MANIFEST/NAMES
// stay ambient globals — they come from the enclosing flight.html <script>, not
// from here.)
import './01-state.js';
import './02-spawning.js';
import './03-sound.js';
import './04-combat.js';
import './05-input.js';
import './06-interaction.js';
import './07-trade.js';
import './08-missions.js';
import './09-step.js';
import './ui/render.js';
import './11-title.js';
import './12-boarding.js';
import './13-legal.js';
import './ui/landing.js';
import './14-landing.js';
import './15-pers.js';
import './17-main.js';
import './ui/map.js';
import './ui/active-missions.js';
import './ui/missionboard.js';
import './ui/services.js';
