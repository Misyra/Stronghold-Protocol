// The owner (服主) mark (server/ownerFile.js, 移植自用户分支): SP_OWNER_FILE `{ names, keySha256 }`; a hello whose
// `owner` key hashes to keySha256 is the owner (welcome.owner, room.state seats[] / spectators[] owner), decided again on
// every hello; the owner's reserved names are refused to everybody else (NAME_REJECTED 'reserved'). No file / an invalid
// one = off. The key and its hash never reach a log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOwnerFile, parseOwnerFile, ownerNameKey, NAME_RESERVED, OWNER_FILE_LIMITS } from '../server/ownerFile.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';
import { isOwnerSeat, isOwnerPlayer } from '../public/js/ui/ownerName.js';

const KEY = 'test-owner-key-0123456789';
const HASH = createHash('sha256').update(KEY).digest('hex');
const ownerDoc = (names = ['Stardust', '服主']) => JSON.stringify({ names, keySha256: HASH });

function tempFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'owner.json');
}
const capture = () => {
  const lines = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...args) => lines.push(args.map(String).join(' '))]));
  return { lines, log };
};
const leaks = (lines) => lines.filter((l) => l.includes(KEY) || l.toLowerCase().includes(HASH));

test('the hello field and the file format: names + a SHA-256 hex digest, nothing else', () => {
  assert.equal(validateC2S({ t: 'hello', name: 'A', owner: KEY }), null);
  assert.equal(validateC2S({ t: 'hello', name: 'A', owner: 'x'.repeat(129) }), 'bad field owner');
  assert.equal(validateC2S({ t: 'hello', name: 'A', owner: 5 }), 'bad field owner');
  const parsed = parseOwnerFile(JSON.parse(ownerDoc()));
  assert.deepEqual([...parsed.names], ['stardust', '服主']);
  assert.equal(parsed.hash.toString('hex'), HASH);
  assert.ok(parseOwnerFile({ names: [], keySha256: HASH.toUpperCase() }), 'no reserved name, upper-case hex');
  for (const bad of [null, [], {}, { names: ['a'] }, { keySha256: HASH }, { names: 'a', keySha256: HASH },
    { names: ['a'], keySha256: HASH.slice(1) }, { names: ['a'], keySha256: `${HASH.slice(1)}g` }, { names: [''], keySha256: HASH },
    { names: [' ​ '], keySha256: HASH }, { names: [7], keySha256: HASH }, { names: ['a'], keySha256: HASH, key: KEY },
    { names: Array(OWNER_FILE_LIMITS.names + 1).fill('a'), keySha256: HASH }]) {
    assert.equal(parseOwnerFile(bad), null, JSON.stringify(bad));
  }
  // NFKC, no whitespace / invisible characters, case-folded
  for (const v of ['Stardust', ' ＳＴＡＲ dust ', 'star​DUST', 'S t a r d u s t']) assert.equal(ownerNameKey(v), 'stardust', v);
  assert.equal(ownerNameKey('Straße'), ownerNameKey('STRASSE'));
  assert.notEqual(ownerNameKey('Stardust2'), 'stardust');
});

test('the file follows its edits: valid = on, invalid or removed = off; logs carry neither the key nor its hash', async (t) => {
  const file = tempFile(t);
  const { lines, log } = capture();
  const owner = createOwnerFile({ file, pollMs: 60_000, log });
  t.after(() => owner.close());
  assert.equal(await owner.refresh(), false, 'no file: off');
  assert.equal(owner.verify(KEY), false);
  assert.equal(owner.reserved('Stardust'), false);
  writeFileSync(file, ownerDoc());
  assert.equal(await owner.refresh(), true);
  assert.equal(owner.verify(KEY), true);
  for (const key of ['', 'wrong', `${KEY} `, null, undefined, 42]) assert.equal(owner.verify(key), false, String(key));
  assert.equal(owner.reserved('ｓｔａｒＤＵＳＴ'), true);
  assert.equal(owner.reserved('服 主'), true);
  assert.equal(owner.reserved('Amiya'), false);
  writeFileSync(file, '{ "names": ["Stardust"], "keySha256": "not-a-digest" }');
  assert.equal(await owner.refresh(), false, 'an invalid edit switches it off');
  assert.equal(owner.verify(KEY), false);
  assert.equal(owner.reserved('Stardust'), false);
  writeFileSync(file, ownerDoc(['Other']));
  assert.equal(await owner.refresh(), true);
  assert.equal(owner.reserved('Stardust'), false);
  assert.equal(owner.reserved('other'), true);
  rmSync(file);
  assert.equal(await owner.refresh(), false, 'removed: off');
  assert.ok(lines.some((l) => l.includes('owner file loaded: 2 names')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('owner file invalid')), lines.join('\n'));
  assert.deepEqual(leaks(lines), []);
  assert.equal(createOwnerFile().verify(KEY), false, 'no file configured: nobody');
});

