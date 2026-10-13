// test/plugins/surface.test.js — the frozen plugin API v1 (DESIGN §32.13, docs/PLUGIN-API.md).
// Three things must agree: the markdown table, buildSurface(), and the closed sets themselves (enumerated in this
// file, not by calling buildSurface's helpers). A new export means a new member of one of those sets — a manifest
// field, permission, class, patch op, compact-record field, overlay leaf, DSL word, postMessage name, slot, studio
// route, error code, catalogue field or SDK member — not every new function. surface.stable.json records { name,
// anchor } for stability === 'stable'. Removing, renaming or adding a stable row fails until that file is updated
// on purpose, even when the document and buildSurface are changed together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_API } from '../../shared/constants.js';
import { MANIFEST_FIELDS, PERMISSIONS, PLUGIN_CLASSES, UI_SLOT_IDS } from '../../shared/plugins/manifest.js';
import { PATCH_OPS } from '../../shared/plugins/patch.js';
import { RECORD_SCHEMA } from '../../shared/plugins/recordsSchema.js';
import { ASSET_CONTAINERS } from '../../shared/plugins/visual.js';
import { UI_HOST_MESSAGES, UI_PLUGIN_MESSAGES } from '../../shared/plugins/ui.js';
import { PLUGIN_ERRORS } from '../../shared/plugins/errors.js';
import { CATALOG_ENTRY_FIELDS, CATALOG_FIELDS } from '../../shared/plugins/catalog.js';
import { SDK_ID, SDK_MEMBERS } from '../../shared/plugins/sdk.js';
import { SURFACE_MARKERS, SURFACE_SINCE, buildSurface } from '../../shared/plugins/surface.js';
import { STUDIO_ROUTES } from '../../server/studio/index.js';
import * as vocab from '../../server/sim/content/dsl/vocab.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Overlay leaves, copied so a drift in surface.js is visible. A string kind is one leaf. */
function overlayLeaves(containers) {
  const out = [];
  const walk = (kind, prefix) => {
    if (typeof kind === 'string') { out.push(prefix); return; }
    if (kind && kind.fields) {
      for (const [k, v] of Object.entries(kind.fields)) walk(v, `${prefix}.${k}`);
      return;
    }
    if (kind && kind.each) { out.push(`${prefix}.*`); return; }
    throw new Error(`unknown asset kind at ${prefix}`);
  };
  for (const c of containers) {
    const base = `overlay.${c.path.join('.')}`;
    if (Array.isArray(c.keys)) for (const k of c.keys) walk(c.record, `${base}.${k}`);
    else if (typeof c.record === 'string' || (c.record && c.record.each)) out.push(`${base}.*`);
    else walk(c.record, base);
  }
  return out;
}

const DSL_GROUPS = [
  ['trigger', 'TRIGGERS'],
  ['condition', 'CONDITIONS'],
  ['action', 'ACTIONS'],
  ['target', 'TARGETS'],
  ['metaTrigger', 'META_TRIGGERS'],
  ['metaAction', 'META_ACTIONS'],
  ['value', 'VALUE_OPS'],
  ['skillKind', 'SKILL_KINDS'],
  ['stat', 'STAT_NAMES'],
];

