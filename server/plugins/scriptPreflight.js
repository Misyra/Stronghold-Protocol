// Synchronous C1 registration preflight (DESIGN §32.10); no author imports in the lobby.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../shared/plugins/identity.js';
import { nodeSha256 } from './identity.js';

// [ASSUMED] C1 stays synchronous: at most 1 s per uncached plugin; retain 256 results per registry.
export const SCRIPT_PROBE_TIMEOUT_MS = 1000;
const caches = new WeakMap();
const failure = message => ({code:'PLUGIN_SCRIPT_CHECK',message});

export function preflightScripts(registry, scripts, hashInput) {
  const cache = caches.get(registry) ?? new Map();
  caches.set(registry,cache);
  const owners = new Map();
  for (const script of scripts) {
    const part = hashInput.plugins.find(p => p.id === script.id);
    const settings = hashInput.settings[script.id];
    // Lock identity plus the actual descriptor protects CLI tests with an absent/stale lock too.
    // Settings can change computed registration ids, so they must never share a probe result.
    const key = canonicalJson([script.id,script.hash,part.files['@script'],nodeSha256(canonicalJson(settings))]);
    let report = cache.get(key);
    if (!report) {
      const probe = spawnSync(process.execPath,[fileURLToPath(new URL('./scriptProbe.js',import.meta.url))],{
        input:JSON.stringify({scripts:[script],hashInput:{plugins:[part],settings:{[script.id]:settings}}}),
        encoding:'utf8',timeout:SCRIPT_PROBE_TIMEOUT_MS,killSignal:'SIGKILL',
        maxBuffer:8*1024*1024,stdio:['pipe','ignore','pipe','pipe'],
      });
      // spawnSync waits/reaps the child before returning, including after timeout's SIGKILL.
      // A report written before a later hang is not success: status/error/signal must agree.
      try { report = JSON.parse(probe.output?.[3]); } catch { report = failure('script setup failed'); }
      if (probe.error || probe.signal) report = failure(probe.error?.code === 'ETIMEDOUT'
        ? `script setup exceeded ${SCRIPT_PROBE_TIMEOUT_MS} ms; child terminated (${probe.signal})`
        : 'script setup process failed: '+(probe.error?.message || probe.signal));
      else if (probe.status !== 0 && !report?.code) report = failure('script setup failed');
      if (!report?.code && (!Array.isArray(report?.registrations) || report.registrations.some(r =>
        typeof r?.key !== 'string' || r.pluginId !== script.id))) report = failure('invalid script registration report');
      cache.set(key,report);
      if (cache.size > 256) cache.delete(cache.keys().next().value);
    }
    if (report.code) return report;
    for (const {key,pluginId} of report.registrations) {
      if (owners.has(key)) return {code:'PLUGIN_SCRIPT_CONFLICT',message:`${key}: ${owners.get(key)} and ${pluginId} both register this id`};
      owners.set(key,pluginId);
    }
  }
  return null;
}
