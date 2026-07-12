/*
 * engine/shell/ui/pilot-import.js — the browser entry to the pilot importer.
 *
 * The actual decoding lives in the shared, environment-agnostic pilot-codec.js
 * (also used by the Node CLI evpilot.js) so the two can't drift. This module is
 * just the browser glue: an ArrayBuffer + file name → a Vₑ save.
 */
// pilot-codec is CommonJS; a DEFAULT import resolves to its module.exports under
// both esbuild and Node's ESM↔CJS interop (a named `import { toSave }` would fail
// in Node, which can't see named exports of a CJS module).
import codec from '../../../pilot-codec.js';

// Decode a selected .rsrc File's ArrayBuffer into a Vₑ save (throws a
// user-facing Error if it isn't an EV Classic pilot). `DATA` is the game DB.
export function decodePilotFile(arrayBuffer, filename, DATA) {
  return codec.toSave(new Uint8Array(arrayBuffer), filename, DATA);
}
