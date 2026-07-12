/*
 * engine/shell/ui/html.js — the auto-escaping HTML template primitive used by
 * every screen. A leaf that imports nothing, so it can load before 01-state (the
 * state leaf imports `html` from here for its own new-pilot dialog). Moved out of
 * 01-state per OOP_DESIGN.md's "Separating UI from logic" (slice 4): a pure UI
 * primitive doesn't belong in the state leaf.
 */

// Escape untrusted game-data strings interpolated into innerHTML by the html``
// tag. Escapes quotes as well as &<> because the tag is also used inside quoted
// HTML attributes (onclick, style, …), where an unescaped quote would break out
// of the attribute. (Quote-escaping stops attribute breakout, not script
// injection — inline JS handler attributes must still never take untrusted
// values.)
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
// Auto-escaping HTML template tag. `html`...`` escapes every ${interpolation}
// unless it is trusted markup — the result of another html`` (below) or wrapped
// in raw(). An array interpolates each element the same way and joins them, so a
// list of html`` fragments composes without escaping while a stray plain string
// in the array is still escaped. Since data values default to escaped, dialogs
// can't be XSS'd by a modified data fork, and nested fragments never re-escape.
export class SafeHtml {
  constructor(s) {
    this.value = s;
  }
  toString() {
    return this.value;
  }
}
export function raw(s) {
  return new SafeHtml(s == null ? '' : String(s));
} // opt out: trust this markup
export function html(strings, ...values) {
  const render = (v) =>
    v instanceof SafeHtml
      ? v.value
      : Array.isArray(v)
        ? v.map(render).join('')
        : escapeHtml(v == null ? '' : v);
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
