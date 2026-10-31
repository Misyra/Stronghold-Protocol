// i18n-ignore-file: server-only moderation data; no UI strings.
// Server-only: never import this module from public/, shared/ or server/sim/.
// Vendored literal terms, compiled once. No remote calls during validation.
import { loadLexicon } from './lexicon.js';

const comparable = value => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const latin = new Set(), numbers = new Set(), alphanumeric = new Set();
/** @typedef {{ end?: boolean, next: Map<string, Trie> }} Trie */
/** @type {Trie} */
const root = { next: new Map() };
let initialized = false;
export function initializeModeration() {
  if (initialized) return;
  // Decrypt once in server memory. The key is private deployment configuration, never bundled with the dictionary.
  const plaintext = loadLexicon();
  const lines = plaintext.toString('utf8').split(/\r?\n/);
  plaintext.fill(0);
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const term = comparable(line.trim());
    if ([...term].length < 2 || [...term].length > 128) continue;
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
  lines.length = 0;

  initialized = true;
}

/** Match in normalized text while retaining offsets into the original Unicode characters. */
export function maskSensitiveText(value) {
  if (typeof value !== 'string') return { text: '', hit: false };
  initializeModeration();
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
      for (const match of text.matchAll(pattern)) {
        if (terms.has(match[0])) mark(match.index, match.index + match[0].length, offsets);
        else if (terms === latin) {
          const end = match[0].length - 1;
          if (end >= 4 && terms.has(match[0].slice(0, end))) mark(match.index, match.index + end, offsets);
        }
      }
    }
  }
  for (let i = 0; i < compact.length; i++) {
    let states = [{ node: root, skipped: false, length: 0 }];
    for (let j = i; j < compact.length && states.length; j++) {
      const next = [];
      for (const state of states) {
        const child = state.node.next.get(compact[j]);
        if (child) {
          const length = state.length + 1;
          if (child.end && (!state.skipped || length >= 3)) mark(i, j + 1, positions);
          next.push({ node: child, skipped: state.skipped, length });
        }
        if (!state.skipped && state.length > 0) next.push({ ...state, skipped: true });
      }
      states = next;
    }
  }
  return { text: original.map((char, i) => masked.has(i) ? '*' : char).join(''), hit: masked.size > 0 };
}

/** Detection without the masked form — chat refusals never need the starred text. */
export function hasSensitiveText(value) {
  return maskSensitiveText(value).hit;
}

export function hasSensitiveNickname(value) {
  return hasSensitiveText(value);
}
