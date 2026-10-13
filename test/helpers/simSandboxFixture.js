// Shared Node/browser test adapter while WP-F supplies the production SDK registry. Never imported by app code.
import { createSimWorker } from '../../public/js/battle/simWorkerRuntime.js';
import { loadBrowserSim } from '../../public/js/battle/simLoader.js';
import { initializeSandbox, installSandboxPlugins } from '../../shared/plugins/sandbox.js';
import { escapeCases } from './sandboxCases.js';
import { createPluginCompartment } from '../../shared/plugins/sandbox.js';

export function fixtureRuntime({ base, loadSES, parse }) {
  const kits = Object.create(null);
  const loadMath = () => import(`${base}detmath.js`);
  const initialize = () => initializeSandbox({ loadSES, loadMath });
  const dispatch = createSimWorker({
    prepareScripts: async content => {
      await initialize();
      return () => installSandboxPlugins({ plugins: content.scripts, parse,
        createSDK: () => ({ registerKit: (id, factory) => { kits[id] = factory; } }) });
    },
    loadSim: async content => {
      const sim = await loadBrowserSim({ ...content, base });
      const { Battle } = await import(`${base}Battle.js`);
      const create = sim.spec.createBattleFromSpec;
      sim.spec = { ...sim.spec, createBattleFromSpec: (spec, ds, opts) => create(spec, ds, { ...opts,
        BattleClass: class extends Battle { constructor(o) { super({ ...o, kits }); } } }) };
      // A malformed data path which validation missed; isolates a truly blocked engine step, not a stalled fake port.
      if (content.data.__slow) {
        const original = sim.spec.createBattleFromSpec;
        sim.spec.createBattleFromSpec = (...args) => { const b = original(...args); b.step = () => { for (;;) { /* data loop */ } }; return b; };
      }
      return sim;
    },
  });
  return async (method, args) => {
    if (method === 'bounds') return (await import(new URL('../../shared/plugins/officialBounds.js', import.meta.url))).bbCap('times');
    if (method === 'escapes') {
      await initialize();
      const c = createPluginCompartment({});
      return escapeCases.map(([label, source, expected]) => {
        try { return { label, expected, value: c.evaluate(source) }; }
        catch { return { label, expected, value: 'throws' }; }
      });
    }
    return dispatch(method, args);
  };
}
