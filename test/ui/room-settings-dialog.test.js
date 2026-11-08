// 同盟设置 (ui/roomSettings.js, ported from the Stardust fork's rel24 panel and its test): the room's options in one
// dialog — 同盟 / 规则 / 卡池 three pages, a solo room its single 模拟设置 page without tabs. The rows (ui/experimental.js)
// carry only the keys this repo's server knows (shared/experimental.js); the fork's PoolEditor / enemy multipliers /
// 公开到同盟列表 are not ported. The browser check is test/ui/room-settings.e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capacityRows, duckLordRow, poolRows, roomExperimental, ruleRows, switchRow } from '../../public/js/ui/experimental.js';
import { changedPages, RoomSettings, settingsPage, settingsPages } from '../../public/js/ui/roomSettings.js';
import { experimentalOptions } from '../../shared/experimental.js';
import { MAX_SEATS } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const walk = (node) => (Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : []);
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const seat = (playerId, o = {}) => ({ playerId, name: playerId, ...o });
const room = (o = {}) => ({ mode: 'coop', source: 'private', hostId: 'h', experimental: rules(), seats: [seat('h'), null, null, null], aiPicksLast: false, ...o });
const opt = (on = false, editable = true) => ({ on, editable });
const CALLS = { onRevival() {}, onSharedPool() {}, onLayerCap() {}, onHitLimit() {}, onUniteHumans() {}, onConsole() {}, onAiLast() {}, onAiTakeover() {}, onBandDupes() {}, onCapacity() {}, onDuckLord() {}, onSoloUnlimited() {}, onDifficulty() {}, onClose() {} };
const dialog = (o = {}) => walk(RoomSettings({ page: 'alliance', room: room(), editable: true, busy: null, consoleOpt: opt(), ...CALLS, ...o }));
const ids = (nodes) => nodes.map((n) => n.props.id).filter(Boolean);
const testids = (nodes) => nodes.map((n) => n.props['data-testid']).filter(Boolean);

test('a co-op room has three pages, a solo room one; a press opens its page or the first', () => {
  assert.deepEqual(settingsPages(room()), ['alliance', 'rules', 'pools']);
  assert.deepEqual(settingsPages(room({ mode: 'solo' })), ['sim']);
  assert.equal(settingsPage(room(), 'rules'), 'rules');
  assert.equal(settingsPage(room(), 'nowhere'), 'alliance');
  assert.equal(settingsPage(room({ mode: 'solo' }), 'rules'), 'sim', '实验性选项 of a solo room');
  assert.equal(settingsPage(room({ mode: 'solo' }), 'alliance'), 'sim');
});

test('closed, there is nothing; open, the title says the room\'s kind', () => {
  assert.equal(RoomSettings({ page: null, room: room(), ...CALLS }), null);
  assert.equal(RoomSettings({ page: 'alliance', room: room(), ...CALLS }).props.title, '同盟设置');
  assert.equal(RoomSettings({ page: 'sim', room: room({ mode: 'solo' }), ...CALLS }).props.title, '模拟设置');
});

test('the alliance page holds the difficulty, the version, the seats and the AI seats', () => {
  const on = opt();
  const nodes = dialog({ page: 'alliance', aiLast: on, dupes: on, takeover: on,
    version: { label: 'V', editable: true, why: null, disabled: false, onOpen() {} },
    difficulty: { id: 'NORMAL', name: '标准', code: 'N', editable: true, disabled: false, onOpen() {} },
    room: room({ experimental: rules({ playerCapacity: 8 }), seats: new Array(8).fill(null) }) });
  assert.deepEqual(ids(nodes).filter((id) => !id.startsWith('rset')),
    ['experimental-multiplayer', 'experimental-capacity', 'room-ai-last', 'room-band-dupes', 'room-ai-takeover', 'experimental-ducklord']);
  assert.deepEqual(testids(nodes).filter((id) => id.startsWith('room-opt')), ['room-opt-difficulty', 'room-opt-version']);
  assert.equal(ids(nodes).includes('experimental-ducklord'), true, '禁用鸭爵策略 of an expanded room');
  // a four-seat room has no capacity picker and no duck-lord row
  const small = dialog({ page: 'alliance', aiLast: opt(), dupes: opt(), takeover: opt() });
  assert.deepEqual(ids(small).filter((id) => !id.startsWith('rset')),
    ['experimental-multiplayer', 'room-ai-last', 'room-band-dupes', 'room-ai-takeover'], 'the switch stays to turn expansion on');
  assert.equal(ids(small).includes('experimental-ducklord'), false);
  assert.equal(testids(small).includes('room-opt-difficulty'), false, 'no version/difficulty row passed, no row');
});

