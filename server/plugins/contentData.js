// Read declared P1b JSON once at scan time. A set never rereads changed plugin files under an old hash.
import fs from 'node:fs';
import path from 'node:path';
import { nodeSha256 } from './identity.js';
import { jsonProblems, object, problem } from '../../shared/plugins/dataUtils.js';
import { isPackPath, PLUGIN_LIMITS } from '../../shared/plugins/manifest.js';
import { deepFreeze } from '../data.js';

export function readContentData(dir, manifest) {
  const documents = {}, files = {}, problems = [];
  const read = rel => {
    if (Object.hasOwn(documents, rel)) return documents[rel];
    if (!isPackPath(rel) || path.extname(rel).toLowerCase() !== '.json') throw problem('PLUGIN_CONTENT_FILE', rel, 'declared JSON path required');
    const abs = path.join(dir, ...rel.split('/'));
    const root = fs.realpathSync.native(dir), real = fs.realpathSync.native(abs);
    if (!real.startsWith(root + path.sep) || fs.lstatSync(abs).isSymbolicLink()) throw problem('PLUGIN_CONTENT_FILE', rel, 'file escapes plugin directory');
    const bytes = fs.readFileSync(abs);
    if (bytes.length > PLUGIN_LIMITS.jsonBytes) throw problem('PLUGIN_DATA_LIMIT', rel, 'JSON exceeds 8 MB');
    const doc = JSON.parse(bytes.toString('utf8'));
    const errors = jsonProblems(doc, rel);
    if (errors.length) throw errors[0];
    files[rel] = nodeSha256(bytes);
    documents[rel] = doc;
    return doc;
  };
  try {
    // [ASSUMED] Pin manifest text and translation bytes too: one cs serves one immutable snapshot (DESIGN §32.5).
    read('plugin.json');
    for (const part of ['data', 'operators', 'enemies', 'modes', 'stages', 'dsl']) for (const rel of manifest.parts[part]?.files ?? []) {
      const doc = read(rel);
      if (part === 'dsl') throw problem('PLUGIN_DSL_UNAVAILABLE', rel, 'DSL is supplied by P2');
      if (part === 'data' && !(object(doc) && (doc.patch === 1 && Array.isArray(doc.ops) || doc.records === 1 && Array.isArray(doc.entries)))) throw problem('PLUGIN_CONTENT_FORMAT', rel, 'expected patch:1/ops or records:1/entries');
    }
    for (const rel of Object.values(manifest.parts.i18n?.langs ?? {})) read(rel);
    // kit.spec may point at a JSON file; it is declared transitively by its compact operator record.
    const resolveSpec = r => {
      if (typeof r?.kit?.spec === 'string') r.kit.spec = read(r.kit.spec);
    };
    for (const rel of manifest.parts.operators?.files ?? []) for (const r of Array.isArray(documents[rel]) ? documents[rel] : [documents[rel]]) resolveSpec(r);
    for (const rel of manifest.parts.data?.files ?? []) for (const r of documents[rel].entries ?? []) resolveSpec(r);
  } catch (e) { problems.push(e?.code?.startsWith('PLUGIN_') ? e : problem('PLUGIN_CONTENT_FILE', dir, e.message)); }
  return { content: problems.length ? null : deepFreeze({ documents, files, hash: nodeSha256(Buffer.from(JSON.stringify(files))) }), problems };
}
