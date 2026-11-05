// Kept separate from the browser port so the same engine/packets can be verified with a Node worker.
import { InPageSimHost } from './simHost.js';

export function createSimWorker({ loadSim, prepareScripts = browserScripts } = {}) {
  const host = new InPageSimHost(loadSim ? { loadSim } : {});
  let loaded = false;
  let loadingStarted = false;
  let installScripts = null;
  // Rollback switch (simHost.js reads SP_STEP_PACKET on the page — the Worker has no process.env — and sends it
  // with the load RPC): full puts the complete meta/ops back into every packet, like before the lean packet.
  let fullPackets = false;
  // The lean packet attaches meta/ops only when the field's unit identity changed since the last one (null: the
  // next packet attaches — the start packet always does, so a page joining mid-battle gets a complete meta).
  let metaFp = null;
  const packet = (step = null) => {
    const b = host.battle;
    const pids = (host.spec.players || []).map(p => p.playerId);
    const fp = fullPackets ? null : metaFingerprint(b);
    const attach = fullPackets || metaFp === null || fp !== metaFp;
    metaFp = fp;
    return {
      snap: b.snapshot(), ev: b.drainEvents() || [], ticks: step?.ticks || 0, slices: step?.slices || [],
      state: { time: b.time, tickCount: b.tickCount, finished: b.finished, killed: b.killed, total: b.total,
        leakedCount: b.leakedCount, flags: b.flags,
        // A length marker, not enemy objects; runner's uniteLeftMark uses it.
        enemies: Array(b.enemies?.length || 0).fill(null),
        allyUnits: (b.allyUnits || []).map(u => ({ id: u.id, uid: u.uid, ownerId: u.ownerId })),
        sharedBoss: b.sharedBoss ? { cum: b.sharedBoss.cum, byPlayer: { ...b.sharedBoss.byPlayer } } : null },
      // meta/ops ride only on an identity change (see metaFingerprint); the per-step snapshot carries the rest.
      ...(attach ? { meta: b.fieldMeta(), ops: Object.fromEntries(pids.map(id => [id, host.ownerOps(id)])) } : {}),
      players: Object.fromEntries(pids.map(id => [id, { bonds: b.getPlayer(id)?.bonds }])),
      meter: { lp: host.meter.lp },
      progress: host.progress(), left: host.spec.kind === 'unite' ? host.uniteLeft() : null,
      result: b.finished ? host.compactResult({ bossLike: ['boss', 'hidden'].includes(host.spec.kind), battleId: host.spec.battleId }) : null,
    };
  };
  return async (method, args = []) => {
    if (method === 'load') {
      if (loadingStarted) throw new Error('one content set per simulation worker');
      loadingStarted = true;
      const content = args[0];
      if (!content?.data || !content.cs) throw new Error('missing content data');
      fullPackets = args[1]?.stepPacket === 'full';
      metaFp = null;
      // Lock down before importing any engine module. Data/DSL sets never load SES.
      const install = content.scripts?.length ? await prepareScripts(content) : null;
      await host.load(content.cs, { ...content, deferScripts: true });
      installScripts = install;
      loaded = !install;
      return { install: !!install };
    }
    if (method === 'install') {
      if (!installScripts || loaded) throw new Error('no pending script installation');
      await installScripts();
      installScripts = null;
      loaded = true;
      return true;
    }
    if (!loaded) throw new Error('simulation not loaded');
    switch (method) {
      case 'start': host.start(args[0]); metaFp = null; return packet();
      case 'step': {
        if (!Number.isInteger(args[0]) || args[0] < 0 || args[0] > 600) throw new Error('invalid step count');
        return packet(host.step(args[0], args[1] || {}));
      }
      // The on-demand half of the lean step packet: a complete meta/ops whenever the page asks (simHost.js
      // refreshMeta — the runner's show() fetches one behind the field it emitted from the cached meta).
      case 'meta': {
        const pids = (host.spec.players || []).map(p => p.playerId);
        return { meta: host.battle.fieldMeta(), ops: Object.fromEntries(pids.map(id => [id, host.ownerOps(id)])) };
      }
      case 'unitStats': return host.unitStats(args[0]);
      case 'ownerOps': return host.ownerOps(args[0]);
      case 'syncPool': host.syncPool(...args); return true;
      case 'forceEnd': host.forceEnd(args[0]); return packet();
      case 'stop': host.stop(); return true;
      default: throw new Error('unknown simulation command');
    }
  };
}

/**
 * Cheap change marker for the lean step packet: a digest of what a fresh `fieldMeta()` would list — the unit set
 * fieldMeta itself filters (server/sim/battle/events.js fieldMeta: deployed & visible, or a knocked-out operator
 * waiting to redeploy; keep the two filters in sync) with each unit's `form` and down flag, plus every owner-op's
 * identity (what host.ownerOps outputs, without the object copies). A change here is what makes a step packet
 * attach the full meta/ops again, so identity-level fields (model, form, down membership, loadout) never go stale
 * on the page. Deliberately left out: position, HP, facing, attack interval — the per-step snapshot tuples carry
 * those and the views re-read them every frame. Read-only over the battle, and it must not call fieldMeta() /
 * unitInfo itself: unitInfo seeds `_rateSent` (snapshot.js), and a call here would suppress the rate tuples the
 * per-tick `_emitRateChanges` owes the client.
 */
function metaFingerprint(b) {
  let fp = '';
  for (const u of b.units || []) {
    const down = !!b.isDown(u);
    if (!(u.alive && u.deployed && !u.hidden) && !down) continue;
    fp += `${u.id}|${down ? 1 : 0}|${typeof u.form === 'string' ? u.form : ''};`;
  }
  for (const u of b.allyUnits || []) {
    if (!u || u.kind !== 'op' || typeof u.defId !== 'string') continue;
    const d = u.def || {};
    fp += `#${u.ownerId}|${u.id}|${u.defId}|${Array.isArray(u.items) ? u.items.join(',') : ''}|`
      + `${typeof d.standInFor === 'string' ? d.standInFor : ''}|${d.diyFor && d.loadout?.diy ? JSON.stringify(d.loadout.diy) : ''};`;
  }
  return fp;
}

async function browserScripts(content) {
  return prepareScriptRuntime(content);
}

/** Same production adapter in both browser Workers and the Node determinism harness. */
export async function prepareScriptRuntime(content, { loadSES = () => import('/vendor/ses.umd.js'),
  loadMath = () => import('/sim/detmath.js'), loadParser = () => import('/vendor/acorn.mjs'), sdkUrl, extensionsUrl } = {}) {
  const { verifyScripts, scriptExecution, loadScripts } = await import('../../../shared/plugins/scriptLoad.js');
  verifyScripts(content.scripts, content.hashInput);
  const opts = { hashInput: content.hashInput, cs: content.cs, nativeVerified: content.nativeVerified, sdkUrl, extensionsUrl };
  if (scriptExecution(content.scripts) !== 'sandbox') return () => loadScripts(content.scripts, opts);
  const sandbox = await import('../../../shared/plugins/sandbox.js');
  await sandbox.initializeSandbox({ loadSES, loadMath });
  const { parse } = await loadParser();
  return () => sandbox.installSandboxScripts(content.scripts, { ...opts, parse });
}
