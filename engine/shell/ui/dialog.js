/*
 * engine/shell/ui/dialog.js — DOM-only base for the modal service dialogs.
 *
 * No game imports (no S, no DATA), so it can be unit-tested under node + jsdom
 * (see test/dialog.test.mjs). A Dialog is a pure render() → SafeHtml (the wrapper
 * the shell's html`` tag returns) — or any string-coercible value, since
 * refresh() just assigns it to innerHTML — plus the plumbing to mount it in a
 * panel/card, refresh it in place, and hide it.
 *
 * It also owns its buttons. Instead of inline onclick="fn()" — which only reaches
 * global names (the reason for the shell's globalThis bridge) — clickable
 * elements carry data-action="name" and optionally data-arg="…", and one
 * delegated click listener on the card routes them to this.actions[name](arg).
 * The listener lives on the card element itself, not its children, so it survives
 * the innerHTML swap that refresh() performs. (docs/OOP_DESIGN.md, phase 4.)
 */
export class Dialog {
  constructor(panelId, cardId, render, actions = {}) {
    this.panelId = panelId;
    this.cardId = cardId;
    this.render = render;
    this.actions = actions;
  }

  refresh() {
    document.getElementById(this.cardId).innerHTML = this.render();
  }

  open() {
    this.refresh();
    const card = document.getElementById(this.cardId);
    // Exactly one delegated listener per card, re-created on each open so it
    // routes to *this* dialog's actions (dialogs share the 'serviceCard').
    if (card._dlgClick) card.removeEventListener('click', card._dlgClick);
    card._dlgClick = (e) => {
      // e.target may not be an Element (text node, document, odd synthetic
      // events); only Elements have closest(), so guard rather than throw.
      const t = e.target;
      const el = t && typeof t.closest === 'function' ? t.closest('[data-action]') : null;
      if (!el || !card.contains(el)) return;
      const fn = this.actions[el.dataset.action];
      if (fn) {
        e.preventDefault();
        fn(el.dataset.arg);
      }
    };
    card.addEventListener('click', card._dlgClick);
    document.getElementById(this.panelId).style.display = 'flex';
  }

  close() {
    const card = document.getElementById(this.cardId);
    if (card._dlgClick) {
      card.removeEventListener('click', card._dlgClick);
      card._dlgClick = null;
    }
    document.getElementById(this.panelId).style.display = 'none';
  }
}

/* A `View` is the landed-service flavour of `Dialog`: it also tracks which one is
 * showing. `activeView` is whichever View is up (null = none); the shell reads it
 * to know a service dialog is open (pause the sim, swallow keys, Esc closes it).
 * Kept here in the DOM-only base — no game imports — so it stays a leaf that the
 * concrete registry (ui/services.js) and every dialog can construct at init. */
export let activeView = null;
export class View extends Dialog {
  open() {
    activeView = this;
    super.open();
  }
  close() {
    if (activeView === this) activeView = null;
    super.close();
  }
}
export const refreshView = () => {
  if (activeView) activeView.refresh();
};
