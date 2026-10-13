// sp:sdk@1 facade. Imported only by a script content realm (never on the vanilla loading path).
// URL/import.meta are supplied by both ESM hosts; the shared checkJs slice intentionally has no DOM/Node lib.
const URL = /** @type {any} */ (globalThis).URL;
const moduleUrl = /** @type {any} */ (import.meta).url;
const root = new URL('../../', moduleUrl);
const sim = new URL(root.protocol === 'file:' ? 'server/sim/' : 'sim/', root);
const [helpers, deterministic, values, extensions] = await Promise.all([
  import(new URL('content/kits/shared/tier1.js', sim).href), import(new URL('detmath.js',sim).href),
  import(new URL('constants.js',sim).href), import(new URL('content/extensions.js',sim).href),
]);
const freeze = v => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
};
/** Stable tier1 subset: num, talentBb, talentGrid, moduleBb, traitBb, moduleOn, up, cheb,
 * isMainHit, byEnemyAttack, skillBusy, giveSp, onHitBy, onHitOn, onDamagedOn, enemiesInGrid,
 * alliesInGridOf, enemyInRange, statBuff, toggleBuff, instantKind, skillRec, skillBbOf, batMod.
 * Hooks and engine helpers follow SIM §5–7. No ambient IO, storage, clocks or randomness is supplied.
 */
export const kit = Object.freeze(Object.fromEntries(('num talentBb talentGrid moduleBb traitBb moduleOn up cheb '+
  'isMainHit byEnemyAttack skillBusy giveSp onHitBy onHitOn onDamagedOn enemiesInGrid alliesInGridOf enemyInRange '+
  'statBuff toggleBuff instantKind skillRec skillBbOf batMod').split(' ').map(k => [k,helpers[k]])));
export const math = Object.freeze({...deterministic});
export const constants = freeze({...values});
/** A setup-scoped SDK; settings copied/frozen; logging capped at 20 lines per setup [ASSUMED]. */
export function createSDK(plugin, { settings = {}, log = (..._args) => {} } = {}) {
  let lines = 0;
  const need = permission => {
    if (plugin.permissions && !plugin.permissions.includes(permission)) throw Object.assign(new Error(`${plugin.id}: ${permission} required`),{code:'PLUGIN_PERMISSION_MISSING'});
  };
  return Object.freeze({ kit, math, constants, settings: freeze(JSON.parse(JSON.stringify(settings))),
    kits: Object.freeze({ register: (id,fn) => {need('sim.code');return extensions.registerKit(plugin,id,fn);} }),
    enemies: Object.freeze({ register: (id,fn) => {need('sim.code');return extensions.registerEnemy(plugin,id,fn);} }),
    content: Object.freeze({ register: mod => {if(mod.install)need('sim.code');if(mod.registerMeta)need('meta.code');return extensions.registerContent(plugin,mod);} }),
    meta: Object.freeze({ register: (id,h) => {need('meta.code');return extensions.registerMeta(plugin,id,h);} }),
    log: (...args) => { if (lines++ < 20) log(`[plugin:${plugin.id}]`, ...args.map(x => String(x).slice(0,500))); },
  });
}
