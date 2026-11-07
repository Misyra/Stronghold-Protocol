// test/versions-prewarm.test.js — the boot-time prewarm of the official versions (DESIGN §37.133;
// server/versions.js prewarm(), server/http/config.js versionPrewarmFrom, server/index.js 预热接线): the walk loads
// every enabled non-default version's data + bounds + manifest before the listener opens, so a first room / manifest
// / host of a version finds everything memoized instead of paying the synchronous load on the message path. One
// version's failure is the remembered permanent failure load() already keeps — the walk goes on, the boot continues;
// the default version's data is never touched. Off for programmatic boots (tests, tools), on at the process entry
// and via SP_VERSIONS_PREWARM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { createVersionSets } from '../server/versions.js';
import { versionPrewarmFrom } from '../server/http/config.js';
import { computeVanillaContent } from '../server/plugins/identity.js';
import { DATA_DIR, ROOT, getData, versionDataDir } from '../server/data.js';
import { DATA_SHIM_JS } from '../server/http/static.js';
import { csUrlPart } from '../shared/plugins/identity.js';
import { DEFAULT_VERSION } from '../shared/versions.js';

const vanilla = computeVanillaContent({ simDir: path.join(ROOT, 'server', 'sim'), sharedDir: path.join(ROOT, 'shared'), dataDir: DATA_DIR, shim: DATA_SHIM_JS });
const OTHERS = ['act2autochess@V2_1', 'act1autochess', 'act1autochess@V1_1'];
const ALL = [DEFAULT_VERSION, ...OTHERS];
const quiet = { info() {}, warn() {}, error() {} };

test('versionPrewarmFrom: the option wins over an on env, SP_VERSIONS_PREWARM=0 beats everything, nothing set is off', () => {
  const saved = process.env.SP_VERSIONS_PREWARM;
  try {
    delete process.env.SP_VERSIONS_PREWARM;
    assert.equal(versionPrewarmFrom({}), false, 'programmatic default: off');
    assert.equal(versionPrewarmFrom({ versions: {} }), false);
    assert.equal(versionPrewarmFrom({ versions: { prewarm: true } }), true, 'the process entry opts in');
    assert.equal(versionPrewarmFrom({ versions: { prewarm: false } }), false);
    for (const on of ['1', 'true', 'yes', 'on']) {
      process.env.SP_VERSIONS_PREWARM = on;
      assert.equal(versionPrewarmFrom({}), true, `SP_VERSIONS_PREWARM=${on} turns a programmatic boot on`);
    }
    process.env.SP_VERSIONS_PREWARM = '1';
    assert.equal(versionPrewarmFrom({ versions: { prewarm: false } }), false, 'an explicit option beats an on env');
    assert.equal(versionPrewarmFrom({ versions: { prewarm: true } }), true);
    for (const off of ['0', 'off', 'false', 'no', ' OFF ']) {
      process.env.SP_VERSIONS_PREWARM = off;
      assert.equal(versionPrewarmFrom({}), false, `SP_VERSIONS_PREWARM=${off} turns it off`);
      assert.equal(versionPrewarmFrom({ versions: { prewarm: true } }), false, 'the operator switch beats the option');
    }
  } finally {
    if (saved === undefined) delete process.env.SP_VERSIONS_PREWARM;
    else process.env.SP_VERSIONS_PREWARM = saved;
  }
});

test('prewarm walks every enabled non-default version in registry order and memoizes data, bounds and manifest', async () => {
  const infos = [];
  const v = createVersionSets({ enabled: ALL, vanilla, defaultData: getData(), log: { ...quiet, info: (m) => infos.push(m) } });
  assert.equal(v.stats().loaded, 0, 'nothing loaded before the walk');
  const rows = await v.prewarm();
  assert.deepEqual(rows.map((r) => r.id), OTHERS, 'registry order, the default never walked');
  for (const r of rows) {
    assert.equal(r.ok, true, r.id);
    assert.ok(r.ms >= 0, `${r.id}: a measurement (${r.ms})`);
  }
  assert.equal(v.stats().loaded, OTHERS.length, 'every non-default version loaded');
  for (const id of OTHERS) {
    const d = v.data(id);
    assert.ok(d && Object.isFrozen(d.chess), `${id}: the deep-frozen data is in place`);
    assert.equal(v.data(id), d, `${id}: memoized — a second call returns the same object`);
    const body = v.file(csUrlPart(v.csOf(id)), 'bounds/official.json');
    assert.ok(body && body.body.length > 0, `${id}: the bounds snapshot is in place`);
    const index = v.file(csUrlPart(v.csOf(id)), 'index.json');
    assert.ok(index && JSON.parse(index.body.toString('utf8')).version === id, `${id}: the manifest is in place`);
  }
  assert.ok(infos.some((m) => /\[versions\] act2autochess@V2_1 data loaded/.test(m)), infos.join('\n'));
  assert.equal(v.data(DEFAULT_VERSION), getData(), 'the default version stays the server\'s own data');
});

test('prewarm is idempotent: a second walk is a no-op over the memoized versions', async () => {
  const v = createVersionSets({ enabled: ALL, vanilla, defaultData: getData(), log: quiet });
  const first = await v.prewarm();
  const d = v.data('act1autochess');
  const second = await v.prewarm();
  assert.deepEqual(second.map((r) => [r.id, r.ok]), first.map((r) => [r.id, r.ok]));
  assert.equal(v.data('act1autochess'), d, 'the same object — nothing re-read');
  assert.equal(v.stats().loaded, OTHERS.length);
});

