import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_LANGUAGES, normalizeVoiceLanguage, voiceCandidates } from '../public/js/voiceLanguage.js';
import { createVoiceLanguageStore } from '../public/js/ui/voiceLanguage.js';
import { getLang } from '../shared/i18n.js';

const chinese = { char_a: { place: ['/cn/one.mp3', '/cn/two.mp3'], skill1: '/cn/skill.mp3' } };
const manifest = { audio: { voice: chinese, voiceByLang: {
  cn: chinese, jp: { char_a: { place: ['/jp/one.mp3', '/jp/two.mp3'], skill1: '/jp/skill.mp3' } },
  en: { char_a: { place: ['/en/one.mp3', '/en/two.mp3'] } },
} } };

test('only supported voice language codes are admitted, independent of interface-language codes', () => {
  // 0.3.0 adds the Korean dub (voiceKr); 'ko' stays an interface-language code
  assert.deepEqual(VOICE_LANGUAGES, ['cn', 'jp', 'en', 'kr']);
  for (const code of VOICE_LANGUAGES) assert.equal(normalizeVoiceLanguage(code), code);
  for (const value of [null, {}, [], 'ja', 'zh', 'ko', '__proto__', 'https://example.com/']) assert.equal(normalizeVoiceLanguage(value), 'cn');
});
test('voice selection uses the listener language and one Chinese fallback of the same battle slot', () => {
  assert.deepEqual(voiceCandidates(manifest, 'char_a', 'place', 'cn', () => 0), ['/cn/one.mp3']);
  assert.deepEqual(voiceCandidates(manifest, 'char_a', 'place', 'jp', () => .9), ['/jp/two.mp3', '/cn/two.mp3']);
  assert.deepEqual(voiceCandidates(manifest, 'char_a', 'place', 'en', () => 0), ['/en/one.mp3', '/cn/one.mp3']);
  assert.deepEqual(voiceCandidates(manifest, 'char_a', 'skill1', 'en'), ['/cn/skill.mp3']);
  assert.deepEqual(voiceCandidates(manifest, 'missing', 'place', 'en'), []);
  assert.deepEqual(voiceCandidates(manifest, 'char_a', 'missing', 'jp'), []);
  assert.deepEqual(voiceCandidates(null, 'char_a', 'place', 'jp'), []);
  assert.deepEqual(voiceCandidates(manifest, '__proto__', 'place', 'jp'), []);
});
test('legacy single-language manifests remain usable and empty new entries do not hide old Chinese lines', () => {
  const old = { audio: { voice: chinese } };
  assert.deepEqual(voiceCandidates(old, 'char_a', 'skill1', 'jp'), ['/cn/skill.mp3']);
  const empty = { audio: { voice: chinese, voiceByLang: { cn: { char_a: { skill1: [] } }, jp: {} } } };
  assert.deepEqual(voiceCandidates(empty, 'char_a', 'skill1', 'cn'), ['/cn/skill.mp3']);
  const same = { audio: { voice: chinese, voiceByLang: { jp: chinese } } };
  assert.deepEqual(voiceCandidates(same, 'char_a', 'skill1', 'jp'), ['/cn/skill.mp3'], 'no repeated fallback URL');
});
test('voice preferences restore independently, write only voiceLang and never change UI or another listener', () => {
  const ui = getLang(), storageA = new Map([['voiceLang', 'jp']]), storageB = new Map([['voiceLang', 'cn']]);
  const callsA = [], callsB = [];
  const make = (storage, calls) => createVoiceLanguageStore({ load: (key, fallback) => storage.get(key) ?? fallback,
    save: (key, value) => storage.set(key, value), manager: { setVoiceLanguage(value) { calls.push(value); } } });
  const a = make(storageA, callsA), b = make(storageB, callsB);
  assert.equal(a.get().language, 'jp'); assert.equal(b.get().language, 'cn');
  a.set({ language: 'en' });
  assert.deepEqual([...storageA], [['voiceLang', 'en']]); assert.deepEqual([...storageB], [['voiceLang', 'cn']]);
  assert.deepEqual(callsA, ['jp', 'en']); assert.deepEqual(callsB, ['cn']);
  assert.equal(make(storageA, []).get().language, 'en', 'a fresh page restores the saved preference');
  assert.equal(make(new Map([['voiceLang', 'unsupported']]), []).get().language, 'cn');
  assert.equal(getLang(), ui);
});
test('lobby language lives only in shared settings, which retain both language choices', () => {
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const lobby = read('public/js/screens/lobby.js');
  const controls = read('public/js/ui/languageSettings.js'), settings = read('public/js/ui/settings.js');
  assert.doesNotMatch(lobby, /LanguageButton/);
  assert.match(lobby, /<\$\{SettingsButton\}/);
  assert.match(controls, /data-testid="lobby-language"/);
  assert.match(controls, /data-testid="voice-language-toggle"/);
  assert.match(controls, /<\$\{LangToggle\}/);
  assert.match(controls, /trapFocus=\$\{true\}/);
  assert.match(settings, /<\$\{LanguageSettings\}/);
});
