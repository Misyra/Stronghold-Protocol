// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// Dedicated to persistence so encoding a checkpoint never waits behind battle simulation or AI rehearsal
// (server/workers/pool.js). Encodes one match capture per request and answers with the clock envelope plus the
// clock-free body as JSON text — the Persister writes that text to disk verbatim when a shard changed.

import { parentPort } from 'node:worker_threads';
import { encodeMatchCapture } from '../match/snapshot.js';
import { memorySample } from './memory.js';

parentPort.on('message', ({ id, payload }) => {
  try {
    const checkpoint = encodeMatchCapture(payload.capture);
    if (!checkpoint) throw new Error('match checkpoint could not be encoded');
    // The clocks travel outside the body: they tick in real time, so leaving them in would mark every unchanged
    // room dirty. server/persist.js merges them back in before a restore (document clocks envelope).
    const { deadlineRemainingMs, startedAtAgoMs, ...body } = checkpoint;
    parentPort.postMessage({ id, clocks: { deadlineRemainingMs, startedAtAgoMs }, body: JSON.stringify(body), memory: memorySample() });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