test('a version that fails to load is skipped by the walk: its failure is remembered, the others load, nothing throws', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-prewarm-'));
  try {
    for (const id of OTHERS.slice(0, 2)) fs.cpSync(versionDataDir(id), versionDataDir(id, tmp), { recursive: true });
    fs.writeFileSync(path.join(versionDataDir('act1autochess', tmp), 'chess.json'), '{ not json');
    const errors = [];
    const v = createVersionSets({ enabled: ALL, dataDir: tmp, vanilla, defaultData: getData(), log: { ...quiet, error: (m) => errors.push(m) } });
    const rows = await v.prewarm(); // must not throw
    assert.deepEqual(rows.map((r) => [r.id, r.ok]), [['act2autochess@V2_1', true], ['act1autochess', false]]);
    assert.ok(rows[1].ms >= 0);
    assert.equal(errors.filter((m) => /act1autochess data failed to load/.test(m)).length, 1, errors.join('\n'));
    assert.equal(v.data('act1autochess'), null);
    assert.equal(v.available('act1autochess'), false, 'the lobby gate refuses it, exactly as without the prewarm');
    assert.equal(v.data('act2autochess@V2_1') && Object.isFrozen(v.data('act2autochess@V2_1').chess), true);
    assert.equal(v.welcome().find((e) => e.id === 'act2autochess@V2_1') != null, true);
    assert.equal(v.welcome().some((e) => e.id === 'act1autochess'), false, 'the failed version is not offered');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('prewarm on a server with only the default version enabled: an empty walk, the boot proceeds', async () => {
  const v = createVersionSets({ enabled: ['act2autochess'], vanilla, defaultData: getData(), log: quiet });
  assert.deepEqual(await v.prewarm(), []);
  assert.equal(v.stats().loaded, 0);
});

/** A server boot against a private copy of the data tree (the destructive assertions delete a version directory). */
async function startDataCopyServer({ mutate, ...extra } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-prewarm-boot-'));
  const dataDir = path.join(tmp, 'data');
  fs.cpSync(DATA_DIR, dataDir, { recursive: true, filter: (p) => !p.endsWith(`${path.sep}i18n`) });
  if (mutate) mutate(dataDir);
  try {
    return { tmp, srv: await startServer({ port: 0, host: '127.0.0.1', quiet: true, dataDir, ...extra }) };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

test('boot with prewarm: every enabled non-default version is loaded before listen; a later first use reads no disk', async () => {
  const { tmp, srv } = await startDataCopyServer({ versions: { enabled: ['act2autochess', 'act1autochess'], prewarm: true } });
  try {
    assert.deepEqual([...srv.versions.nonDefault], ['act1autochess']);
    assert.equal(srv.versions.stats().loaded, 1, 'the data was in place when the boot returned');
    const d = srv.versions.data('act1autochess');
    assert.ok(d && Object.isFrozen(d.chess));
    // the memo proof: with the directory gone from disk, the first-use paths still answer — nothing is re-read
    fs.rmSync(versionDataDir('act1autochess', tmp), { recursive: true, force: true });
    assert.equal(srv.versions.data('act1autochess'), d);
    assert.equal(srv.versions.available('act1autochess'), true);
    const body = srv.versions.file(csUrlPart(srv.versions.csOf('act1autochess')), 'bounds/official.json');
    assert.ok(body && body.body.length > 0);
    const index = srv.versions.file(csUrlPart(srv.versions.csOf('act1autochess')), 'index.json');
    assert.equal(JSON.parse(index.body.toString('utf8')).version, 'act1autochess');
    assert.equal(srv.versions.data(DEFAULT_VERSION) && Object.isFrozen(srv.versions.data(DEFAULT_VERSION).config), true, 'the default version is unaffected');
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a boot without the option (and without SP_VERSIONS_PREWARM) parses nothing: the lazy load stays the first use', async () => {
  const saved = process.env.SP_VERSIONS_PREWARM;
  delete process.env.SP_VERSIONS_PREWARM;
  try {
    const { tmp, srv } = await startDataCopyServer({ versions: { enabled: ['act2autochess', 'act1autochess'] } });
    try {
      assert.equal(srv.versions.stats().loaded, 0, 'nothing preloaded — the old behavior');
      const d = srv.versions.data('act1autochess');
      assert.ok(d && Object.isFrozen(d.chess), 'the lazy load still works');
      assert.equal(srv.versions.stats().loaded, 1);
    } finally {
      await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    if (saved !== undefined) process.env.SP_VERSIONS_PREWARM = saved;
  }
});

test('boot with prewarm: one broken version does not block the boot; the others are prewarmed and the server serves', async () => {
  const { tmp, srv } = await startDataCopyServer({
    mutate: (dataDir) => fs.writeFileSync(path.join(dataDir, 'versions', 'act1autochess', 'chess.json'), '{ not json'),
    versions: { enabled: ['act2autochess', 'act1autochess', 'act2autochess@V2_1'], prewarm: true },
  });
  try {
    // the boot itself completed with the corrupted version enabled: the walk skipped it, the other non-default one is in place
    assert.deepEqual(srv.versions.stats().loaded, 1, 'loaded counts the non-default versions only');
    assert.equal(srv.versions.data('act1autochess'), null, 'the failure is remembered');
    assert.equal(srv.versions.available('act1autochess'), false);
    assert.equal(srv.versions.data('act2autochess@V2_1') && Object.isFrozen(srv.versions.data('act2autochess@V2_1').chess), true);
    const health = await (await fetch(`${srv.url}/healthz`)).json();
    assert.deepEqual(health.versions.enabled, ['act2autochess', 'act2autochess@V2_1', 'act1autochess'], 'registry order');
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
