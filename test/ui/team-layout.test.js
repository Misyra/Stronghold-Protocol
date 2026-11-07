// The team panel's layout model (ui/teamLayout.js), the chess-pool groups of an expanded room and the emote danmaku's
// scheduler (ui/danmaku.js) — 移植自 Stardust fork 的 test/ui/team-layout.test.js / team-roster.test.js，按本仓路径适配.
// Geometry is checked in the browser (SP_E2E=1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHONE_QUERY, rosterPools, rosterStartsOpen, teamDensity, teamEmoteMode, teamPanelLayout } from '../../public/js/ui/teamLayout.js';
import { DANMAKU_MERGE_MS, DANMAKU_QUEUE, danmakuIngest, danmakuLanes, danmakuModel, danmakuPump, danmakuSpeed, danmakuWake } from '../../public/js/ui/danmaku.js';

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const seats = (n) => Array.from({ length: n }, (_, seat) => ({ playerId: `p${seat + 1}`, seat, name: `P${seat + 1}` }));

test('classic column on a desktop with at most four seats, a folded list on phones and in bigger rooms', () => {
  assert.equal(teamDensity({ count: 4, phone: false }), 'classic');
  assert.equal(teamDensity({ count: 1, phone: false }), 'classic');
  assert.equal(teamDensity({ count: 5, phone: false }), 'list');
  assert.equal(teamDensity({ count: 2, phone: true }), 'list');
  assert.equal(rosterStartsOpen('classic'), true);
  assert.equal(rosterStartsOpen('list'), false);
  // the official bubbles beside open classic rows; everything else (folded, lists) flies as danmaku
  assert.equal(teamEmoteMode({ density: 'classic', open: true }), 'bubble');
  assert.equal(teamEmoteMode({ density: 'classic', open: false }), 'danmaku');
  assert.equal(teamEmoteMode({ density: 'list', open: true }), 'danmaku');
  // the CSS phone block uses the same query as the JS
  assert.ok(source('../../public/css/screens/team.css').includes(`@media ${PHONE_QUERY} {`));
});

test('an expanded room lists its chess pools with their holders in seat order; one pool or independent pools say nothing', () => {
  const players = seats(10);
  const pub = { poolGroups: [{ id: 1, playerIds: ['p1', 'p2', 'p3', 'p4'], scale: 1 }, { id: 2, playerIds: ['p8', 'p5', 'p6', 'p7'], scale: 1 },
    { id: 3, playerIds: ['p9', 'p10'], scale: 1 }] };
  const pools = rosterPools(pub, players, 'p6');
  assert.deepEqual(pools.map((g) => [g.id, g.mine, g.players.map((p) => p.playerId)]),
    [[1, false, ['p1', 'p2', 'p3', 'p4']], [2, true, ['p5', 'p6', 'p7', 'p8']], [3, false, ['p9', 'p10']]]);
  assert.equal(rosterPools({ poolGroups: [{ id: 1, playerIds: players.map((p) => p.playerId), scale: 1.5 }] }, players), null, 'one enlarged pool');
  assert.equal(rosterPools({ poolGroups: players.map((p, i) => ({ id: i + 1, playerIds: [p.playerId] })) }, players), null, '共享卡池 off');
  assert.equal(rosterPools({}, players), null);
  assert.equal(rosterPools(null, players), null);
  // a seat no group lists still shows (under 其他), a listed id that is not a seat is skipped
  const odd = rosterPools({ poolGroups: [{ id: 1, playerIds: ['p1', 'ghost'] }, { id: 2, playerIds: ['p2', 'p3'] }] }, seats(4), 'p4');
  assert.deepEqual(odd.map((g) => [g.id, g.mine, g.players.map((p) => p.playerId)]), [[1, false, ['p1']], [2, false, ['p2', 'p3']], [null, true, ['p4']]]);
});

