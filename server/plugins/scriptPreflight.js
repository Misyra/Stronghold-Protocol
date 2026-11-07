// C1 registration preflight (DESIGN §32.10); no author imports in the lobby. The probe is an awaited child process —
// buildContentSet awaits it (server/plugins/contentSet.js) and the lobby answers the room's message once the build
// settles (server/net.js), so the event loop never stalls on a plugin script; a build that has to probe just answers
// later instead of pausing every room on the server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../shared/plugins/identity.js';
import { nodeSha256 } from './identity.js';
import { normalizeSettings } from '../../shared/plugins/patch.js';
import { browserScriptSources } from '../../shared/plugins/scriptLoad.js';
import { manifestTextWithoutNotices } from '../../shared/plugins/notices.js';
import { sandboxProcessOptions } from '../match/host/childHost.js';

// One uncached probe — the child's start (the engine, and SES for a sandboxed script) and the plugin's setup — may take
// SCRIPT_PROBE_TIMEOUT_MS before SIGKILL; results (failures too) are kept, 256 per registry, so a build pays once per
// plugin version and settings, and builds racing on one key share one child (the in-flight map below). 1 s killed
// honest sandboxed plugins under load (the child alone needed more), so the default is 5 s; SP_SCRIPT_PROBE_MS
// (500–60000) sets it for a slow or a busy server.
const probeEnv = Number.parseInt(process.env.SP_SCRIPT_PROBE_MS ?? '', 10);
export const SCRIPT_PROBE_TIMEOUT_MS = Number.isInteger(probeEnv) && probeEnv >= 500 && probeEnv <= 60000 ? probeEnv : 5000;
const PROBE_SCRIPT = fileURLToPath(new URL('./scriptProbe.js', import.meta.url));
const MAX_BUFFER = 8 * 1024 * 1024;
const caches = new WeakMap();
const failure = message => ({code:'PLUGIN_SCRIPT_CHECK',message});

/** One probe child, awaited with spawnSync's semantics kept: the JSON input on stdin, the report on fd3, SIGKILL at the
 * timeout and at the 8 MB pipe cap (reported as an error, like spawnSync's maxBuffer), and the child reaped — the close
 * event — before anything reads its output. */
function runProbe(input, execArgv, processOptions) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,[...execArgv,PROBE_SCRIPT],{
      ...processOptions,stdio:['pipe','ignore','pipe','pipe'],
    });
    let out3 = '', err2 = '', error = null, done = false, timer = null;
    const stop = (code) => {
      // spawnSync kills with the configured killSignal and names the overflow in the error it reports.
      if (!error) error = Object.assign(new Error(`spawnSync ${process.execPath} ${code}`),{code});
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    child.stdin.on('error',() => {}); // a child that dies before draining stdin: its report decides, not the write
    child.stderr.on('data',b => { if (err2.length <= MAX_BUFFER) err2 += b; if (err2.length > MAX_BUFFER) stop('ENOBUFS'); });
    child.stdio[3]?.on('data',b => { if (out3.length <= MAX_BUFFER) out3 += b; if (out3.length > MAX_BUFFER) stop('ENOBUFS'); });
    const finish = (status,signal) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ status,signal,error,out3 }); };
    timer = setTimeout(() => {
      // spawnSync's timeout: an ETIMEDOUT error beside the killSignal the close event reports.
      if (!error) error = Object.assign(new Error(`spawnSync ${process.execPath} ETIMEDOUT`),{code:'ETIMEDOUT'});
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    },SCRIPT_PROBE_TIMEOUT_MS);
    child.on('error',e => { if (!error) error = e; finish(null,null); }); // a spawn failure (EAGAIN): close may not come
    child.on('close',(status,signal) => finish(status,signal));
    child.stdin.end(input);
  });
}

/** One spawn → one report, cached (failures too): the reports entry is written before any awaiting caller reads it, and
 * the in-flight entry is dropped afterwards so a later settings change probes again. */
async function probeOnce(cache,key,script,part,settings) {
  try {
    const { execArgv = [], ...processOptions } = script.execution === 'sandbox' ? sandboxProcessOptions(128) : {};
    const probe = await runProbe(JSON.stringify({scripts:[script],hashInput:{plugins:[part],settings:{[script.id]:settings}}}),execArgv,processOptions);
    // A report written before a later hang is not success: status/error/signal must agree.
    let report;
    try { report = JSON.parse(probe.out3); } catch { report = failure('script setup failed'); }
    if (probe.error || probe.signal) report = failure(probe.error?.code === 'ETIMEDOUT'
      ? `script setup exceeded ${SCRIPT_PROBE_TIMEOUT_MS} ms; child terminated (${probe.signal}); a slow or busy server can raise SP_SCRIPT_PROBE_MS`
      : 'script setup process failed: '+(probe.error?.message || probe.signal));
    else if (probe.status !== 0 && !report?.code) report = failure('script setup failed');
    if (!report?.code && (!Array.isArray(report?.registrations) || report.registrations.some(r =>
      typeof r?.key !== 'string' || r.pluginId !== script.id))) report = failure('invalid script registration report');
    cache.reports.set(key,report);
    if (cache.reports.size > 256) cache.reports.delete(cache.reports.keys().next().value);
    return report;
  } finally { cache.inflight.delete(key); }
}

