// test/match/fixtures/hostMatch.js — a match module for the match host tests (test/match/plugin-host.test.js; startServer
// `matchHost.matchModule`, server/match/host/entry.js imports it instead of server/match/Match.js — like the lobby's
// MatchClass for an in-process match). The platform's StubMatch (server/match/StubMatch.js) with three test hooks:
//   g.emote 'hang'-style: an emote id ending in `_hang` would be refused by the protocol, so the hooks are emote INDEXES —
//   g.emote with EMOTES[0] answers after reading the content set's data (what the worker installed: the reply carries
//   nothing, the match posts an m.toast naming data facts), EMOTES[1] spins forever (the worker stops answering and
//   beating: the watchdog's case), EMOTES[2] throws out of the worker's event loop (an uncaught error: the crash case).
// Never used by the server itself.

import { StubMatch } from '../../../server/match/StubMatch.js';
import { EMOTES } from '../../../shared/constants.js';
import { getData } from '../../../server/data.js';

export class Match extends StubMatch {
  handle(playerId, msg) {
    if (msg && msg.t === 'g.emote' && msg.id === EMOTES[0]) {
      const d = getData();
      const modes = Object.keys(d.config?.modes || {});
      this.sendFn(playerId, { t: 'm.toast', kind: 'info', text: `modes=${modes.join(',')};chess=${Object.keys(d.chess || {}).length};cs=${this.opts.cs || ''};requireCs=${this.opts.requireCs === true}` });
      return { ok: true };
    }
    if (msg && msg.t === 'g.emote' && msg.id === EMOTES[1]) {
      for (;;) { /* the plugin's code never returns: no answer, no heartbeat */ }
    }
    if (msg && msg.t === 'g.emote' && msg.id === EMOTES[2]) {
      setTimeout(() => { throw new Error('a plugin crashed its worker'); }, 0);
      return { ok: true };
    }
    return super.handle(playerId, msg);
  }
}
