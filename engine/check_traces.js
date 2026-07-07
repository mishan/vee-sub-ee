#!/usr/bin/env node
// Golden-trace comparator: runs the JS core and the C++ port on the same
// scenario and requires agreement within TOL on every sampled value.
//
//   node engine/check_traces.js [scenario] [evflight-binary]
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const scenario = process.argv[2] || path.join(__dirname, 'scenario.json');
const binary = process.argv[3] || path.join(__dirname, '..', 'cpp', 'evflight');
const TOL = 1e-6;

const jsOut = JSON.parse(execFileSync(process.execPath,
  [path.join(__dirname, 'run_trace.js'), scenario], { encoding: 'utf8' }));
const cppOut = JSON.parse(execFileSync(binary, ['--trace', scenario],
  { encoding: 'utf8' }));

let checked = 0, worst = 0, failures = 0;
const nSamples = Math.min(jsOut.samples.length, cppOut.samples.length);
if (jsOut.samples.length !== cppOut.samples.length) {
  console.error(`sample count differs: js=${jsOut.samples.length} cpp=${cppOut.samples.length}`);
  failures++;
}
for (let i = 0; i < nSamples; i++) {
  const a = jsOut.samples[i], b = cppOut.samples[i];
  for (let e = 0; e < a.entities.length; e++)
    for (const k of ['x', 'y', 'vx', 'vy', 'heading', 'shields', 'armor']) {
      const av = a.entities[e][k], bv = b.entities[e][k];
      if (av === undefined && bv === undefined) continue; // optional on both sides
      if (av === undefined || bv === undefined || Number.isNaN(av) || Number.isNaN(bv)) {
        if (failures++ < 10)          // one-sided key or NaN is a hard failure
          console.error(`frame ${a.frame} entity ${e} ${k}: missing/NaN (js=${av} cpp=${bv})`);
        continue;
      }
      const d = Math.abs(av - bv);
      checked++;
      worst = Math.max(worst, d);
      if (d > TOL && failures++ < 10)
        console.error(`frame ${a.frame} entity ${e} ${k}: js=${av} cpp=${bv} (Δ${d.toExponential(2)})`);
    }
  const as = a.shots || [], bs = b.shots || [];
  if (as.length !== bs.length && failures++ < 10)
    console.error(`frame ${a.frame}: shot count js=${as.length} cpp=${bs.length}`);
  for (let s = 0; s < Math.min(as.length, bs.length); s++)
    for (const k of ['x', 'y']) {
      const av = as[s][k], bv = bs[s][k];
      if (av === undefined || bv === undefined || Number.isNaN(av) || Number.isNaN(bv)) {
        if (failures++ < 10)
          console.error(`frame ${a.frame} shot ${s} ${k}: missing/NaN (js=${av} cpp=${bv})`);
        continue;
      }
      const d = Math.abs(av - bv);
      checked++;
      worst = Math.max(worst, d);
      if (d > TOL && failures++ < 10)
        console.error(`frame ${a.frame} shot ${s} ${k}: Δ${d.toExponential(2)}`);
    }
}
console.log(`${checked} values compared, worst Δ = ${worst.toExponential(2)}, tolerance ${TOL}`);
if (failures) { console.error(`FAIL (${failures} mismatches)`); process.exit(1); }
console.log('PASS — JS core and C++ port agree');