test('the rules page holds the battle switches; a room the queue allocated keeps only the console', () => {
  const nodes = dialog({ page: 'rules', consoleOpt: opt() });
  assert.deepEqual(ids(nodes).filter((id) => !id.startsWith('rset')),
    ['experimental-revival', 'experimental-layer-cap', 'experimental-hit-limit', 'experimental-unite-humans', 'experimental-console']);
  // 联动干员 does not exist here, and the console is no 调控台
  assert.equal(ids(nodes).includes('experimental-collab'), false);
  // the queue's room: the battle rules froze (screens/room.js layerCapOption's rule), the console row stays
  const queued = dialog({ page: 'rules', consoleOpt: opt(), room: room({ source: 'matchmaking' }) });
  assert.deepEqual(ids(queued).filter((id) => !id.startsWith('rset')), ['experimental-console']);
});

test('the pools page holds 禁用共享卡池, its note only while the pools are shared', () => {
  const off = dialog({ page: 'pools' });
  assert.deepEqual(ids(off).filter((id) => !id.startsWith('rset')), ['experimental-pool']);
  assert.equal(off.some((n) => n.props.class === 'rset__empty'), true, '未开启时按开局人数自动分组。');
  const onRoom = dialog({ page: 'pools', room: room({ experimental: rules({ disableSharedPool: true }) }) });
  assert.equal(onRoom.some((n) => n.props.class === 'rset__empty'), false, 'no auto-grouping note while the pools are separate');
});

test('a solo room has its single page: 不限时 when timed, the battle rules and the console, no tabs', () => {
  const timed = dialog({ page: 'sim', soloOption: opt(), room: room({ mode: 'solo' }) });
  assert.deepEqual(ids(timed).filter((id) => !id.startsWith('rset')),
    ['room-solo-unlimited', 'experimental-layer-cap', 'experimental-hit-limit', 'experimental-console']);
  assert.equal(ids(timed).includes('experimental-revival'), false, 'no teammate to rescue');
  assert.equal(ids(timed).includes('experimental-unite-humans'), false, 'no 联防 in a solo run');
  assert.equal(timed.some((n) => n.props.role === 'tablist'), false, 'one page, no tabs');
  // an untimed version's solo keeps the difficulty and version rows (the ⚙'s second entry to the pill's flows)
  const untimed = dialog({ page: 'sim', room: room({ mode: 'solo' }),
    version: { label: 'V', editable: true, why: null, disabled: false, onOpen() {} },
    difficulty: { id: 'NORMAL', name: '标准', code: 'N', editable: true, disabled: false, onOpen() {} } });
  assert.deepEqual(testids(untimed).filter((id) => id.startsWith('room-opt')), ['room-opt-difficulty', 'room-opt-version']);
  assert.equal(ids(untimed).includes('room-solo-unlimited'), false);
});

test('a guest reads every page: nothing to switch', () => {
  const on = opt(true, false);
  const nodes = dialog({ editable: false, aiLast: on, dupes: on, takeover: on, consoleOpt: on,
    room: room({ experimental: rules({ playerCapacity: 8 }), seats: new Array(8).fill(null) }) });
  for (const input of nodes.filter((n) => n.type === 'input' || n.type === 'select')) assert.equal(input.props.disabled, true, input.props.id);
  const sent = [];
  const last = dialog({ editable: false, aiLast: on, onAiLast: (v) => sent.push(v) }).find((n) => n.props.id === 'room-ai-last');
  last.props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent, []);
});

test("while a request runs the host's switches wait", () => {
  for (const input of dialog({ busy: 'experimental', aiLast: opt(), consoleOpt: opt() }).filter((n) => n.type === 'input')) {
    assert.equal(input.props.disabled, true, input.props.id);
  }
});

test('the capacity rows answer with the seat count, and only a host may send one', () => {
  const sent = [];
  const rows = (value, editable) => walk(capacityRows({ value, editable, onCapacity: (n) => sent.push(n) }));
  rows(rules({ playerCapacity: 8 }), true).find((n) => n.props.id === 'experimental-multiplayer').props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent, [MAX_SEATS]);
  rows(rules({ playerCapacity: 8 }), true).find((n) => n.props.id === 'experimental-capacity').props.onChange({ currentTarget: { value: '12' } });
  assert.deepEqual(sent.at(-1), 12);
  rows(rules(), true).find((n) => n.props.id === 'experimental-multiplayer').props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(sent.at(-1), 8);
  rows(rules({ playerCapacity: 8 }), false).find((n) => n.props.id === 'experimental-capacity').props.onChange({ currentTarget: { value: '12' } });
  assert.equal(sent.length, 3, 'a guest sends nothing');
  assert.deepEqual(walk(capacityRows({ value: rules(), editable: true, onCapacity: () => {} })).filter((n) => n.props.id === 'experimental-capacity'), [],
    'no seat picker while the room sits at four');
});