test('a real server: the key makes the owner on every hello only; reserved names are refused to anybody else', async (t) => {
  const file = tempFile(t);
  writeFileSync(file, ownerDoc());
  const { lines, log } = capture();
  const srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: StubMatch, ownerFile: file });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  const connect = async () => { const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c); return c; };
  const lastState = (c, pred = () => true) => c.waitFor('room.state', pred);

  const host = await connect();
  const welcome = await host.hello('Stardust', undefined, { owner: KEY });
  assert.equal(welcome.owner, true, 'welcome confirms the key');
  assert.equal(srv.registry.byId(welcome.playerId).owner, true);
  assert.deepEqual(await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }), { t: 'ok', rid: host.nextRid - 1 });
  const created = await lastState(host);
  assert.equal(created.seats[0].owner, true);

  // somebody else: a reserved name in any spelling is refused, with or without a wrong key
  const guest = await connect();
  for (const [name, extra] of [[' ＳＴＡＲdust', {}], ['服 主', {}], ['Stardust', { owner: 'guess' }], ['Stardust', { owner: '' }]]) {
    const refused = await guest.request({ t: 'hello', name, version: 1, ...extra });
    assert.equal(refused.code, ERR.NAME_REJECTED, name);
    assert.equal(refused.detail, NAME_RESERVED);
  }
  const guestWelcome = await guest.hello('Amiya', undefined, { owner: 'guess' });
  assert.equal(Object.hasOwn(guestWelcome, 'owner'), false);
  await guest.request({ t: 'room.join', code: created.code });
  const joined = await lastState(host, (m) => m.seats[1]);
  assert.equal(joined.seats[0].owner, true);
  assert.equal(Object.hasOwn(joined.seats[1], 'owner'), false);

  // the owner spectating another room is marked there too
  const other = await connect();
  await other.hello('Kal\'tsit');
  await other.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const otherRoom = await lastState(other);
  const watcher = await connect();
  await watcher.hello('服主', undefined, { owner: KEY });
  await watcher.request({ t: 'room.spectate', code: otherRoom.code });
  const watched = await lastState(other, (m) => m.spectators.length === 1);
  assert.equal(watched.spectators[0].owner, true);

  // a reload without the key: the same identity, no mark — and the reserved name is refused without the key
  const reload = await connect();
  const noKey = await reload.request({ t: 'hello', name: 'Stardust', version: 1, token: welcome.token });
  assert.equal(noKey.code, ERR.NAME_REJECTED);
  assert.equal(srv.registry.byId(welcome.playerId).owner, true, 'a refused hello changes nothing');
  const resumed = await reload.hello('Doctor', welcome.token);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.playerId, welcome.playerId);
  assert.equal(Object.hasOwn(resumed, 'owner'), false, 'never sticky without the key');
  assert.equal(srv.registry.byId(welcome.playerId).owner, false);
  const unmarked = await lastState(guest, (m) => m.seats[0]?.name === 'Doctor');
  assert.equal(Object.hasOwn(unmarked.seats[0], 'owner'), false);
  // a repeated hello with the key on the same socket marks it again (broadcast to the room)
  const again = await reload.hello('Stardust', welcome.token, { owner: KEY });
  assert.equal(again.owner, true);
  const remarked = await lastState(guest, (m) => m.seats[0]?.name === 'Stardust');
  assert.equal(remarked.seats[0].owner, true);

  assert.deepEqual(leaks(lines), []);
});

test('no owner file: nobody is the owner and no name is reserved', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, ownerFile: null });
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(async () => { await client.terminate(); await srv.close(); });
  const welcome = await client.hello('Stardust', undefined, { owner: KEY });
  assert.equal(Object.hasOwn(welcome, 'owner'), false);
});

test('the client reads the mark from the room.state alone, never from a name', () => {
  assert.equal(isOwnerSeat({ owner: true, isBot: false }), true);
  assert.equal(isOwnerSeat({ owner: true, isBot: true }), false, 'an AI seat never shows it');
  assert.equal(isOwnerSeat({ owner: false }), false);
  assert.equal(isOwnerSeat(null), false);
  const room = { seats: [{ playerId: 'a', owner: true, isBot: false }, { playerId: 'b', isBot: false }], spectators: [{ playerId: 'w', owner: true }] };
  assert.equal(isOwnerPlayer(room, { playerId: 'a' }), true);
  assert.equal(isOwnerPlayer(room, { playerId: 'a', isBot: true }), false, 'a frame cannot make an AI the owner');
  assert.equal(isOwnerPlayer(room, { playerId: 'b' }), false);
  assert.equal(isOwnerPlayer(room, 'w'), true, 'a spectator seat marks too');
  assert.equal(isOwnerPlayer(room, 'gone'), false, 'a player the room no longer seats does not');
  assert.equal(isOwnerPlayer(null, 'a'), false);
  assert.equal(isOwnerPlayer({ seats: [] }, 'a'), false);
});
