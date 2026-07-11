/*
 * engine/shell/ui/dialog.js — DOM-only base for the modal service dialogs.
 *
 * No game imports (no S, no DATA), so it can be unit-tested under node + jsdom
 * (see test/dialog.test.mjs). A Dialog is a pure render() → HTML string plus the
 * plumbing to mount it in a panel/card, refresh it in place, and hide it.
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
      const el = e.target.closest('[data-action]');
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
