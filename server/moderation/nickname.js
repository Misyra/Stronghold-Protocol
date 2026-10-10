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
// Decode once in server memory; never write or serve the plaintext dictionary. Base64 is encoding, not encryption.
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

/** Match in normalized text while retaining offsets into the original Unicode characters. */
export function maskSensitiveText(value) {
  if (typeof value !== 'string') return { text: '', hit: false };
  const original = [...value], compact = [], positions = [], raw = [], rawPositions = [];
  original.forEach((char, i) => {
    for (const c of char.normalize('NFKD').toLowerCase()) {
      if (/\p{M}/u.test(c)) continue;
      raw.push(c); rawPositions.push(i);
      if (/[\p{L}\p{N}]/u.test(c)) { compact.push(c); positions.push(i); }
    }
  });
  const masked = new Set();
  const mark = (start, end, map) => {
    const a = map[start], b = map[end - 1];
    for (let i = a; i <= b; i++) masked.add(i);
    // Also hide trailing combining marks belonging to the last matched character.
    for (let i = b + 1; i < original.length && /\p{M}/u.test(original[i]); i++) masked.add(i);
  };
  for (const [chars, map] of [[raw, rawPositions], [compact, positions]]) {
    // ASCII token offsets must be UTF-16 offsets, so build a matching offset map.
    const offsets = chars.flatMap((char, i) => Array(char.length).fill(map[i]));
    const text = chars.join('');
    for (const [pattern, terms] of [[/[a-z]+/g, latin], [/[0-9]+/g, numbers], [/[a-z0-9]+/g, alphanumeric]]) {
      for (const match of text.matchAll(pattern)) if (terms.has(match[0])) mark(match.index, match.index + match[0].length, offsets);
    }
  }
  for (let i = 0; i < compact.length; i++) {
    let node = root;
    for (let j = i; j < compact.length; j++) {
      node = node.next.get(compact[j]);
      if (!node) break;
      if (node.end) mark(i, j + 1, positions);
    }
  }
  return { text: original.map((char, i) => masked.has(i) ? '*' : char).join(''), hit: masked.size > 0 };
}

export function hasSensitiveNickname(value) {
  return maskSensitiveText(value).hit;
}
