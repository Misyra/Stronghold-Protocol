// test/ui/render-prewarm.test.js — 对局渲染引擎的空闲预热（ui/renderPrewarm.js）：每个页面只预热一次
//（第二次 arm() 是空操作）、只调度一个空闲回调、失败只记日志从不抛出；浏览器有 requestIdleCallback
// 时优先用它（不设 timeout，天然让路给开场动画等），否则退到 1–2 s 的定时器。「预热的就是挂载对局时
// import 的同一模块」是源码形状断言：renderPrewarm.js 与 ui/fieldHost.js 持有完全相同的动态 import 说明
// 符，构建下两者落到同一 chunk（vite.config.js），源码页下两者解析到同一原生 URL——Node 这边不真的
// import render/app.js（浏览器专用模块，依赖 PIXI/DOM）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createRenderPrewarm } = await import('../../public/js/ui/renderPrewarm.js');

test('arm() 只调度一个空闲回调；第二次 arm() 是空操作', () => {
  const fired = [];
  let imports = 0;
  const prewarm = createRenderPrewarm({
    import: async () => { imports++; },
    schedule: (fire) => { fired.push(fire); },
  });
  prewarm.arm();
  prewarm.arm();
  prewarm.arm();
  assert.equal(fired.length, 1, '一个页面生命周期只调度一次');
  assert.equal(imports, 0, '调度时还不 import');
  fired[0]();
  assert.equal(imports, 1, '空闲回调触发的是同一次 import');
});

test('import 失败只记日志，从不抛出（无未处理拒绝）', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const prewarm = createRenderPrewarm({ import: () => Promise.reject(new Error('offline')), schedule: (fire) => fire() });
    prewarm.arm(); // 同步路径上不得抛
    await sleep(5); // 让拒绝落定；node:test 会把未处理拒绝判为失败
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, '一条 console.warn');
  assert.match(String(warnings[0][0]), /render prewarm/);
});

test('有 requestIdleCallback 就等它；没有则定时器兜底（1–2 s 预算）', async () => {
  let imports = 0;
  const make = () => createRenderPrewarm({ import: async () => { imports++; } });
  // 浏览器形态：回调挂在 requestIdleCallback 上（带期限，防持续动画无限推迟），预热自己不跑
  let ricOpts = null;
  globalThis.requestIdleCallback = (fire, opts) => { globalThis.__spIdleFire = fire; ricOpts = opts; return 1; };
  try {
    make().arm();
    assert.equal(typeof globalThis.__spIdleFire, 'function', '回调交给了 requestIdleCallback');
    assert.ok(ricOpts && ricOpts.timeout >= 1000 && ricOpts.timeout <= 5000, 'rIC 带秒级期限');
    assert.equal(imports, 0, '空闲时机由浏览器定');
    delete globalThis.requestIdleCallback;
    delete globalThis.__spIdleFire;
    // Node 形态（无 rIC）：定时器兜底，落在 1–2 s 预算内
    const t0 = Date.now();
    make().arm();
    await sleep(1700);
    assert.equal(imports, 1, '兜底定时器触发了 import');
    assert.ok(Date.now() - t0 >= 1000, '兜底不早于 1 s');
  } finally {
    delete globalThis.requestIdleCallback;
    delete globalThis.__spIdleFire;
  }
});

test('预热的正是挂载对局时 import 的模块（源码形状）', () => {
  const prewarm = readFileSync(path.join(ROOT, 'public/js/ui/renderPrewarm.js'), 'utf8');
  const fieldHost = readFileSync(path.join(ROOT, 'public/js/ui/fieldHost.js'), 'utf8');
  const main = readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
  const spec = "import('../render/app.js')";
  assert.ok(prewarm.includes(spec), 'renderPrewarm.js 的动态 import 与 fieldHost.js 同一说明符');
  assert.ok(fieldHost.includes(spec), 'fieldHost.js 挂载时 import ../render/app.js');
  assert.ok(!/^\s*import\s/m.test(prewarm), 'renderPrewarm.js 自身无静态依赖（Node 可直接加载）');
  assert.match(prewarm, /requestIdleCallback/);
  assert.match(main, /renderPrewarm\.arm\(\)/, 'boot 里预热已上膛');
});
