// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { assetCdnUrl } from '../../shared/assetCdn.js';

/** 数据清单的出站改写，assetCdnUrl 语义（递归）：清单列内的 /assets|fonts|media 逐文件 `?v=<hash>`，
 *  列外/非美术/已远址恒等。此前的 rewriteAssetPaths 只加 CDN 前缀不加 ?v= —— R2 对裸地址回一年
 *  immutable，重传后的旧字节对拿过它的客户端永久冻结（audio.js 直读与数据内嵌引用都吃这里，
 *  2026-11-09 审查；版本化地址的 release.transform 一直是钉版的，两路在此对齐）。 */
const rewrite = (value, cdn) => {
  if (typeof value === 'string') return assetCdnUrl(value, cdn);
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) value[k] = rewrite(v, cdn);
  return value;
};

parentPort.on('message', async ({ id, payload: { file, cdn, hashes } }) => {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const bytes = new TextEncoder().encode(JSON.stringify(rewrite(JSON.parse(raw), { base: cdn, hashes })));
    parentPort.postMessage({ id, value: bytes }, [bytes.buffer]);
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
