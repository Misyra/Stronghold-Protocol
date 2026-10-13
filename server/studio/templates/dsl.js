// server/studio/templates/dsl.js — the template 「数据插件里的 DSL」 (server/studio/templates/index.js): a content plugin
// with one operator whose kit is a DSL spec, and one prep spec. No target: the ids are the plugin's own namespace.
// [ASSUMED] The example operator is a passive +50% attack, and the prep file sets round-1 income to 15 (DESIGN §32.7).

/** JSON the studio and the tool write (two spaces, a final newline). @param {unknown} value */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** A compact operator whose kit is DSL. The spec names this plugin; the builder still stamps the record. @param {string} id */
function operator(id) {
  const ns = id.replace(/-/g, '_');
  return {
    op: 1,
    charId: `char_x_${ns}_caster`,
    name: 'Demo caster',
    profession: 'CASTER',
    subProfessionId: 'corecaster',
    position: 'RANGED',
    rarity: 3,
    as: 'both',
    chess: { tier: 1, bonds: ['deputShip'] },
    forms: {
      normal: { stats: { maxHp: 2000, atk: 200, def: 50, bat: 1.2, blockCnt: 1 }, rangeGrid: [[0, 0], [0, 1]] },
      elite: { stats: { maxHp: 3000, atk: 300, def: 80, bat: 1.2, blockCnt: 1 }, rangeGrid: [[0, 0], [0, 1]] },
    },
    skills: [{ skillId: `skx_${ns}_caster_1`, name: 'Cast', duration: 10, spCost: 10, initSp: 10, default: true }],
    trait: { desc: 'Ranged arts' },
    kit: { dsl: { dsl: 1, pluginId: id, skill: { kind: 'passive', mods: { atkPct: 0.5 } } } },
    art: { ref: 'char_199_yak' },
  };
}

/** A prep spec. [ASSUMED] A manifest dsl file must carry meta, and the key is effect:<this plugin id>:<local>. @param {string} id */
function income(id) {
  return {
    dsl: 1,
    pluginId: id,
    meta: {
      key: `effect:${id}:income`,
      on: [{ when: 'income', if: { round: 1 }, do: [{ funds: { amount: 15, setIncome: true } }] }],
    },
  };
}

/** @type {import('./index.js').StudioTemplate} */
export default {
  id: 'dsl',
  class: 'content',
  kinds: [],
  slots() { return []; },
  overlay() { return {}; },
  /**
   * A content manifest and its two JSON files. `target` is ignored: this template has no official target.
   * @param {{ id: string, manifest: Record<string, any> }} opts
   */
  assemble({ id, manifest }) {
    const ns = id.replace(/-/g, '_');
    manifest.scope = ['room'];
    manifest.permissions = ['data.add', 'dsl'];
    manifest.operators = [`operators/${ns}.json`];
    manifest.dsl = ['dsl/income.json'];
    return {
      manifest,
      files: {
        [`operators/${ns}.json`]: json(operator(id)),
        'dsl/income.json': json(income(id)),
      },
    };
  },
};
