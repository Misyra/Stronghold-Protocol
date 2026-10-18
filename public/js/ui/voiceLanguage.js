// A browser's voice preference is independent of its UI language and every player's room settings.
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { audio } from '../audio.js';
import { normalizeVoiceLanguage } from '../voiceLanguage.js';

export function createVoiceLanguageStore({ load = loadPref, save = savePref, manager = audio } = {}) {
  const target = createStore({ language: normalizeVoiceLanguage(load('voiceLang', 'cn')) });
  manager.setVoiceLanguage(target.get().language);
  target.subscribe(state => {
    save('voiceLang', state.language);
    manager.setVoiceLanguage(state.language);
  });
  return target;
}

export const voiceLanguageStore = createVoiceLanguageStore();
export const useVoiceLanguage = () => useStore(state => state.language, Object.is, voiceLanguageStore);
export function setVoiceLanguage(language) {
  const next = normalizeVoiceLanguage(language);
  if (next !== voiceLanguageStore.get().language) voiceLanguageStore.set({ language: next });
}
