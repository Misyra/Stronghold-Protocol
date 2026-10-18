import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsStore, updateSettings } from '../../public/js/ui/settings.js';
import { voiceLanguageStore, setVoiceLanguage } from '../../public/js/ui/voiceLanguage.js';
import { audio } from '../../public/js/audio.js';
import { VOICE_LANGS, sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';

test('one canonical CN/JP/EN preference survives volume changes and mirrors the compatible settings field', () => {
  const before = settingsStore.get(), previous = voiceLanguageStore.get().language;
  try {
    assert.deepEqual(VOICE_LANGS, ['cn', 'jp', 'en', 'kr']); // 0.3.0: + the Korean dub
    for (const language of VOICE_LANGS) {
      setVoiceLanguage(language);
      assert.equal(voiceLanguageStore.get().language, language);
      assert.equal(settingsStore.get().voiceLang, language);
      assert.equal(audio.voiceLanguage, language);
      assert.equal(audio.voiceLang, language);
      updateSettings({ bgm: 0.23, sfx: 0.31, voice: 0.47 });
      assert.equal(voiceLanguageStore.get().language, language);
      assert.equal(settingsStore.get().voiceLang, language);
      assert.equal(audio.voiceLanguage, language);
      assert.equal(sanitizeSettings(settingsStore.get()).voiceLang, language);
    }
    updateSettings({ voiceLang: 'jp' });
    assert.equal(voiceLanguageStore.get().language, 'jp');
    assert.equal(audio.voiceLanguage, 'jp');
    updateSettings({ voiceLang: 'invalid' });
    assert.equal(voiceLanguageStore.get().language, 'cn');
  } finally {
    setVoiceLanguage(previous);
    updateSettings(before);
  }
});
