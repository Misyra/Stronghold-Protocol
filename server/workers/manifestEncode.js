// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { rewriteAssetPaths } from '../../shared/cdn.js';

parentPort.on('message', async ({ id, payload: { file, cdn } }) => {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const bytes = new TextEncoder().encode(JSON.stringify(rewriteAssetPaths(JSON.parse(raw), cdn)));
    parentPort.postMessage({ id, value: bytes }, [bytes.buffer]);
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
