/** Download languages are independent of the listener's playback language. null follows playback on older settings. */
export const PRELOAD_VOICE_LANGUAGES = Object.freeze(['cn', 'jp', 'en', 'kr', 'native']);

export function normalizePreloadVoiceLanguages(value) {
  return Array.isArray(value) ? PRELOAD_VOICE_LANGUAGES.filter((lang) => value.includes(lang)) : null;
}

export function selectedVoiceLanguages(value, playback = 'cn') {
  return normalizePreloadVoiceLanguages(value) ?? [PRELOAD_VOICE_LANGUAGES.includes(playback) ? playback : 'cn'];
}
