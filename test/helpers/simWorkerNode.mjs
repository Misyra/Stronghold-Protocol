import { parentPort } from 'node:worker_threads';
import { fixtureRuntime } from './simSandboxFixture.js';
import { parse } from 'acorn';
const dispatch = fixtureRuntime({ base: new URL('../../server/sim/', import.meta.url).href, loadSES: () => import('ses'), parse });
let queue = Promise.resolve();
parentPort.on('message', data => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id: data.id, value: await dispatch(data.method, data.args) }); }
    catch (e) { parentPort.postMessage({ id: data.id, error: { code: e.code, message: e.message } }); }
  });
});
