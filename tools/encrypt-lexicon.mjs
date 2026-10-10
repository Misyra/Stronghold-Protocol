#!/usr/bin/env node
// Encrypt a private UTF-8 source file; never print the key or decoded dictionary.
import { readFileSync, writeFileSync } from 'node:fs';
import { encryptLexicon, readLexiconKey } from '../server/moderation/lexicon.js';

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) {
  console.error('Usage: node tools/encrypt-lexicon.mjs <private-words.txt> <words.enc>');
  process.exitCode = 1;
} else {
  const key = readLexiconKey();
  const bytes = readFileSync(input);
  try {
    writeFileSync(output, encryptLexicon(bytes, key));
    console.log('Encrypted dictionary written. Keep the key outside Git and public directories.');
  } finally { key.fill(0); bytes.fill(0); }
}
