// The newcomer docs name only paths that exist: every repository path in docs/ARCHITECTURE.md — inline code, the
// diagrams in fenced blocks — and every relative Markdown link. A path with a placeholder (`<codename>`, `{a,b}`) or a
// glob (`*`) is checked up to its last fixed directory; a path ending in `/` must be a directory. Outputs that a fresh
// checkout does not have (downloaded art, vendored libraries, the official-data cache) are exempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['docs/ARCHITECTURE.md'];
/** A repository path starts with one of these top-level directories … */
const TOP = /^(?:server|shared|public|data|tools|test|docs|types|scripts|\.github)\//;
/** … or is one of these root files (README.md is left out: a bare `README.md` often means a folder's own). */
const ROOT_FILES = new Set(['package.json', 'eslint.config.js', 'jsconfig.json', 'CHANGELOG.md', 'CONTRIBUTING.md']);
/** Git-ignored or made at install time. */
const EXEMPT = ['public/assets/', 'public/vendor/', 'data/local-assets.json'];

/** Repository paths named in a Markdown text (inline code and fenced blocks), without duplicates. */
function namedPaths(md) {
  const spans = [];
  const fenced = md.split(/^```.*$/m);
  fenced.forEach((part, i) => {
    if (i % 2 === 1) spans.push(part);                       // a fenced block: every word
    else for (const m of part.matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  });
  const out = new Set();
  for (const span of spans) {
    for (let token of span.match(/[A-Za-z0-9_.\/*<>{}@-]+/g) ?? []) {
      token = token.replace(/\.+$/, '');
      if (TOP.test(token) || ROOT_FILES.has(token)) out.add(token);
    }
  }
  return [...out];
}

/** The part of a path that must exist: up to the last directory before a placeholder or a glob. */
function fixedPart(path) {
  const parts = path.split('/');
  const i = parts.findIndex((p) => /[*<>{}]/.test(p));
  if (i < 0) return { path, dir: path.endsWith('/') };
  return { path: parts.slice(0, i).join('/') + '/', dir: true };
}

function missing(path) {
  if (EXEMPT.some((e) => path === e || path.startsWith(e) || `${path}/` === e)) return null;
  const { path: fixed, dir } = fixedPart(path);
  const abs = join(ROOT, fixed.replace(/\/$/, ''));
  if (!existsSync(abs)) return `${path}: not found`;
  if (dir && !statSync(abs).isDirectory()) return `${path}: not a directory`;
  return null;
}

for (const docPath of DOCS) {
  const md = readFileSync(join(ROOT, docPath), 'utf8');

  test(`${docPath}: every repository path it names exists`, () => {
    const paths = namedPaths(md);
    assert.ok(paths.length >= 40, `only ${paths.length} paths found — is the extraction broken?`);
    const bad = paths.map(missing).filter(Boolean);
    assert.deepEqual(bad, [], `stale paths in ${docPath}`);
  });

  test(`${docPath}: every relative link resolves`, () => {
    const bad = [];
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const file = normalize(join(ROOT, dirname(docPath), target.replace(/#.*$/, '')));
      if (!existsSync(file)) bad.push(target);
    }
    assert.deepEqual(bad, [], `broken links in ${docPath}`);
  });
}

test('the path extraction: placeholders, globs, directories and the exemptions', () => {
  const md = 'a `server/sim/content/kits/ops/op-<codename>.js` b `data/*.json` c `node tools/golden.mjs --update`\n'
    + '```\nnpm test → test/golden.test.js; public/assets/ README.md\n```\n';
  assert.deepEqual(namedPaths(md).sort(), ['data/*.json', 'public/assets/', 'server/sim/content/kits/ops/op-<codename>.js', 'test/golden.test.js', 'tools/golden.mjs'].sort());
  assert.deepEqual(fixedPart('server/sim/content/kits/ops/op-<codename>.js'), { path: 'server/sim/content/kits/ops/', dir: true });
  assert.equal(missing('public/assets/'), null);
  assert.equal(missing('server/no-such-file.js'), 'server/no-such-file.js: not found');
  assert.equal(missing('server/index.js/'), 'server/index.js/: not a directory');
});
