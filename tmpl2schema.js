#!/usr/bin/env node
/*
 * tmpl2schema.js — Generate evrsrc decode schemas from the TMPL resources
 * that ship inside EV's own data files.
 *
 * ResEdit TMPL format: repeated [Pascal-string label][4-char type code].
 * EV's templates use only: DWRD DLNG HWRD HLNG RECT CSTR.
 *
 * Usage:
 *   node tmpl2schema.js "EV_data/EV Data.rsrc" -o schemas/
 *
 * Each TMPL resource's *name* is the record type it describes (sÿst, shïp,
 * ...), so output files are named schemas/<ascii-alias>.json and record
 * exactly which file+TMPL they came from.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadFork, parseFork, macRomanToString } = require('./evrsrc.js');

// TMPL code -> evrsrc decodeRecord type (repeat count for expansions)
const CODE_MAP = {
  DBYT: ['i8'],
  UBYT: ['u8'],
  HBYT: ['u8'],
  DWRD: ['i16'],
  UWRD: ['u16'],
  HWRD: ['u16'],
  DLNG: ['i32'],
  ULNG: ['u32'],
  HLNG: ['u32'],
  RECT: ['i16', 4],
  CSTR: ['cstr'],
};

function parseTmpl(buf) {
  const fields = [];
  let off = 0;
  while (off < buf.length) {
    const len = buf[off];
    const label = macRomanToString(buf.subarray(off + 1, off + 1 + len));
    off += 1 + len;
    const code = buf.subarray(off, off + 4).toString('latin1');
    off += 4;
    fields.push({ label, code });
  }
  return fields;
}

function toSchema(tmplName, fields, source) {
  const out = [];
  for (const { label, code } of fields) {
    const m = CODE_MAP[code];
    if (!m) throw new Error(`TMPL '${tmplName}': unmapped code '${code}' (${label})`);
    const name = label.replace(/[^\w]/g, '');
    out.push(m[1] ? [name, m[0], m[1]] : [name, m[0]]);
  }
  return { name: tmplName, source, fields: out };
}

function asciiAlias(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]/g, '_').toLowerCase();
}

function main() {
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const outDir = oi >= 0 ? args.splice(oi, 2)[1] : 'schemas';
  const file = args[0];
  if (!file) {
    console.error('usage: tmpl2schema.js <datafile> [-o outdir]');
    process.exit(1);
  }

  const src = loadFork(file);
  const types = parseFork(src.fork);
  const tmpl = types.find((t) => t.typeHex === '544d504c');
  if (!tmpl) throw new Error(`${file}: no TMPL resources`);

  fs.mkdirSync(outDir, { recursive: true });
  for (const r of tmpl.resources) {
    if (!r.name) {
      console.warn(`TMPL ${r.id}: unnamed, skipped`);
      continue;
    }
    const fields = parseTmpl(r.data());
    const schema = toSchema(r.name, fields, `TMPL ${r.id} ("${r.name}") in ${path.basename(file)}`);
    const dest = path.join(outDir, `${asciiAlias(r.name)}.json`);
    fs.writeFileSync(dest, JSON.stringify(schema, null, 2) + '\n');
    const fixed = schema.fields.reduce(
      (n, [, t, rep]) =>
        n + (t === 'cstr' ? 0 : { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4 }[t] * (rep || 1)),
      0,
    );
    console.log(
      `${dest}  ${schema.fields.length} fields, ` +
        (schema.fields.some(([, t]) => t === 'cstr') ? `${fixed}B fixed + variable` : `${fixed}B`),
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}

module.exports = { parseTmpl, toSchema };
