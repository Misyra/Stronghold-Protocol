// Explicit test/smoke preload only. Never imported by production or shipped in release packages.
// Public CI exercises a small independent dictionary, not the encrypted production dictionary or its key.
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_KEY_FILE, encryptLexicon } from '../../server/moderation/lexicon.js';

export function installTestLexicon({ force = false } = {}) {
  if (!force && (process.env.SP_MODERATION_KEY !== undefined || process.env.SP_MODERATION_KEY_FILE !== undefined || existsSync(DEFAULT_KEY_FILE))) return;
  const words = ['\u50bb\u903c', '\u50bbb', '\u64cd\u4f60\u5988', '\u64cd\u4f60\u5abd', '\u7ea6\u70ae', '\u88f8\u804a',
    '\u4e60\u8fd1\u5e73', '\u7fd2\u8fd1\u5e73', '\u6cd5\u8f2a\u529f', '\u9999\u6e2f\u7368\u7acb', '\u5929\u5b89\u9580\u5c60\u6bba',
    ...Buffer.from('ZnVjayxiaXRjaCxubXNsLDg5NjQsMTk4OTA2MDQseGlqaW5waW5n', 'base64').toString().split(',')].sort();
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-moderation-test-'));
  const key = randomBytes(32);
  delete process.env.SP_MODERATION_KEY;
  process.env.SP_MODERATION_KEY_FILE = path.join(dir, 'test.key');
  process.env.SP_MODERATION_LEXICON_FILE = path.join(dir, 'test.enc');
  writeFileSync(process.env.SP_MODERATION_KEY_FILE, key.toString('hex'), { mode: 0o600 });
  writeFileSync(process.env.SP_MODERATION_LEXICON_FILE, encryptLexicon(Buffer.from(words.join('\n') + '\n'), key));
  key.fill(0);
  const keyFile = process.env.SP_MODERATION_KEY_FILE, dictionary = process.env.SP_MODERATION_LEXICON_FILE;
  process.on('exit', () => { unlinkSync(keyFile); unlinkSync(dictionary); rmdirSync(dir); });
}
installTestLexicon();
