/*
 * engine/shell/save.js — the pilot save store (localStorage roster + slots).
 *
 * The persistence machinery split out of 01-state.js: the multi-pilot roster,
 * per-slot read/write with a write-back verify, the legacy-blob import drop-box,
 * and the v1→v2 record migration. It operates on plain save objects (the schema
 * that 01-state's `Save.capture`/`fresh` build) and touches only `localStorage`
 * and the `DATA` global — so it imports nothing from the rest of the shell and
 * stays a leaf. 01-state composes it into the `Save` facade callers use:
 *   Save = { capture, fresh, ...PilotStore }
 * — the state-reading snapshot methods live with the state, the storage lives
 * here. esbuild bundles it (entry: main.js). Because it reads `localStorage` /
 * `DATA` only inside method bodies, it imports in node and the roster/slot logic
 * is unit-tested with a fake localStorage (test/save.test.mjs). Normative:
 * ENGINE_SPEC "Persistence".
 */
export const PilotStore = {
  // v1 stored the legal record per government; v2 stores it per system. Expand
  // each govt's value onto the systems it controls so an old pilot keeps its
  // standing under the per-system model.
  migrateV1(p) {
    const rep = {};
    const syst = (DATA.types && DATA.types.syst) || {};
    for (const [id, s] of Object.entries(syst)) {
      const g = s && s.Govt >= 128 ? s.Govt : 128;
      if (p.rep && p.rep[g] != null) rep[id] = p.rep[g];
    }
    return { ...p, v: 2, rep };
  },

  /* ---- multi-pilot storage ----
   * Each pilot lives under its own key `ve_pilot:<id>`; `ve_roster` is the index
   * (light summaries for the Open Pilot list) and `ve_active` names the loaded
   * pilot. The old single `ve_pilot` blob is migrated into a roster slot once. */
  ROSTER: 've_roster',
  ACTIVE: 've_active',
  LEGACY: 've_pilot',
  slot: (id) => 've_pilot:' + id,
  _get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  _set(k, v) {
    try {
      const b = JSON.stringify(v);
      localStorage.setItem(k, b);
      return localStorage.getItem(k) === b;
    } catch {
      return false; // trust nothing on file://
    }
  },
  _summary(id, p) {
    return {
      id,
      name: p.name || 'Pilot',
      shipName: p.shipName || '',
      ship: p.ship,
      credits: p.credits,
      day: p.day || 0,
      strict: !!p.strict,
    };
  },
  // Absorb a stray single `ve_pilot` blob into the roster as a new active slot —
  // both the old single-save format and a pilot dropped in by `evpilot.js import`
  // (localStorage.setItem('ve_pilot', …)). Runs on every load, so it doubles as a
  // simple import drop-box even once you already have a roster.
  _migrateLegacy() {
    const legacy = this._get(this.LEGACY);
    if (!legacy) return;
    const id = this._newId();
    if (this._set(this.slot(id), legacy)) {
      const r = this._get(this.ROSTER) || [];
      r.push(this._summary(id, legacy));
      this._set(this.ROSTER, r);
      this._set(this.ACTIVE, id);
      try {
        localStorage.removeItem(this.LEGACY);
      } catch {
        // Removal failed (locked storage): neutralize the key so the next
        // roster()/load() doesn't re-import the same blob into a duplicate slot.
        // We're inside `if (this._set(...))`, so _set is working here.
        this._set(this.LEGACY, null);
      }
    }
  },
  _newId() {
    return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  },
  roster() {
    this._migrateLegacy();
    return this._get(this.ROSTER) || [];
  },
  activeId() {
    this._migrateLegacy();
    return this._get(this.ACTIVE);
  },
  // Read any pilot's stored save by id, exactly as it sits in localStorage
  // (no v1→v2 migration — the raw on-disk shape is what a JSON export/bug
  // report wants). null if the slot is missing or unparseable.
  read(id) {
    return this._get(this.slot(id));
  },
  // Load the currently active pilot (v1→v2 migrated), or null.
  load() {
    this._migrateLegacy();
    const id = this._get(this.ACTIVE);
    if (!id) return null;
    let p = this._get(this.slot(id));
    if (!p) return null;
    if (p.v === 1) p = this.migrateV1(p);
    return p && p.v === 2 ? p : null;
  },
  // Save the active pilot in place (used by savePilot). With no active pilot
  // yet, fall back to creating a slot.
  write(obj) {
    const id = this._get(this.ACTIVE);
    if (!id) return this.create(obj) != null;
    const ok = this._set(this.slot(id), obj);
    if (ok) {
      const r = this._get(this.ROSTER) || [];
      const i = r.findIndex((e) => e.id === id);
      if (i >= 0) r[i] = this._summary(id, obj);
      else r.push(this._summary(id, obj));
      this._set(this.ROSTER, r);
    }
    return ok;
  },
  // Merge a few fields into the active pilot's stored save in place, without a
  // full capture. Used for the new-pilot intro/tutorial flags, which change in
  // flight (not docked), where there's no meaningful position to capture yet.
  patch(fields) {
    const id = this._get(this.ACTIVE);
    if (!id) return;
    const p = this.read(id);
    if (!p) return;
    Object.assign(p, fields);
    this._set(this.slot(id), p);
  },
  // Add a new pilot slot and make it active (New Pilot / import). Returns its id.
  create(obj) {
    const id = this._newId();
    if (!this._set(this.slot(id), obj)) return null;
    const r = this._get(this.ROSTER) || [];
    r.push(this._summary(id, obj));
    this._set(this.ROSTER, r);
    this._set(this.ACTIVE, id);
    return id;
  },
  select(id) {
    this._set(this.ACTIVE, id);
  },
  remove(id) {
    try {
      localStorage.removeItem(this.slot(id));
    } catch {}
    const r = (this._get(this.ROSTER) || []).filter((e) => e.id !== id);
    this._set(this.ROSTER, r);
    if (this._get(this.ACTIVE) === id) this._set(this.ACTIVE, r.length ? r[r.length - 1].id : null);
  },
  // Abandon the active pilot (deselect, keep the roster) → back to the title.
  clear() {
    this._set(this.ACTIVE, null);
  },
};
