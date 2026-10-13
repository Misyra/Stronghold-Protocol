// Disposable process: checks the same plugin bytes the registry/checker use, then records real Battle snapshots/events.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginRegistry, readPluginFolder } from '../plugins/registry.js';
import { buildContentSet } from '../plugins/contentSet.js';
import { checkPluginFolder } from '../plugins/pack.js';
import { createPluginFiles, StudioError } from './files.js';
import { createAuthoring, mergeAuthorManifest } from './authoring.js';
import { manifestText } from './templates/index.js';
import { createBattleFromSpec } from '../sim/spec.js';
import { DataSource, setSimData } from '../sim/simdata.js';
import { setGameData } from '../sim/content/support/index.js';
import { installOfficialBounds } from '../../shared/plugins/officialBounds.js';
import { loadScripts } from '../../shared/plugins/scriptLoad.js';
import { chooseOperator, baselineOperator, trialScenario } from './trialScenario.js';

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const issue = p => ({ level: 'problem', code: p.code || 'PLUGIN_INVALID', text: p.message || p.zh || p.text || '', file: p.file,
  params: { ...(p.params || {}), where: p.path || p.file || '', detail: p.message || p.zh || p.text || '' } });

function recordBattle(set, scene) {
  const raw = scene.stage ? { ...set.data, stages: { ...set.data.stages, [scene.stage.id]: scene.stage } } : set.data;
  setSimData(raw); setGameData(raw); installOfficialBounds(set.bounds);
  const spec = { ...scene.spec, cs: set.cs };
  const b = createBattleFromSpec(spec, new DataSource(raw), { logger: quiet, quiet: true, recordEvents: true });
  if (scene.duel) b.autoFinish = false;
  const duelDamage = new Map();
  if (scene.duel) b.on('damaged', ({ source, target, amount }) => {
    if (source && source !== target) duelDamage.set(source.id, (duelDamage.get(source.id) || 0) + (Number(amount) || 0));
  });
  b.start();
  const field = b.fieldMeta();
  const frames = [], events = {};
  let bytes = 0;
  const capture = () => {
    const ev = b.drainEvents();
    for (const e of ev) events[e[0]] = (events[e[0]] || 0) + 1;
    const frame = { snap: b.snapshot(), ev };
    bytes += Buffer.byteLength(JSON.stringify(frame));
    if (bytes > 6 * 1024 * 1024) throw new StudioError('PLUGIN_STUDIO_TRIAL_LIMIT', 413);
    frames.push(frame);
  };
  capture();
  // [ASSUMED] Duel is a fixed-position attack exercise using forceAttack/ally targets. Enemy-only selectors stay
  // enemy-only, so it is not an official PvP mode. First knock-out ends the exercise; no redeployment.
  const pair = b.allyUnits.slice(0, 2);
  if (scene.duel) for (const u of pair) b.setAllyTarget(u);
  let winner = null;
  for (let tick = 0; tick < Math.ceil(scene.cap * 30) && !b.finished; tick++) {
    b.step();
    if (scene.duel) {
      for (const [i, u] of pair.entries()) if (u.alive && pair[1 - i]?.alive && u.canAct && u.atkCd <= 0 && !u.s.flags.disarm && !u.profile?.noAttack) {
        u.skill?.onAboutToAttack();
        b.forceAttack(u, [pair[1 - i]]);
        u.atkCd = Math.max(u.atkCd, u.s.interval);
      }
      if (pair.some(u => !u.alive)) { winner = pair[0]?.alive ? 'left' : pair[1]?.alive ? 'right' : 'draw'; b.forceEnd('forced'); }
    }
    if (tick % 3 === 2 || b.finished) capture();
  }
  if (!b.finished) b.forceEnd('forced');
  capture();
  const result = b.result();
  const units = b.units.filter(u => u.kind === 'op').map(u => ({ id: u.id, defId: u.defId, name: u.name,
    damage: scene.duel ? duelDamage.get(u.id) || 0 : u.stats.dmg, healing: u.stats.heal, taken: u.stats.taken, kills: u.stats.kills, attacks: u.stats.attacks }));
  return { cs: set.cs, spec, field, frames, result, events, units, damage: units.reduce((n, u) => n + u.damage, 0),
    outcome: scene.duel ? winner || 'draw' : result.reason === 'cleared' && result.resolved === result.killed ? 'win' : result.reason === 'timeout' ? 'timeout' : 'loss',
    stage: raw.stages[spec.stageId], errors: (b.errors || []).map(({ label, who, message }) => ({ label, who, message })) };
}

