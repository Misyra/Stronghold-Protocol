// Composition registration preflight. Only this disposable child imports author modules.
import fs from 'node:fs';
import { loadScripts } from '../../shared/plugins/scriptLoad.js';
try {
  const {scripts, hashInput} = JSON.parse(fs.readFileSync(0,'utf8'));
  const registrations = await loadScripts(scripts,{hashInput});
  fs.writeFileSync(3,JSON.stringify({registrations}));
} catch (e) { fs.writeFileSync(3,JSON.stringify({code:e.code || 'PLUGIN_SCRIPT_CHECK',message:e.message})); process.exitCode=1; }
