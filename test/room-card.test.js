// 名片干员 (room.card): a cosmetic operator choice that every client in the room sees, refused when the id is not an
// operator this install knows. Display metadata only — it never reaches the match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { DATA } from './match/harness.js';
import { ERR } from '../shared/constants.js';

const charId = Object.keys(DATA.chess).find((id) => {
  const rec = DATA.chess[id];
  return rec && !rec.isDiy && rec.visible !== false && typeof rec.charId === 'string';
}) && DATA.chess[Object.keys(DATA.chess).find((id) => DATA.chess[id]?.charId)]?.charId;

test('room.card stores a checked operator on the seat and broadcasts it to the room', async (t) => {
  const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null, stateFile: 'off' });
  t.after(() => game.close());
  const a = await TestClient.connect(`ws://127.0.0.1:${game.port}/ws`);
  t.after(() => a.close());
  await a.hello('CardA');
  await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const created = await a.waitFor('room.state');
  const myId = created.seats[0].playerId;
  assert.equal(created.seats[0].card, undefined, 'no card until the player picks one');

  assert.equal((await a.request({ t: 'room.card', charId })).t, 'ok');
  const after = await a.waitFor('room.state', (s) => !!s.seats?.[0]?.card);
  assert.equal(after.seats[0].card.charId, charId);
  assert.equal(after.seats[0].playerId, myId);

  // An unknown operator is refused and leaves the stored card alone.
  assert.equal((await a.request({ t: 'room.card', charId: 'char_does_not_exist' })).code, ERR.BAD_TARGET);
  // An empty string clears it (the default "by doctor id" art).
  await a.request({ t: 'room.card', charId: '' });
  const cleared = await a.waitFor('room.state', (s) => s.seats?.[0]?.card === undefined);
  assert.equal(cleared.seats[0].card, undefined);
});
