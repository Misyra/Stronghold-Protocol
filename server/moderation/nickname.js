// i18n-ignore-file: server-only moderation data; no UI strings.
// Server-only: never import this module from public/, shared/ or server/sim/.
// Vendored literal terms, compiled once. No remote calls during validation.
import { readFileSync } from 'node:fs';
import { NAME_MAX_LEN } from '../../shared/constants.js';

const comparable = value => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const latin = new Set(), numbers = new Set(), alphanumeric = new Set();
/** @typedef {{ end?: boolean, next: Map<string, Trie> }} Trie */
/** @type {Trie} */
const root = { next: new Map() };
// A single effective word list, merged and deduplicated before deployment.
const encodedWords = readFileSync(new URL('./lexicon/words.b64', import.meta.url), 'ascii');
const lines = Buffer.from(encodedWords, 'base64').toString('utf8').split(/\r?\n/);
for (const line of lines) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  const term = comparable(line.trim());
  if ([...term].length < 2 || term.length > NAME_MAX_LEN) continue;
  if (/^[a-z]+$/.test(term)) { latin.add(term); continue; }
  if (/^[0-9]+$/.test(term)) { numbers.add(term); continue; }
  if (/^[a-z0-9]+$/.test(term)) { alphanumeric.add(term); continue; }
  let node = root;
  for (const char of term) {
    if (!node.next.has(char)) node.next.set(char, { next: new Map() });
    node = node.next.get(char);
  }
  node.end = true;
}

/** Only a boolean leaves this module; never expose matches or dictionary data. @param {unknown} value */
export function hasSensitiveNickname(value) {
  if (typeof value !== 'string') return false;
  const text = comparable(value);
  const raw = value.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '');
  for (const sample of [raw, text]) {
    if ((sample.match(/[a-z]+/g) || []).some(word => latin.has(word))) return true;
    if ((sample.match(/[0-9]+/g) || []).some(word => numbers.has(word))) return true;
    if ((sample.match(/[a-z0-9]+/g) || []).some(word => alphanumeric.has(word))) return true;
  }
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    let node = root;
    for (let j = i; j < chars.length; j++) {
      node = node.next.get(chars[j]);
      if (!node) break;
      if (node.end) return true;
    }
  }
  return false;
}
