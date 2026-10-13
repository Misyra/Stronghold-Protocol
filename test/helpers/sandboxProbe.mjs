// Test-only child entry. Never served. Parent terminates non-returning source and caps this process's heap.
import { initializeSandbox, createPluginCompartment, loadSandboxPlugin } from '../../shared/plugins/sandbox.js';
import { parse } from 'acorn';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

await initializeSandbox({ loadSES: () => import('ses') });
process.send({ ready: true, permission: !!process.permission });
process.on('message', async ({ source, plugin, probePermissions }) => {
  try {
    let value;
    if (probePermissions) {
      const denied = fn => { try { fn(); return false; } catch (e) { return e.code === 'ERR_ACCESS_DENIED'; } };
      value = { write: denied(() => writeFileSync('/tmp/sp-sandbox-must-not-exist', 'bad')),
        read: denied(() => readFileSync('/etc/hosts')), spawn: denied(() => spawnSync(process.execPath, ['-v'])), ipc: true };
    } else if (plugin) {
      const sp = { capture: v => { value = v; } };
      loadSandboxPlugin({ plugin, sp, parse });
    } else value = createPluginCompartment({}).evaluate(source);
    process.send({ ok: true, value });
  } catch (e) { process.send({ ok: false, error: { name: e.name, code: e.code, message: String(e.message) } }); }
});
