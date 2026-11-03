// tools/versions/act2autochess.mjs — build profile of the default version, 第二期下半: 盟约·下半 (act2autochess) in its
// final state V2_2 (docs/DATA.md "Official versions (M0)", DESIGN §35.22). Kengxxiao/ArknightsGameData dropped
// AUTOCHESS_SEASON from activity_table with client 2.7.91 (08ba2aea, 2026-11-01), so master can no longer build the mode.
// Every table is read at 17759cc8 (2026-10-08), the commit the current data was built from (the rebuild is byte-identical),
// the research is in docs/research/, the tables are the 下半-measured ones of tools/build-data.mjs, and there is no
// config.version. The operators of 2026-11-01 are newer than that pin: only their own records come from 08ba2aea.

export default Object.freeze({
  id: 'act2autochess',
  season: 'act2autochess',
  pins: Object.freeze({ default: '17759cc8cdf37388414145d16262a3a06f3ab25e' }),
  // 冻河, 国度 and 塔露拉 (2026-11-01) are newer than the pin; only their own records come from the later commit, so no
  // other operator moves (the owner's decision of 2026-11-02)
  lateOperators: Object.freeze({ sha: '08ba2aea0e8dba88eff0ec0d2c87e24b4db626f8', charIds: Object.freeze(['char_4244_tocka', 'char_4246_dminon', 'char_4247_oxi']) }),
  adapters: Object.freeze([]),
  research: null,                // docs/research/
  tables: 'default',             // stock / shopDraft / tacticDraft / bountyDrafts as measured on 下半
  config: Object.freeze({ hiddenCore: Object.freeze({ single: 350, multi: 1200 }) }), // no rules: no config.version
  expect: Object.freeze({ bonds: 23, bands: 40, visibleNonDiy: 112, triggerDeviations: 'default' }),
});
