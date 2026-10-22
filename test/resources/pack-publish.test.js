import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareResourcePackUpload } from '../../tools/resource-pack-publish.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
let python;
for (const bin of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
  try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); python = bin; break; } catch {}
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-pack-publish-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'data'));
  await fs.mkdir(path.join(dir, 'public/resource-packs'), { recursive: true });
  const bytes = Buffer.from('current zip fixture');
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  const name = `fx-01-${sha1.slice(0, 12)}.zip`;
  await fs.writeFile(path.join(dir, 'public/resource-packs', name), bytes);
  await fs.writeFile(path.join(dir, 'public/resource-packs/old-full-package.zip'), 'retain legacy archive');
  const index = { format: 'stronghold-resource-pack-index', version: 1, maxBytes: 16_000_000,
    packs: [{ id: 'fx-01', url: `/resource-packs/${name}`, size: bytes.length, sha1, files: [] }] };
  await fs.writeFile(path.join(dir, 'data/resource-packs.json'), JSON.stringify(index));
  return { dir, index, name };
}

test('R2 publication includes current indexed ZIPs only and commits resume state after success', async (t) => {
  const { dir, name } = await fixture(t);
  const pending = await prepareResourcePackUpload(dir);
  assert.deepEqual(pending.jobs.map((job) => job.key), [`resource-packs/${name}`]);
  assert.match(pending.jobs[0].cc, /immutable/);
  assert.equal((await prepareResourcePackUpload(dir)).jobs.length, 1, 'planning does not mark ZIPs published');
  await pending.commit();
  assert.equal((await prepareResourcePackUpload(dir)).jobs.length, 0);
  assert.equal(await fs.readFile(path.join(dir, 'public/resource-packs/old-full-package.zip'), 'utf8'), 'retain legacy archive');
});

test('a corrupted local pack cannot be advertised as published', async (t) => {
  const { dir, name } = await fixture(t);
  await fs.writeFile(path.join(dir, 'public/resource-packs', name), 'tampered');
  await assert.rejects(prepareResourcePackUpload(dir), /size\/digest mismatch/);
  await assert.rejects(fs.stat(path.join(dir, '.resource-packs-published.json')), { code: 'ENOENT' });
});

test('ModelScope dry run needs no SDK or network and never emits credentials', { skip: !python }, async (t) => {
  const { dir } = await fixture(t);
  const output = execFileSync(python, [path.join(root, 'tools/modelscope-packs.py'), '--root', dir], {
    encoding: 'utf8', env: { ...process.env, MODELSCOPE_API_KEY: 'sentinel-private-credential' },
  });
  assert.match(output, /DRY RUN: 1 ZIPs -> Misyra\/Arknight_Assets/);
  assert.match(output, /resolve\/master\/\{file\}/);
  assert.ok(!output.includes('sentinel-private-credential'));
  assert.equal((await fs.readdir(path.join(dir, 'public/resource-packs'))).length, 2);
});

test('ModelScope upload orders payload before index and a payload failure never publishes the index', { skip: !python }, async (t) => {
  const { dir, name } = await fixture(t);
  const script = `
import importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location('publish', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify_token = lambda token: None
calls = []
class FakeApi:
    def __init__(self, **kwargs):
        assert kwargs['token'] == 'test-secret'
    def upload_folder(self, **kwargs):
        assert kwargs['repo_id'] == 'Misyra/Arknight_Assets'
        assert kwargs['repo_type'] == 'dataset'
        assert kwargs['sync_remote_repo'] is False
        assert kwargs['use_cache'] is True
        assert kwargs['max_workers'] == 4
        assert kwargs['allow_patterns'] == [os.environ['EXPECTED_PACK']]
        for name in kwargs['allow_patterns']:
            calls.append(name)
            if os.environ.get('FAIL_PAYLOAD'):
                raise OSError('simulated upload failure')
    def upload_file(self, **kwargs):
        assert kwargs['repo_id'] == 'Misyra/Arknight_Assets'
        assert kwargs['repo_type'] == 'dataset'
        calls.append(kwargs['path_in_repo'])
        if os.environ.get('FAIL_PAYLOAD'):
            raise OSError('simulated upload failure')
sys.modules['modelscope_hub'] = types.SimpleNamespace(HubApi=FakeApi)
sys.argv = ['publish', '--root', sys.argv[2], '--apply']
try:
    module.main()
except OSError:
    pass
print('CALLS=' + json.dumps(calls))
`;
  const run = (fail) => execFileSync(python, ['-c', script, path.join(root, 'tools/modelscope-packs.py'), dir], {
    encoding: 'utf8', env: { ...process.env, MODELSCOPE_API_KEY: 'test-secret', EXPECTED_PACK: name, FAIL_PAYLOAD: fail ? '1' : '' },
  });
  const output = run(false);
  assert.ok(!output.includes('test-secret'));
  assert.deepEqual(JSON.parse(output.split('CALLS=')[1]), [name, 'resource-packs.json']);
  assert.deepEqual(JSON.parse(run(true).split('CALLS=')[1]), [name]);
});
