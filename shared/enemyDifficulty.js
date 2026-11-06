// Optional content-plugin difficulty, DESIGN §37.126. All absent paths retain official behaviour.
// [ASSUMED] Non-official challenge rules requested by the maintainer; no official balance data is changed.
import { N_ } from './i18n.js';

export const DIFFICULTY_TERMS = Object.freeze({
  hp: { label: N_('普通敌人生命'), max: 10, step: 0.5 },
  speed: { label: N_('敌人移动速度'), max: 3, step: 0.5 },
  count: { label: N_('普通敌人数量'), max: 3, step: 1 },
  atk: { label: N_('敌人攻击力'), max: 3, step: 0.5 },
  bossHp: { label: N_('领袖共享血量'), max: 10, step: 0.5 },
});
export const DIFFICULTY_PRESETS = Object.freeze([
  { name: N_('热身演练'), hp: 1.5, speed: 1, count: 1, atk: 1, bossHp: 1.5 },
  { name: N_('加压作战'), hp: 2, speed: 1, count: 2, atk: 1, bossHp: 2 },
  { name: N_('高危战线'), hp: 2.5, speed: 1.5, count: 2, atk: 1.5, bossHp: 2.5 },
  { name: N_('N18对掏来'), hp: 3, speed: 2, count: 2, atk: 2, bossHp: 3 },
]);
export const difficultyPreset = values => DIFFICULTY_PRESETS.find(p => Object.keys(DIFFICULTY_TERMS).every(k => p[k] === values[k]));
export const identityDifficulty = () => Object.fromEntries(Object.keys(DIFFICULTY_TERMS).map(k => [k, 1]));

/** Shared by the example manifest and the settings form; fixed and random values are stored independently. */
export function difficultySettings() {
  return {
    n18Mode: { type: 'enum', options: ['fixed', 'random'], default: 'fixed', label: { zh: N_('模式'), en: 'Mode' } },
    n18MaxTerms: { type: 'integer', min: 1, max: 5, default: 1, label: { zh: N_('每回合最多词条数'), en: 'Maximum modifiers per round' } },
    ...Object.fromEntries(['fixed', 'limit'].flatMap(group => Object.entries(DIFFICULTY_TERMS).map(([key, def]) => [
      `${group}_${key}`, { type: def.step === 1 ? 'integer' : 'number', min: 1, max: def.max, step: def.step,
        default: group === 'fixed' ? DIFFICULTY_PRESETS[0][key] : key === 'count' ? 1 : 1.5,
        label: { zh: def.label } },
    ]))),
  };
}

/** Closed, bounded data shape. Invalid plugin data is refused, never silently changed into another challenge. */
export function validEnemyDifficulty(v) {
  const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!obj(v) || Object.keys(v).some(k => !['mode', 'maxTerms', 'fixed', 'limits'].includes(k))
    || !['fixed', 'random'].includes(v.mode) || !Number.isInteger(v.maxTerms) || v.maxTerms < 1 || v.maxTerms > 5) return false;
  return ['fixed', 'limits'].every(group => obj(v[group]) && Object.keys(v[group]).length === 5
    && Object.entries(DIFFICULTY_TERMS).every(([key, def]) => {
      const n = v[group][key];
      return typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= def.max && Number.isInteger((n - 1) / def.step);
    }));
}

/** rng is an independent seeded stream provided by the match, never the shop/wave stream. */
export function rollEnemyDifficulty(config, rng, { round, boss = false }) {
  if (!validEnemyDifficulty(config)) return null;
  const values = identityDifficulty();
  if (config.mode === 'fixed') Object.assign(values, config.fixed);
  else {
    const pool = Object.keys(DIFFICULTY_TERMS).filter(k => config.limits[k] > 1 && (k !== 'bossHp' || boss));
    if (pool.length) {
      const n = 1 + rng.int(Math.min(config.maxTerms, pool.length));
      for (const key of rng.shuffle(pool).slice(0, n)) {
        const step = DIFFICULTY_TERMS[key].step;
        values[key] = 1 + step * (1 + rng.int((config.limits[key] - 1) / step));
      }
    }
  }
  return { round, mode: config.mode, boss, values };
}

/** Bounded copy for locally imported/exported match records. Unknown fields never enter persistent storage. */
export function normalizeDifficultyRecord(raw) {
  if (!raw || !validEnemyDifficulty(raw.config) || !Array.isArray(raw.rounds) || raw.rounds.length > 64) return null;
  const seen = new Set(), rounds = [];
  for (const p of raw.rounds) {
    if (!p || !Number.isInteger(p.round) || p.round < 1 || p.round > 1000 || seen.has(p.round)
      || p.mode !== raw.config.mode || typeof p.boss !== 'boolean'
      || !validEnemyDifficulty({ mode: p.mode, maxTerms: 1, fixed: p.values, limits: identityDifficulty() })) return null;
    seen.add(p.round);
    rounds.push({ round: p.round, mode: p.mode, boss: p.boss, values: { ...p.values } });
  }
  return { config: { mode: raw.config.mode, maxTerms: raw.config.maxTerms,
    fixed: { ...raw.config.fixed }, limits: { ...raw.config.limits } }, rounds };
}

/** Structured public/ticker data is localized on the page, including every nested term and preset. */
export function enemyDifficultyText(plan, translate = x => x) {
  const terms = Object.entries(DIFFICULTY_TERMS).filter(([k]) => plan.values[k] > 1 && (k !== 'bossHp' || plan.boss))
    .map(([k, def]) => `${translate(def.label)} ×${plan.values[k]}`);
  const preset = difficultyPreset(plan.values);
  const mode = plan.mode === 'random' ? translate(N_('随机模式'))
    : `${translate(N_('固定模式'))} · ${preset ? translate(preset.name) : translate(N_('自定义'))}`;
  return `${translate(N_('N18对掏来'))} · ${mode} · ${terms.join(' / ') || translate(N_('本回合无额外强化'))}`;
}