function expectedNames() {
  const names = [];
  for (const field of MANIFEST_FIELDS) names.push(`manifest.field.${field}`);
  for (const name of Object.keys(PERMISSIONS)) names.push(`permission.${name}`);
  for (const name of Object.keys(PLUGIN_CLASSES)) names.push(`class.${name}`);
  for (const op of PATCH_OPS) names.push(`patch.op.${op}`);
  const [operator, generic] = RECORD_SCHEMA.anyOf;
  for (const name of Object.keys(operator.properties)) names.push(`record.operator.${name}`);
  for (const name of Object.keys(generic.properties)) names.push(`record.generic.${name}`);
  for (const name of overlayLeaves(ASSET_CONTAINERS)) names.push(name);
  for (const [group, key] of DSL_GROUPS) for (const name of vocab[key]) names.push(`dsl.${group}.${name}`);
  for (const name of UI_PLUGIN_MESSAGES) names.push(`ui.message.plugin.${name}`);
  for (const name of UI_HOST_MESSAGES) names.push(`ui.message.host.${name}`);
  for (const name of UI_SLOT_IDS) names.push(`ui.slot.${name}`);
  for (const route of STUDIO_ROUTES) names.push(`studio.route.${route}`);
  for (const code of Object.keys(PLUGIN_ERRORS)) names.push(`error.${code}`);
  for (const name of CATALOG_FIELDS) names.push(`catalog.field.${name}`);
  for (const name of CATALOG_ENTRY_FIELDS) names.push(`catalog.entry.${name}`);
  names.push(`sdk.${SDK_ID}`);
  for (const name of SDK_MEMBERS) names.push(`sdk.${SDK_ID}.${name}`);
  names.push('api.PLUGIN_API.min', 'api.PLUGIN_API.current');
  return names;
}

function parseTable(md) {
  const a = md.indexOf(SURFACE_MARKERS.start);
  const b = md.indexOf(SURFACE_MARKERS.end);
  assert.ok(a >= 0 && b > a, 'docs/PLUGIN-API.md has the surface markers');
  const rows = [];
  for (const line of md.slice(a, b).split('\n')) {
    const m = /^\| `([^`]+)` \| (stable|experimental|internal) \| ([^|]+) \| `([^`]+)` \|$/.exec(line);
    if (m) rows.push({ name: m[1], stability: m[2], since: m[3].trim(), anchor: m[4] });
  }
  return rows;
}

const rows = buildSurface({ dsl: vocab, studioRoutes: STUDIO_ROUTES });
const doc = parseTable(fs.readFileSync(path.join(ROOT, 'docs/PLUGIN-API.md'), 'utf8'));

test('the document table and buildSurface are the same rows', () => {
  assert.ok(rows.length > 50, `${rows.length} rows`);
  assert.deepEqual(doc, rows.map(({ name, stability, since, anchor }) => ({ name, stability, since, anchor })));
  assert.ok(rows.every((r) => r.since === SURFACE_SINCE && r.since === '0.3.0'));
});

test('every closed-set member is a row, and the table has no extra name', () => {
  assert.deepEqual(rows.map((r) => r.name), expectedNames());
});

test('stable names match the baseline, including ones added or removed on purpose', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/plugins/surface.stable.json'), 'utf8'));
  const stable = rows.filter((r) => r.stability === 'stable').map(({ name, anchor }) => ({ name, anchor }));
  assert.deepEqual(stable, baseline);
});

test('surface.js does not import Node builtins or server modules', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/plugins/surface.js'), 'utf8');
  // Anchors name server files in strings. Only an import or require of one is a violation.
  assert.doesNotMatch(src, /from ['"]node:/);
  assert.doesNotMatch(src, /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"][^'"]*server\//);
});

test('STUDIO_ROUTES names every route literal the studio dispatches', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/studio/index.js'), 'utf8');
  const literals = [...src.matchAll(/route === '([^']+)'/g)].map((m) => m[1]);
  assert.ok(literals.includes('catalog') && literals.includes('catalog/install'));
  for (const route of literals) {
    assert.ok(STUDIO_ROUTES.some((row) => row.endsWith(`/${route}`) || row.includes(`/${route}/`) || row.endsWith(`/${route}/*`)), route);
  }
  for (const sub of [...src.matchAll(/sub === '([^']*)'/g)].map((m) => m[1]).filter(Boolean)) {
    assert.ok(STUDIO_ROUTES.some((row) => row.includes(`/${sub}`)), sub);
  }
  assert.ok(STUDIO_ROUTES.includes('POST /studio/api/catalog'));
  assert.ok(STUDIO_ROUTES.includes('POST /studio/api/catalog/install'));
  assert.equal(PLUGIN_API.current, 1);
});