export async function preflightScripts(registry, scripts, hashInput) {
  let cache = caches.get(registry);
  if (!cache) { cache = { reports:new Map(), inflight:new Map() }; caches.set(registry,cache); }
  const owners = new Map();
  for (const script of scripts) {
    const part = hashInput.plugins.find(p => p.id === script.id);
    const settings = hashInput.settings[script.id];
    // Lock identity plus the actual descriptor protects CLI tests with an absent/stale lock too.
    // Settings can change computed registration ids, so they must never share a probe result.
    const key = canonicalJson([script.id,script.hash,part.files['@script'],nodeSha256(canonicalJson(settings))]);
    let report = cache.reports.get(key);
    if (!report) {
      // In-flight dedup: concurrent builds of one key await the same child instead of spawning their own (players
      // switching plugins twice in a row must not multiply children).
      let flight = cache.inflight.get(key);
      if (!flight) cache.inflight.set(key,flight = probeOnce(cache,key,script,part,settings));
      report = await flight;
    }
    if (report.code) return report;
    for (const {key,pluginId} of report.registrations) {
      if (owners.has(key)) return {code:'PLUGIN_SCRIPT_CONFLICT',message:`${key}: ${owners.get(key)} and ${pluginId} both register this id`};
      owners.set(key,pluginId);
    }
  }
  return null;
}

/**
 * The probe input C1 composes for one script plugin alone (contentSet.js composeContentSet, the single-plugin case,
 * default settings): the descriptor and the part with its `@script` hash. Every byte must match the builder's or a
 * warmed probe misses its cache key (harmless — only wasted), so this mirrors the builder's construction, including
 * the notice-free manifest hash and the trusted browser sources.
 * @param {{ id: string, class: string, manifest: any, content: any, script: any }} p a loaded registry plugin entry
 */
export function scriptProbeInput(p) {
  const source = manifestTextWithoutNotices(p.content?.documents?.['plugin.json']);
  const script = { id:p.id, version:p.manifest.version, class:p.class,
    execution:p.class === 'trusted' ? 'trusted' : (p.script.execution || 'trusted'),
    hash: source
      ? nodeSha256(Buffer.from(canonicalJson({ ...p.content.files, 'plugin.json': nodeSha256(Buffer.from(source)) })))
      : p.script.lockHash,
    permissions:p.manifest.permissions, authors:p.manifest.authors,
    manifestSource: source ?? p.script.manifestSource, sources:p.script.sources };
  if (script.execution === 'trusted') script.browserSources = browserScriptSources(script);
  const part = { id:p.id, version:p.manifest.version,
    files:{ ...p.content.files, ...(source ? {'plugin.json':nodeSha256(Buffer.from(source))} : {}),
      '@script':nodeSha256(Buffer.from(JSON.stringify(script))) } };
  return { script, part };
}

/**
 * Warm the probe cache in the background (a restart must not push the first plugin room's build onto the message
 * path): every loaded script plugin of room scope is probed once with the settings the builder reads when the host
 * picked none (normalizeSettings over its manifest). Fire-and-forget — never awaited by the caller, every failure
 * caught; a probe report that is already cached (or being computed) costs nothing (cache lookup, in-flight dedup).
 * @param {{ plugins?: (cls?: string) => any[] }} registry @param {{ warn?: (m: string, e?: unknown) => void }} [log]
 */
export function warmupScriptProbes(registry, log = null) {
  try {
    const list = typeof registry.plugins === 'function' ? registry.plugins() : [];
    for (const p of list) {
      if (!p || p.status !== 'loaded' || !p.script || !p.content || p.disabled) continue;
      if (!['content','script','trusted'].includes(p.class)) continue;
      if (!Array.isArray(p.manifest?.scope) || !p.manifest.scope.includes('room')) continue;
      try {
        const { script, part } = scriptProbeInput(p);
        const settings = normalizeSettings(p.manifest.settings, undefined);
        void preflightScripts(registry,[script],{plugins:[part],settings:{[p.id]:settings}}).catch(() => {});
      } catch { /* a plugin whose descriptor cannot be built: its real build reports that */ }
    }
  } catch (e) { log?.warn?.(`[plugins] script probe warmup failed: ${e?.message || e}`); }
}
