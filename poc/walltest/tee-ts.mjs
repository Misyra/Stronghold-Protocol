#!/usr/bin/env node
// poc/walltest/tee-ts.mjs — stdin lines → "<epoch ms> <line>" to stdout and (with --file F, appended) to F.
// The timestamped form is what loadgen --loop-log reads back ([loop] windows need a wall clock, the server's own
// [loop] lines carry none). EPIPE-tolerant: the pipeline consumer may go away when the run ends.
import { createWriteStream } from 'node:fs';

const idx = process.argv.indexOf('--file');
const file = idx > 0 ? process.argv[idx + 1] : null;
const out = file ? createWriteStream(file, { flags: 'a' }) : null;
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

let buf = '';
const emit = (line) => {
  if (!line.trim()) return;
  const stamped = `${Date.now()} ${line}`;
  if (out) out.write(`${stamped}\n`);
  if (!process.stdout.destroyed) process.stdout.write(`${stamped}\n`);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); }
});
process.stdin.on('end', () => { emit(buf); if (out) out.end(); });