test('the panel groups list rows by pool and keeps the classic column without a header or fold', () => {
  const panel = source('../../public/js/ui/teamPanel.js');
  assert.match(panel, /pools\.map\(\(pool\) => html`<section key=\$\{pool\.id \?\? 'rest'\} class=\$\{cx\('team__pool'/);
  assert.match(panel, /t\('卡池 \{n\}', \{ n: pool\.id \}\)/);
  assert.match(panel, /t\('你的卡池'\)/);
  // the classic aside keeps its exact markup (no toggle header of its own); the list carries the fold button
  assert.match(panel, /if \(!list\) \{\s*\n\s*return html`<aside class=\$\{cx\('team', compact && 'team--compact'\)\} aria-label=\$\{t\('同盟成员'\)\}>/);
  assert.match(panel, /team__toggle/);
  // the danmaku rides the roster's own emote mode, not the game screen
  assert.match(panel, /emoteMode === 'danmaku' \? html`<\$\{Danmaku\}/);
});

for (const count of [4, 5, 6, 8, 12, 16, 20]) {
  for (const [height, root] of [[630, 100], [560, 75], [420, 66], [250, 40], [220, 40]]) {
    test(`${count} teammates stay readable at ${height}px with every seat reachable`, () => {
      const layout = teamPanelLayout(count, height, root, 480);
      assert.ok(layout.columns >= 1 && layout.columns <= 2);
      assert.equal(layout.rows, Math.ceil(count / layout.columns));
      assert.ok(layout.avatar <= layout.rowHeight);
      assert.ok(layout.avatar >= 36);
      assert.ok(layout.rowHeight >= 48, 'short screens scroll rather than shrinking interaction rows');
      assert.ok(layout.rows * layout.columns >= count, 'the final seat has a layout slot');
    });
  }
}

test('wide rosters use two columns, narrow and touch rosters preserve one readable scrolling column', () => {
  assert.equal(teamPanelLayout(20, 630, 100, 480).columns, 2);
  const short = teamPanelLayout(20, 220, 40, 480);
  assert.equal(short.columns, 2); assert.equal(short.rows, 10);
  assert.ok(short.rows * short.rowHeight > 220, 'overflow is intentionally confined to the roster');
  const touch = teamPanelLayout(20, 220, 40, 340, true);
  assert.equal(touch.columns, 1); assert.equal(touch.rows, 20);
  assert.equal(teamPanelLayout(20, 630, 100, 280).columns, 1);
  assert.equal(teamPanelLayout(5, 630, 100, 480).columns, 1);
});

const opts = { lanes: 2, dur: 6000, spacing: 1000 };
const emote = (seq, playerId, id, at) => ({ seq, playerId, id, at });

test('danmaku: an emote takes a free lane at once; the same emote within the merge window joins it (×N)', () => {
  const m = danmakuModel();
  danmakuIngest(m, [emote(1, 'a', 'hi', 1000)], 1000);
  danmakuPump(m, 1000, opts);
  assert.deepEqual(m.items.map((x) => [x.id, x.lane, x.pids]), [['hi', 0, ['a']]]);
  danmakuIngest(m, [emote(1, 'a', 'hi', 1000), emote(2, 'b', 'hi', 1000 + DANMAKU_MERGE_MS - 1), emote(3, 'b', 'hi', 1000 + DANMAKU_MERGE_MS - 1)], 1000 + DANMAKU_MERGE_MS - 1);
  assert.deepEqual(m.items[0].pids, ['a', 'b'], 'merged once per sender; the first emote is not taken twice');
  danmakuIngest(m, [emote(4, 'c', 'hi', 1000 + DANMAKU_MERGE_MS)], 1000 + DANMAKU_MERGE_MS);
  assert.equal(m.queue.length, 1, 'after the window a new item');
  danmakuPump(m, 1000 + DANMAKU_MERGE_MS, opts);
  assert.deepEqual(m.items.map((x) => x.lane), [0, 1]);
  assert.equal(danmakuWake(m), 1000 + 6000, 'idle until the first item ends');
  danmakuPump(m, 7000, opts);
  assert.equal(m.items.length, 1);
});

test('danmaku: a lane waits its spacing, the queue keeps the newest teammates and always the own emote; old emotes do not replay', () => {
  const m = danmakuModel();
  const burst = Array.from({ length: 12 }, (_, i) => emote(i + 1, `p${i}`, `e${i}`, 5000));
  danmakuIngest(m, [...burst, emote(13, 'me', 'mine', 5000)], 5000, { myId: 'me' });
  assert.equal(m.queue.length, DANMAKU_QUEUE);
  assert.equal(m.queue[0].id, 'mine', 'the own emote first');
  assert.deepEqual(m.queue.slice(1).map((x) => x.id), ['e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11'], 'the oldest teammates dropped');
  danmakuPump(m, 5000, opts);
  assert.deepEqual(m.items.map((x) => x.id), ['mine', 'e5']);
  assert.deepEqual(m.items.map((x) => x.lane), [0, 1]);
  assert.equal(m.queue.length, 6, 'the rest wait');
  // an emote older than the bubble time does not replay (the band mounted late)
  const late = danmakuModel();
  danmakuIngest(late, [emote(1, 'a', 'old', 5000)], 5000 + 10_000);
  assert.equal(late.queue.length + late.items.length, 0);
  assert.equal(late.seq, 1, 'but it is not offered again');
});

test('danmaku: two lanes on a short screen, three otherwise; the speed stays within its band', () => {
  assert.equal(danmakuLanes(400), 2);
  assert.equal(danmakuLanes(900), 3);
  assert.ok(danmakuSpeed(800) >= 140 && danmakuSpeed(800) <= 260);
  assert.equal(danmakuSpeed(2000), 260, 'wide screens cap at the top speed');
});
