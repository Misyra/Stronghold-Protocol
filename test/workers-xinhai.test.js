// test/workers-xinhai.test.js — 从 xinhai 分支取来的两个 worker 单体：BackgroundClient（懒启动、有界寿命）与
// WorkerStateEncoder（对局状态增量编码）。它们只依赖 node:worker_threads 与本仓库的 shared/stateDelta.js。
//
// WorkerStateEncoder 的契约（见其源码与 server/match/host 的用法）：encode() 返回 { stream, seq, base, delta }。
// 首帧与"补丁比全量还大"的帧 delta 为 null —— 由调用方发全量；内容没变时直接复用上一帧对象（序号也不动）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BackgroundClient } from '../server/workers/backgroundClient.js';
import { WorkerStateEncoder } from '../server/workers/stateEncoder.js';

test('WorkerStateEncoder: 首帧全量、增量带基线、未变化复用同一帧、私人流按玩家隔离', () => {
  const enc = new WorkerStateEncoder();
  assert.equal(enc.encode('bogus', '{}'), undefined, '不是状态消息就不编码');
  assert.equal(enc.encode('m.public', 5), undefined, '编码必须是字符串');

  const a = enc.encode('m.public', '{"rooms":[],"x":1}');
  assert.equal(a.seq, 1);
  assert.equal(a.base, undefined, '首帧没有基线 ⇒ 调用方发全量');
  assert.equal(a.delta, null);

  const same = enc.encode('m.public', '{"rooms":[],"x":1}');
  assert.equal(same, a, '内容没变：同一帧对象，序号不动');

  const changed = enc.encode('m.public', '{"rooms":[],"x":2}');
  assert.equal(changed.seq, 2);
  assert.equal(changed.base, 1, '基线指向前一帧');
  assert.ok(changed.delta === null || typeof changed.delta === 'string');

  const priv = enc.encode('m.private', '{"hand":[1]}', 'p1');
  assert.equal(priv.seq, 3, '私人流也是同一序号池');
  assert.equal(priv.base, undefined, 'p1 的首帧');
  const priv2 = enc.encode('m.private', '{"hand":[2]}', 'p2');
  assert.equal(priv2.base, undefined, '另一个玩家的私人流独立');
});

test('BackgroundClient: 关闭后拒绝新任务，不抛到调用方之外', async () => {
  const client = new BackgroundClient(new URL('../server/workers/manifestEncode.mjs', import.meta.url), {}, 1000);
  await client.close();
  await assert.rejects(() => client.request({}), /closed/);
});

test('manifestEncode worker: 把清单文件里的 /assets/ 地址改写到 CDN 基址', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-manifest-'));
  const file = path.join(dir, 'm.json');
  fs.writeFileSync(file, JSON.stringify({ files: [{ url: '/assets/x.png' }, { url: '/data/x.json' }] }), 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new BackgroundClient(new URL('../server/workers/manifestEncode.js', import.meta.url), {}, 5000);
  t.after(() => client.close());
  const bytes = await client.request({ file, cdn: 'https://cdn.example.test/game' });
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(doc.files[0].url, 'https://cdn.example.test/game/assets/x.png', '素材地址被改写');
  assert.equal(doc.files[1].url, '/data/x.json', '数据地址不动');
});
