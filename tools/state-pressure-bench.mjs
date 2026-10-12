// Local microbenchmarks, not a production-capacity or end-to-end latency estimate.
// node --expose-gc tools/state-pressure-bench.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeMatch } from '../test/match/harness.js';
import { publicStateJson } from '../server/match/match/messaging.js';
import { OutboundQueue } from '../server/outboundQueue.js';

const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const legacyJson = view => { const { serverNow: _clock, ...rest } = view; return JSON.stringify(rest); };
const h = makeMatch({ mode: 'coop', humans: 4, fake: true, seed: 91 }).start();
try {
  h.toPrep(1);
  const view = h.m.publicView();
  assert.equal(publicStateJson(view), legacyJson(view));
  const counts = 20000, timings = { copy: [], inPlace: [] };
  for (const encode of [legacyJson, publicStateJson]) for (let n = 0; n < 2000; n++) encode(view);
  for (let sample = 0; sample < 6; sample++) {
    for (const [name, encode] of sample % 2 ? [['inPlace', publicStateJson], ['copy', legacyJson]] : [['copy', legacyJson], ['inPlace', publicStateJson]]) {
      globalThis.gc?.();
      const cpu = process.cpuUsage(), start = performance.now();
      for (let n = 0; n < counts; n++) encode(view);
      const used = process.cpuUsage(cpu);
      timings[name].push({ ms: performance.now() - start, cpuMs: (used.user + used.system) / 1000 });
    }
  }
  const encoding = Object.fromEntries(Object.entries(timings).map(([name, rows]) => [name, {
    medianMs: +median(rows.map(r => r.ms)).toFixed(2), medianCpuMs: +median(rows.map(r => r.cpuMs)).toFixed(2),
  }]));
  const scope = {}, queueResults = [];
  for (const coalesce of [false, true]) {
    const queue = new OutboundQueue();
    const start = performance.now();
    for (let n = 0; n < 1000; n++) for (const kind of ['m.public', 'm.private']) {
      const data = JSON.stringify({ t: kind, playerId: 'p1', n, stable: 'x'.repeat(8192) });
      queue.push({ data, bytes: Buffer.byteLength(data), kind, scope, owner: kind === 'm.private' ? 'p1' : null }, coalesce);
    }
    const pendingFrames = queue.size, pendingBytes = queue.bytes;
    let drained = 0;
    while (queue.shift()) drained++;
    queueResults.push({ coalesce, pendingFrames, pendingBytes, drained, elapsedMs: +(performance.now() - start).toFixed(2) });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, iterations: counts,
    publicBytes: Buffer.byteLength(legacyJson(view)), encoding, slowQueue: queueResults }, null, 2));
} finally { h.m.dispose(); }
