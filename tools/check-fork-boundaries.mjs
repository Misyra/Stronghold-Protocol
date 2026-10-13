// Enforce fork additions without changing upstream's advisory scanner or its Node-only loader.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, formatReport } from './check-imports.mjs';

const UPSTREAM_NODE_LOADER = new Set(['node:fs', 'node:path', 'node:url']);
export function checkForkBoundaries(root) {
  const report = scan(root);
  const violations = [], notes = [...report.notes];
  for (const hit of report.violations) {
    if (hit.file === 'server/sim/nodeData.js' && hit.code === 'sim-node' && UPSTREAM_NODE_LOADER.has(hit.spec)) notes.push(hit);
    else violations.push(hit);
  }
  return { violations, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkForkBoundaries(path.resolve(fileURLToPath(new URL('../', import.meta.url))));
  process.stdout.write(formatReport(report));
  process.exitCode = report.violations.length ? 1 : 0;
}