test('禁用鸭爵策略 shows in an expanded room only and answers with the next state', () => {
  assert.equal(duckLordRow({ value: rules(), editable: true, onDuckLord: () => {} }), null, 'four seats: no row');
  const sent = [];
  const row = () => walk(duckLordRow({ value: rules({ playerCapacity: 8, disableDuckLord: true }), editable: true, onDuckLord: (on) => sent.push(on) }))
    .find((n) => n.props.id === 'experimental-ducklord');
  assert.equal(row().props.checked, true);
  row().props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent, [false]);
  const guest = walk(duckLordRow({ value: rules({ playerCapacity: 8 }), editable: false, onDuckLord: (on) => sent.push(on) }))
    .find((n) => n.props.id === 'experimental-ducklord');
  guest.props.onChange({ currentTarget: { checked: true } });
  assert.equal(sent.length, 1, 'a guest sends nothing');
  assert.equal(guest.props.disabled, true);
});

test('the rule and pool rows answer with the next state of their key', () => {
  const sent = [];
  const revival = walk(ruleRows({ value: rules(), editable: true, onRevival: (on) => sent.push(['revival', on]) }))
    .find((n) => n.props.id === 'experimental-revival');
  revival.props.onChange({ currentTarget: { checked: true } });
  const pool = walk(poolRows({ value: rules(), editable: true, onSharedPool: (on) => sent.push(['pool', on]) }))
    .find((n) => n.props.id === 'experimental-pool');
  assert.equal(pool.props.checked, false, 'the shared pool is the default');
  pool.props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(sent, [['revival', true], ['pool', true]]);
  const locked = walk(poolRows({ value: rules(), editable: false, onSharedPool: (on) => sent.push(['pool', on]) }))
    .find((n) => n.props.id === 'experimental-pool');
  locked.props.onChange({ currentTarget: { checked: true } });
  assert.equal(sent.length, 2, 'a locked row sends nothing');
});

test('switchRow is a labelled switch row: title, note, the input carrying the state', () => {
  const row = walk(switchRow({ id: 'x', title: 'T', note: 'N', checked: true, disabled: false, onChange: () => {}, testid: 'tid' }))[0];
  assert.equal(row.type, 'label');
  assert.equal(row.props.htmlFor ?? row.props.for, 'x');
  const input = walk(row).find((n) => n.type === 'input');
  assert.equal(input.props.role, 'switch');
  assert.equal(input.props.checked, true);
  assert.equal(input.props['data-testid'], 'tid');
});

test('a tab\'s dot says that page differs from a new room', () => {
  assert.deepEqual(changedPages(room()), { alliance: false, rules: false, pools: false });
  assert.deepEqual(changedPages(room({ experimental: rules({ playerCapacity: 8 }) })).alliance, true);
  assert.equal(changedPages(room({ experimental: rules({ playerCapacity: 8, disableDuckLord: true }) })).alliance, true);
  assert.equal(changedPages(room({ aiPicksLast: true })).alliance, true, 'off in a new room');
  assert.equal(changedPages(room({ bandDupes: true })).alliance, true);
  assert.equal(changedPages(room({ aiTakeoverEnabled: true })).alliance, true);
  assert.deepEqual(changedPages(room({ experimental: rules({ revivalEnabled: true }) })), { alliance: false, rules: true, pools: false });
  assert.deepEqual(changedPages(room({ experimental: rules({ disableSharedPool: true }) })), { alliance: false, rules: false, pools: true });
  assert.equal(changedPages(room({ consoleEnabled: true })).rules, true, 'the console is a room field, not an experimental key');
  assert.equal(changedPages(room({ consoleEnabled: true })).alliance, false);
});

test('the page options read the room\'s payload through the shared normalization, forgiving to a legacy one', () => {
  assert.deepEqual(roomExperimental(rules({ playerCapacity: 8 })), experimentalOptions(rules({ playerCapacity: 8 })));
  assert.deepEqual(roomExperimental(undefined), rules());
  assert.deepEqual(roomExperimental('junk'), rules());
  assert.deepEqual(roomExperimental(rules({ disableLayerCap: true })), rules({ disableLayerCap: true }));
  assert.deepEqual(roomExperimental(rules({ disableDuckLord: true })), rules(), 'a four-seat room cannot carry the duck-lord ban');
});

test('the old ⚙ popover is gone from the screen and its css; the css stays within the renderers\' dialect', () => {
  const roomJs = read('public/js/screens/room.js');
  assert.doesNotMatch(roomJs, /RoomOptions|rs-opts/);
  const css = read('public/css/screens/room.css');
  assert.doesNotMatch(css, /\.rs-opts|\.rs-opt\b|\.ailast|\.rs-capacity\b/);
  assert.doesNotMatch(css, /:has\(|@container|@layer/, 'ESR 115 and older Safari');
  assert.match(css, /\.room-settings-modal/);
  assert.match(css, /\.experimental-option/);
});
