import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encryptLexicon, decryptLexicon, parseLexiconKey, readLexiconKey, loadLexicon } from '../server/moderation/lexicon.js';

test('authenticated encryption roundtrips Unicode, compresses, and uses a fresh nonce each time', () => {
  const key = randomBytes(32), input = Buffer.from('测试词条\nexample\n'.repeat(1000));
  const a = encryptLexicon(input, key), b = encryptLexicon(input, key);
  assert.deepEqual(decryptLexicon(a, key), input);
  assert.deepEqual(decryptLexicon(b, key), input);
  assert.notDeepEqual(a, b);
  assert.ok(a.length < input.length / 2);
  assert.equal(a.includes(Buffer.from('测试词条')), false);
  assert.equal(a.includes(key), false);
});

test('wrong keys, header/nonce/tag/ciphertext tampering and truncation fail closed', () => {
  const key = randomBytes(32), bytes = encryptLexicon(Buffer.from('test dictionary\n'), key);
  assert.throws(() => decryptLexicon(bytes, randomBytes(32)), /解密失败/);
  for (const index of [0, 8, 20, 36, bytes.length - 1]) {
    const bad = Buffer.from(bytes); bad[index] ^= 1;
    assert.throws(() => decryptLexicon(bad, key), /格式无效|解密失败/);
  }
  for (const length of [0, 8, 35, bytes.length - 1])
    assert.throws(() => decryptLexicon(bytes.subarray(0, length), key), /格式无效|解密失败/);
  assert.throws(() => encryptLexicon(Buffer.alloc(4 * 1024 * 1024 + 1), key), /大小限制/);
});

test('private key files and environment settings load without a built-in fallback or key disclosure', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-lexicon-crypto-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('sp-lexicon-crypto-'));
    rmSync(dir, { recursive: true, force: true });
  });
  const key = randomBytes(32), hex = key.toString('hex');
  const keyFile = path.join(dir, 'private.key'), dictionary = path.join(dir, 'words.enc');
  writeFileSync(keyFile, hex + '\n');
  writeFileSync(dictionary, encryptLexicon(Buffer.from('fixture\n'), key));
  assert.deepEqual(readLexiconKey({ SP_MODERATION_KEY_FILE: keyFile }), key);
  assert.deepEqual(readLexiconKey({ SP_MODERATION_KEY: hex, SP_MODERATION_KEY_FILE: 'missing' }), key);
  assert.equal(loadLexicon({ SP_MODERATION_KEY_FILE: keyFile, SP_MODERATION_LEXICON_FILE: dictionary }).toString(), 'fixture\n');
  assert.throws(() => readLexiconKey({ SP_MODERATION_KEY_FILE: path.join(dir, 'missing') }), /密钥缺失/);
  for (const value of ['', 'short-secret', 'g'.repeat(64), hex + '00'])
    assert.throws(() => parseLexiconKey(value), error => !error.message.includes('short-secret') && /64/.test(error.message));
  assert.throws(() => readLexiconKey({ SP_MODERATION_KEY: '', SP_MODERATION_KEY_FILE: keyFile }), /64/);

  // Real server startup must fail before it starts serving if moderation cannot be loaded.
  const env = { ...process.env, SP_MODERATION_KEY_FILE: path.join(dir, 'missing'), SP_MODERATION_LEXICON_FILE: dictionary };
  delete env.SP_MODERATION_KEY;
  const child = spawnSync(process.execPath, ['server/index.js'], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /密钥缺失/);
  assert.equal(child.stderr.includes(hex), false);

  const input = path.join(dir, 'input.txt'), output = path.join(dir, 'encrypted.enc');
  writeFileSync(input, 'fixture\n');
  const tool = spawnSync(process.execPath, ['tools/encrypt-lexicon.mjs', input, output], {
    env: { ...env, SP_MODERATION_KEY: hex }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(tool.status, 0, tool.stderr);
  assert.equal(tool.stdout.includes(hex), false);
  assert.equal(decryptLexicon(readFileSync(output), key).toString(), 'fixture\n');
});
