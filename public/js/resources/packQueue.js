import { checkAbort } from './common.js';

/** Queued-ZIP byte budget. The importer (Cache Storage writes) is usually the slow side, so without a generous
 * buffer the two lanes stall whenever it falls behind — downloads wait for queue space instead of running ahead.
 * Bytes, not a pack count, because packs range from ~1 MB to the 16 MB cap. Worst case stays bounded: this buffer
 * plus the two lanes' finished-but-parked ZIPs (≤16 MB each). */
const QUEUE_BUFFER_BYTES = 96 * 1024 * 1024;

/** Two network producers, one byte-budgeted queue of ZIPs, one consumer. A producer parks its finished ZIP only
 * while the queued bytes exceed the budget, then waits without starting more; the consumer's shift wakes it.
 * `bufferBytes` exists for tests: a tiny budget replays the old small-queue backpressure deterministically. */
export async function* downloadedPacks(plans, download, signal, { bufferBytes = QUEUE_BUFFER_BYTES } = {}) {
  const controller = new AbortController();
  const queue = [], waiters = new Set();
  let next = 0, finished = 0, queuedBytes = 0;
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const abort = () => { controller.abort(signal.reason); wake(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const wait = async () => {
    checkAbort(controller.signal);
    await new Promise((resolve) => waiters.add(resolve));
    checkAbort(controller.signal);
  };
  const producer = async () => {
    try {
      while (next < plans.length) {
        checkAbort(controller.signal);
        const index = next++;
        let value, error;
        try { value = await download(plans[index], index, controller.signal); }
        catch (failure) { checkAbort(controller.signal); error = failure; }
        // The condition is about the queue, never the parked ZIP itself: a lone oversized download must still
        // find an empty queue and go through instead of waiting for a drain that only it could unlock.
        while (queuedBytes >= bufferBytes) await wait();
        checkAbort(controller.signal);
        queuedBytes += value?.byteLength ?? 0;
        queue.push({ plan: plans[index], index, value, error }); wake();
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { finished++; wake(); }
  };
  const producers = [producer(), producer()];
  try {
    while (queue.length || finished < producers.length) {
      checkAbort(controller.signal);
      if (!queue.length) { await wait(); continue; }
      const result = queue.shift();
      queuedBytes -= result.value?.byteLength ?? 0;
      wake();
      yield result;
    }
  } finally {
    controller.abort(); wake();
    signal?.removeEventListener('abort', abort);
    await Promise.all(producers);
  }
}
