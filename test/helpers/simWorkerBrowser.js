import { fixtureRuntime } from './simSandboxFixture.js';
import { parse } from '/vendor/acorn.mjs';
const dispatch = fixtureRuntime({ base: '/sim/', loadSES: () => import('/vendor/ses.umd.js'), parse });
let queue = Promise.resolve();
globalThis.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      let value;
      if (data.method === 'network') {
        try { await fetch('/probe-network'); value = 'allowed'; } catch { value = 'blocked'; }
      } else value = await dispatch(data.method, data.args);
      globalThis.postMessage({ id: data.id, value });
    } catch (e) { globalThis.postMessage({ id: data.id, error: { code: e.code, message: String(e.message) } }); }
  });
};
