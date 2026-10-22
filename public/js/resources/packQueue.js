import { checkAbort } from './common.js';

/** Two network producers, two queued ZIPs, one consumer. Producers can finish
 * their in-flight ZIP while the queue is full, then wait without starting more. */
export async function* downloadedPacks(plans, download, signal) {
  const controller = new AbortController();
  const queue = [], waiters = new Set();
  let next = 0, finished = 0;
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
        while (queue.length >= 2) await wait();
        checkAbort(controller.signal);
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
      const result = queue.shift(); wake();
      yield result;
    }
  } finally {
    controller.abort(); wake();
    signal?.removeEventListener('abort', abort);
    await Promise.all(producers);
  }
}
