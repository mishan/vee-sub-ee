// Unit tests for the DOM-only Dialog base (engine/shell/ui/dialog.js), run under
// jsdom so real click events exercise the data-action delegation. Run with
// `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Dialog } from '../engine/shell/ui/dialog.js';

function mount() {
  const dom = new JSDOM(`<div id="panel" style="display:none"><div id="card"></div></div>`);
  global.document = dom.window.document;
  global.MouseEvent = dom.window.MouseEvent;
  return dom;
}
const $ = (sel) => global.document.querySelector(sel);

test('open() renders into the card and shows the panel', () => {
  mount();
  const d = new Dialog('panel', 'card', () => '<b>hi</b>');
  d.open();
  assert.equal($('#card').innerHTML, '<b>hi</b>');
  assert.equal($('#panel').style.display, 'flex');
  d.close();
  assert.equal($('#panel').style.display, 'none');
});

test('data-action clicks route to the actions map with data-arg', () => {
  mount();
  const calls = [];
  const d = new Dialog(
    'panel',
    'card',
    () =>
      `<div data-action="pick" data-arg="133">row</div>
       <button data-action="accept">Accept</button>
       <button data-action="close">Done</button>
       <span>no action here</span>`,
    {
      pick: (arg) => calls.push(['pick', arg]),
      accept: () => calls.push(['accept']),
      close: () => calls.push(['close']),
    },
  );
  d.open();
  $('[data-action="pick"]').click();
  $('[data-action="accept"]').click();
  $('[data-action="close"]').click();
  $('span').click(); // not a data-action element → ignored
  assert.deepEqual(calls, [['pick', '133'], ['accept'], ['close']]);
});

test('a click on a child of a data-action element still routes (closest)', () => {
  mount();
  const calls = [];
  const d = new Dialog(
    'panel',
    'card',
    () => '<button data-action="hire" data-arg="128"><b>Hire</b></button>',
    {
      hire: (arg) => calls.push(arg),
    },
  );
  d.open();
  $('button b').click(); // click the inner <b>
  assert.deepEqual(calls, ['128']);
});

test('delegation survives refresh() (listener is on the card, not its children)', () => {
  mount();
  let n = 0;
  const d = new Dialog('panel', 'card', () => '<button data-action="go">go</button>', {
    go: () => n++,
  });
  d.open();
  $('[data-action="go"]').click();
  d.refresh(); // innerHTML replaced — the button is a new element
  $('[data-action="go"]').click();
  assert.equal(n, 2);
  d.close();
});

test('close() unbinds — no stray dispatch after close', () => {
  mount();
  let n = 0;
  const d = new Dialog('panel', 'card', () => '<button data-action="go">go</button>', {
    go: () => n++,
  });
  d.open();
  const btn = $('[data-action="go"]');
  d.close();
  btn.click(); // still in the DOM, but the listener was removed
  assert.equal(n, 0);
});

test('unknown data-action is ignored (no throw)', () => {
  mount();
  const d = new Dialog('panel', 'card', () => '<button data-action="nope">x</button>', {});
  d.open();
  assert.doesNotThrow(() => $('[data-action="nope"]').click());
});
