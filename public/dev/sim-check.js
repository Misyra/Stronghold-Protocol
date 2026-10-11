// The cross-engine check page (docs/SIM.md「Cross-engine check」): this browser runs the golden battle corpus with the
// client's own sim loader (public/js/battle/runner.js loadBrowserSim) and compares every tick with the Node reference
// that `node tools/sim-check.mjs` wrote to /dev/simcheck/data/ — any device on the LAN can open it from the server.
import { mountCheck } from './simcheck/ui.js';
import { strongholdAdapter, scenariosOf } from './simcheck/stronghold.js';

const app = document.getElementById('app');
const get = async (url) => {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${url}`), { missing: r.status === 404 });
  return r.json();
};

try {
  const [doc, reference, { loadBrowserSim }, { APP_VERSION }] = await Promise.all([
    get('/dev/simcheck/data/specs.json'), get('/dev/simcheck/data/reference.json'), import('/js/battle/runner.js'), import('/shared/constants.js'),
  ]);
  const { spec, ds } = await loadBrowserSim();
  const scenarios = scenariosOf(doc);
  const FAMILIES = [['roster', '干员'], ['bonds', '盟约'], ['fields', '首领战场与联防'], ['standins', '补位'], ['diy', '自选']];
  const stale = reference.made && reference.made.version && reference.made.version !== APP_VERSION;
  mountCheck(app, {
    project: 'Stronghold Protocol',
    title: '模拟一致性检查',
    subtitle: '在这台设备的浏览器里运行黄金结果的整套战斗，逐帧与服务器（Node）的结果比较。浏览器自己模拟战斗、服务器再复算校验，两边必须逐位一致。'
      + (stale ? `<br><b style="color:var(--gold-2)">参考数据由 ${reference.made.version} 生成，这台服务器是 ${APP_VERSION}：请在服务器上重新运行 node tools/sim-check.mjs。</b>` : ''),
    adapter: strongholdAdapter({ spec, ds, doc }),
    scenarios,
    subsets: [
      { id: 'fast', label: '快速（黄金结果的快速子集）', pick: (sc) => sc.fast },
      { id: 'all', label: '全部', pick: () => true },
      ...FAMILIES.map(([id, label]) => ({ id, label, pick: (sc) => sc.family === id })),
    ],
    reference,
    info: [['游戏版本', APP_VERSION]],
  });
} catch (e) {
  app.innerHTML = '';
  const p = document.createElement('p');
  p.style.cssText = 'color:var(--text-md);padding:16px;max-width:760px;margin:0 auto;font:14px/1.6 var(--font-cjk)';
  p.textContent = e.missing
    ? '还没有参考数据：请在服务器的目录里运行 node tools/sim-check.mjs（生成 public/dev/simcheck/data/），然后刷新这个页面。'
    : `载入失败：${e && e.message || e}`;
  app.appendChild(p);
}
