// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
import { parentPort, workerData } from 'node:worker_threads';
import { createPluginRegistry } from '../plugins/registry.js';

let lines = [];
const log = { info: (text) => lines.push(['info', text]), warn: (text) => lines.push(['warn', text]) };
const registry = createPluginRegistry(workerData.dirs, { ...workerData.options, log });
let previous = null;
parentPort.on('message', ({ id, payload }) => {
  try {
    lines = [];
    if (payload.scriptHost !== undefined) registry.setScriptHost(payload.scriptHost);
    if (payload.force) registry.rescan(); else registry.refresh(true);
    const snapshot = registry.snapshot();
    snapshot.vanilla ||= registry.vanillaAssets();
    const changed = snapshot !== previous || payload.scriptHost !== undefined;
    parentPort.postMessage({ id, value: { snapshot: changed ? snapshot : null, lines } });
    previous = snapshot;
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
