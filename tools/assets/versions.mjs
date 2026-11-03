// Presentation planning uses the union of official versions, keyed by art identity, never chess id.
// Chess/item ids are reused with different meanings between seasons (docs/DATA.md, Official versions).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS } from '../../shared/versions.js';
import { COLLAB_MANIFEST_FILE, mergeCollabManifest } from '../../shared/collabAssets.js';

export const PRESENTATION_TABLES = ['chess', 'backups', 'tokens', 'enemies', 'items', 'bands', 'bonds', 'bosses', 'stages'];

export function versionAssetData(root) {
  return VERSIONS.filter((v) => existsSync(join(root, 'data', v.dir, 'chess.json'))).map((version) => ({
    version,
    ...Object.fromEntries(PRESENTATION_TABLES.map((name) => [name,
      JSON.parse(readFileSync(join(root, 'data', version.dir, `${name}.json`), 'utf8'))])),
  }));
}

/**
 * The collab 6★ of the sets (data/backups.json `diy.excluded`, 联动干员) and the summons only they field: their art is the
 * collab pack's (data/assets-collab.json, shared/collabAssets.js), never the normal pack's.
 * @param {any[]} sets versionAssetData
 * @returns {{ operators: Set<string>, tokens: Set<string> }}
 */
export function collabIdsOf(sets) {
  const operators = new Set(), tokens = new Set(), elsewhere = new Set();
  const tokenIds = (list) => (Array.isArray(list) ? list.map((t) => (typeof t === 'string' ? t : t?.tokenId)).filter(Boolean) : []);
  for (const d of sets) for (const id of d.backups?.diy?.excluded || []) operators.add(id);
  for (const d of sets) {
    for (const [id, u] of Object.entries(d.backups?.units || {})) {
      for (const f of Object.values(u.forms || {})) for (const t of tokenIds(f.tokens)) (operators.has(id) ? tokens : elsewhere).add(t);
    }
    for (const c of Object.values(d.chess || {})) for (const t of tokenIds(c.tokens)) elsewhere.add(t);
  }
  for (const t of elsewhere) tokens.delete(t);
  return { operators, tokens };
}

/** data/assets.json of `root` with the collab pack laid over it (when data/assets-collab.json is there). */
export function manifestWithCollab(root, assets = JSON.parse(readFileSync(join(root, 'data/assets.json'), 'utf8'))) {
  const file = join(root, 'data', COLLAB_MANIFEST_FILE);
  return existsSync(file) ? mergeCollabManifest(assets, JSON.parse(readFileSync(file, 'utf8'))) : assets;
}

/**
 * Every operator, summon, enemy, band, item, bond and module type the sets present. `collab: false` leaves out the
 * collab 6★ and their own summons (collabIdsOf): what the normal pack must carry (tools/fetch-assets.mjs).
 * @param {any[]} sets @param {{ collab?: boolean }} [opts]
 */
export function presentationUnion(sets, { collab = true } = {}) {
  const operators = {}, enemies = {}, tokens = {}, bands = {}, items = {}, bonds = {};
  const modules = new Set();
  const skip = collab ? { operators: new Set(), tokens: new Set() } : collabIdsOf(sets);
  for (const d of sets) {
    for (const [id, rec] of Object.entries(d.enemies || {})) enemies[id] ??= rec;
    for (const [id, rec] of Object.entries({ ...d.backups?.tokens, ...d.tokens })) if (!skip.tokens.has(id)) tokens[id] ??= rec;
    for (const [id, rec] of Object.entries(d.bands || {})) bands[id] ??= rec;
    for (const [id, rec] of Object.entries(d.bonds || {})) bonds[id] ??= rec;
    for (const rec of Object.values(d.items || {})) if (rec.iconId) items[rec.iconId] ??= rec;
    const add = (id, rec, forms) => {
      if (!id || skip.operators.has(id)) return;
      const o = operators[id] ??= { name: rec.name, subProfessionId: rec.subProfessionId, nationId: rec.nationId, skills: [] };
      for (const form of forms) {
        for (const sk of [...(form.skills || []), ...(form.skill ? [form.skill] : [])]) {
          if (Number.isInteger(sk.index) && !o.skills.some((s) => s.skillId === sk.skillId)) {
            o.skills.push({ index: sk.index, skillId: sk.skillId, prefabId: sk.prefabId || sk.skillId, iconId: sk.iconId || sk.skillId });
          }
        }
        for (const m of form.modules || []) if (m.typeIcon) modules.add(m.typeIcon);
      }
    };
    for (const rec of Object.values(d.chess || {})) add(rec.charId, rec, [rec]);
    for (const [id, rec] of Object.entries(d.backups?.units || {})) add(id, rec, Object.values(rec.forms || {}));
  }
  for (const o of Object.values(operators)) o.skills.sort((a, b) => a.index - b.index);
  return { operators, enemies, tokens, bands, items, bonds, moduleTypes: [...modules].sort() };
}

/** Add-only preserves existing values (including arrays and null), while admitting newly planned keys. */
export function addManifestEntries(previous, next) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return previous;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return previous;
  const out = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    out[key] = Object.hasOwn(previous, key) ? addManifestEntries(previous[key], value) : value;
  }
  return out;
}

/** Exact sprite names and destinations; the local extractor never guesses or substitutes art identities. */
export function versionAssetJobs(root) {
  const all = presentationUnion(versionAssetData(root));
  // a collab operator's art is the collab pack's: on disk under its own paths (shared/collabAssets.js)
  const assets = manifestWithCollab(root);
  const missing = (url) => !url || !existsSync(join(root, 'public', url));
  const operators = Object.keys(all.operators).filter((id) => {
    const c = assets.chars[id];
    return missing(c?.avatar || `/assets/char/avatar/${id}.png`)
      || missing(c?.portrait || `/assets/char/portrait/${id}_1.png`)
      || missing(c?.spine?.front?.skel || `/assets/spine/op/${id}/front/${id}.skel`);
  });
  const enemies = Object.keys(all.enemies).filter((id) => !assets.enemies[id]?.spine && !assets.enemies[id]?.spineLocal);
  const sprites = [];
  const add = (bundles, name, path) => {
    if (!existsSync(join(root, 'public/assets', path))) sprites.push({ bundles, name, path });
  };
  for (const id of Object.keys(all.enemies)) add(['spritepack/icon_enemies_*.ab'], id, `enemy/icon/${id}.png`);
  for (const op of Object.values(all.operators)) for (const sk of op.skills) {
    add(['spritepack/skill_icons_*.ab'], `skill_icon_${sk.iconId}`, `skill/${sk.iconId.replace(/[^a-zA-Z0-9._-]/g, '_')}.png`);
  }
  for (const [id, band] of Object.entries(all.bands)) add(['ui/autochess/[uc]autochesscommon.ab'], band.iconId, `band/${id}.png`);
  for (const [id, bond] of Object.entries(all.bonds)) add(['ui/autochess/[uc]autochesscommon.ab'], bond.iconId.toLowerCase(), `bond/${id}.png`);
  for (const id of Object.keys(all.items)) add(['ui/autochess/[uc]autochesscommon.ab'], id, `item/${id}.png`);
  for (const type of all.moduleTypes) add(['arts/ui/uniequiptype/icon_hub.ab'], type.toLowerCase(), `module/${type.toLowerCase()}.png`);
  return { operators, enemies, sprites: [...new Map(sprites.map((s) => [s.path, s])).values()] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(versionAssetJobs(process.argv[2] || process.cwd())));
}
