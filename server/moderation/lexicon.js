// i18n-ignore-file: private server configuration and diagnostics.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

// Versioned, authenticated binary format: header | 12-byte nonce | 16-byte tag | ciphertext.
const HEADER = Buffer.from('SPLEX001');
const MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LEXICON = new URL('./lexicon/words.enc', import.meta.url);
export const DEFAULT_KEY_FILE = new URL('../../.state/moderation.key', import.meta.url);

export function parseLexiconKey(value) {
  const text = String(value ?? '').trim();
  if (!/^[a-f\d]{64}$/i.test(text)) throw new Error('SP_MODERATION_KEY 必须是 64 位十六进制随机密钥');
  return Buffer.from(text, 'hex');
}

export function readLexiconKey(env = process.env) {
  if (env.SP_MODERATION_KEY !== undefined) return parseLexiconKey(env.SP_MODERATION_KEY);
  let value;
  try { value = readFileSync(env.SP_MODERATION_KEY_FILE || DEFAULT_KEY_FILE, 'utf8'); } catch {
    throw new Error('词表密钥缺失或不可读：请配置 SP_MODERATION_KEY 或 SP_MODERATION_KEY_FILE（默认 .state/moderation.key）');
  }
  return parseLexiconKey(value);
}

export function encryptLexicon(plaintext, key) {
  if (plaintext.length > MAX_BYTES) throw new Error('词表超过大小限制');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(HEADER);
  const compressed = gzipSync(plaintext, { level: 9 });
  try {
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    return Buffer.concat([HEADER, nonce, cipher.getAuthTag(), ciphertext]);
  } finally { compressed.fill(0); }
}

export function decryptLexicon(bytes, key) {
  if (bytes.length < 37 || bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(HEADER))
    throw new Error('加密词表格式无效');
  let compressed;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(8, 20));
    decipher.setAAD(HEADER);
    decipher.setAuthTag(bytes.subarray(20, 36));
    compressed = Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]);
    return gunzipSync(compressed, { maxOutputLength: MAX_BYTES });
  } catch {
    throw new Error('词表解密失败：密钥不匹配或文件损坏，审核未被关闭');
  } finally { compressed?.fill(0); }
}

export function loadLexicon(env = process.env) {
  const key = readLexiconKey(env);
  try {
    return decryptLexicon(readFileSync(env.SP_MODERATION_LEXICON_FILE || DEFAULT_LEXICON), key);
  } finally { key.fill(0); }
}
