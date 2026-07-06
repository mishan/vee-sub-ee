#!/usr/bin/env node
// Golden-trace runner, JS side. Emits {samples:[{frame,entities:[...]}]}.
// The C++ side is `evflight --trace <scenario>`; check_traces.js compares.
'use strict';

const fs = require('fs');
const EV = require('./core.js');

const scenario = JSON.parse(fs.readFileSync(process.argv[2] ||
  require('path').join(__dirname, 'scenario.json'), 'utf8'));

const ents = scenario.entities.map(e => {
  const s = EV.makeShip(
    { Speed: e.stats.Speed, Accel: e.stats.Accel, Maneuver: e.stats.Maneuver },
    e.x, e.y, e.heading);
  return { s, kind: e.kind, script: e.script || [], target: e.target || null, active: true };
});

function controlsAt(script, frame) {
  for (const seg of script)
    if (frame <= seg.until)
      return { left: !!seg.left, right: !!seg.right, retro: !!seg.retro, thrust: !!seg.thrust };
  return { left: false, right: false, retro: false, thrust: false };
}

const samples = [];
const sample = frame => samples.push({
  frame,
  entities: ents.map(({ s }) => ({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, heading: s.heading })),
});

sample(0);
for (let fr = 1; fr <= scenario.frames; fr++) {
  for (const e of ents) {
    if (e.kind === 'player') EV.stepPlayer(e.s, controlsAt(e.script, fr));
    else if (e.active) e.active = EV.stepTrader(e.s, e.target);
  }
  if (fr % scenario.sampleEvery === 0) sample(fr);
}
process.stdout.write(JSON.stringify({ samples }) + '\n');