process.once('message', async ({ dirs, request, allowedScripts }) => {
  let temporary;
  try {
    const registry = createPluginRegistry(dirs, { log: quiet });
    const files = createPluginFiles(dirs.pluginsDir);
    const selected = files.root(request.id);
    const authored = createAuthoring({ files, dataDir: dirs.dataDir });
    let draft = null;
    if (request.draft) {
      const originalManifest = JSON.parse(fs.readFileSync(files.stat(request.id, 'plugin.json').abs, 'utf8'));
      if (originalManifest.class !== 'content' || !['numbers','operator','dsl','meta','mode'].includes(request.draft.template)) throw new StudioError('PLUGIN_STUDIO_REQUEST', 400);
      const made = authored.generate(request.id, request.draft, originalManifest);
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-studio-trial-'));
      const dir = path.join(temporary, request.id); fs.mkdirSync(dir);
      for (const f of files.list(request.id)) {
        if (f.link) throw new StudioError('PLUGIN_STUDIO_PATH', 403, { detail: f.rel });
        if (f.rel === 'plugin.lock.json') continue;
        const target = path.join(dir, f.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(files.stat(request.id, f.rel).abs, target);
      }
      fs.writeFileSync(path.join(dir, 'plugin.json'), manifestText(mergeAuthorManifest(originalManifest, made.manifest, request.draft.template)));
      for (const [rel, text] of Object.entries(made.files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
      draft = readPluginFolder(dir, { vanilla: registry.vanillaAssets() });
      const check = checkPluginFolder(dir, undefined, { vanilla: registry.vanillaAssets() });
      if (check.problems.length) { process.send({ ok: false, issues: check.issues }); return; }
    } else {
      // Reject links throughout the folder before invoking any checker that reads declared JSON.
      for (const f of files.list(request.id)) if (f.link) throw new StudioError('PLUGIN_STUDIO_PATH', 403, { detail: f.rel });
      const check = checkPluginFolder(selected, undefined, { vanilla: registry.vanillaAssets() });
      if (check.problems.length) { process.send({ ok: false, issues: check.issues }); return; }
    }
    const lookup = registry.plugin;
    const view = { ...registry, plugin(id) {
      let p = id === request.id && draft ? draft.plugin : lookup(id);
      if (!p) return null;
      files.root(id); // dependencies must also be regular studio folders
      for (const f of files.list(id)) if (f.link) throw new StudioError('PLUGIN_STUDIO_PATH', 403, { detail: f.rel });
      if (p.script?.lockValid && allowedScripts.some(x => x.id === id && x.hash === p.script.lockHash)) p = { ...p, status: 'loaded', disabled: null };
      return p;
    } };
    const p = view.plugin(request.id);
    if (!p || p.status !== 'loaded') {
      const problems = p?.disabled ? [issue(p.disabled)] : registry.report().skipped.find(x => x.where === `plugins/${request.id}/`)?.issues;
      process.send({ ok: false, issues: problems?.length ? problems : [issue({ code: 'PLUGIN_UNKNOWN' })] }); return;
    }
    if (p.class === 'ui') throw new StudioError('PLUGIN_STUDIO_TRIAL_SCENARIO', 400);
    const base = buildContentSet({ registry: view, ids: [] });
    const set = buildContentSet({ registry: view, ids: [{ id: request.id, settings: request.settings }] });
    if (!set.cs) { process.send({ ok: false, issues: set.problems.map(issue) }); return; }
    const newOp = Object.values(set.data.chess).find(r => !r.isGolden && !base.data.chess[r.chessId]);
    const op = request.operator ? chooseOperator(set.data, request.operator) : newOp || chooseOperator(set.data);
    const opponent = chooseOperator(set.data, request.opponent);
    const original = baselineOperator(base.data, op);
    const originalOpponent = baselineOperator(base.data, opponent);
    // Build both scenarios before installing plugin data; golden's module caches official data.
    const baseScene = await trialScenario(request, base.data, original, originalOpponent);
    const modScene = await trialScenario(request, set.data, op, opponent);
    const vanilla = recordBattle(base, baseScene);
    if (set.scripts?.length) await loadScripts(set.scripts, { hashInput: { plugins: set.index.plugins, settings: set.settings } });
    const plugin = recordBattle(set, modScene);
    process.send({ ok: true, vanilla, plugin, comparison: { damage: plugin.damage - vanilla.damage,
      duration: plugin.result.time - vanilla.result.time, baseline: original.name, operator: op.name, duel: modScene.duel } });
  } catch (e) { process.send({ ok: false, issues: [issue({ code: e.code?.startsWith('PLUGIN_') ? e.code : 'PLUGIN_STUDIO_TRIAL_FAILED', params: e.params })] }); }
  finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
});
