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

// Sniff whether a file's bytes are a native Vₑ JSON save rather than a binary EV
// Classic pilot fork: JSON begins with '{' past an optional UTF-8 BOM and any
// leading whitespace, whereas a pilot fork starts with binary magic. Sniffing the
// bytes (not the extension) means a misnamed .rsrc/.json still imports correctly.
export function looksLikeJSON(bytes) {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0; // UTF-8 BOM
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
  )
    i++;
  return bytes[i] === 0x7b; // '{'
}

// Parse a native Vₑ .json save (as produced by the Open Pilot "⤓ JSON" export)
// back into a save object, throwing a user-facing Error if the text isn't one.
// Only a light shape check: it must be a JSON object with an integer ship id and
// a known save version (v1 is migrated on load). This is the inverse of the
// exporter, not a schema validator — a hand-tweaked save is the user's own risk.
export function parsePilotJSON(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('not a valid JSON file');
  }
  if (
    !obj ||
    typeof obj !== 'object' ||
    Array.isArray(obj) ||
    !Number.isInteger(obj.ship) ||
    (obj.v !== 1 && obj.v !== 2)
  ) {
    throw new Error('not a Vₑ save (expected a JSON pilot export)');
  }
  return obj;
}

// Encode a Vₑ save into an original-EV pilot file and prompt the browser to save
// it. Pilots imported from a real file round-trip byte-faithfully; pilots born in
// Vₑ get a synthesized resource 129 (see pilot-codec's export note).
export function downloadPilotFile(save, DATA) {
  const bytes = codec.fromSave(save, DATA);
  const safe = (save.name || 'Pilot').replace(/[^\w .-]/g, '_');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.rsrc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
