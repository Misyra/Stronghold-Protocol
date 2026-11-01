// test/ui/achievement-groups.test.js — the panel's 成就 (public/js/ui/achievements.js): the seven ACHIEVEMENT_GROUPS, the
// ACHIEVEMENTS list derived from the account's own records (nothing stored twice) and the row markup (a bar, or 已达成).
// The list is the reference's; the counters behind it are this branch's: achievementStats already walks every counted
// record for the plate and the record sections, so the achievements ride on that same pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../../public/js/ui/stats.js';
import {
  ACHIEVEMENT_GROUPS, ACHIEVEMENTS, achievementsOf, achievementStats, AchievementMark,
} from '../../public/js/ui/achievements.js';

function rec(seed, o = {}) {
  return buildRecord({
    seed, victory: true, roundsPassed: 10, durationMs: 30 * 60 * 1000, difficulty: 'HARD', hiddenCleared: true,
    modeId: 'mode_multi_normal',
    players: [{
      playerId: 'self', alive: true, victory: true, bandId: 'band_a', title: { id: 'comment_1' }, trophies: 4,
      stats: { kills: 100, bossDamage: 5000, perfectRounds: 3, merges: 2 }, bonds: [],
    }],
  }, { myId: 'self', roomMode: 'coop', now: seed, ...o });
}

const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));

test('every achievement belongs to one of the seven groups, once', () => {
  const ids = new Set(ACHIEVEMENT_GROUPS.map(([id]) => id));
  assert.equal(ids.size, 7);
  for (const [id, label, icon] of ACHIEVEMENT_GROUPS) {
    assert.ok(id && label && icon, 'a group needs an id, a label and a glyph');
    assert.ok(ACHIEVEMENTS.some((a) => a.group === id), `group ${id} holds no achievement`);
  }
  const seen = new Set();
  for (const a of ACHIEVEMENTS) {
    assert.ok(!seen.has(a.id), `duplicate id ${a.id}`);
    seen.add(a.id);
    assert.ok(ids.has(a.group), `${a.id}: unknown group ${a.group}`);
    assert.ok(a.goal > 0, `${a.id}: a goal must be positive`);
    assert.ok(a.name && a.desc, `${a.id}: needs a name and a description`);
  }
});

test('achievementsOf clamps at the goal, marks it done and survives missing counters', () => {
  const list = achievementsOf({ games: 12, wins: 0, hours: 2.9, clears: { HARD: 1 }, trophies: 5, sums: { kills: 1e9 } });
  const a = byId(list);
  assert.equal(a.games_10.done, true);
  assert.equal(a.games_10.current, 10, 'current is clamped at the goal');
  assert.equal(a.games_10.frac, 1);
  assert.equal(a.games_50.done, false);
  assert.ok(Math.abs(a.games_50.frac - 12 / 50) < 1e-9);
  assert.equal(a.hours_10.current, 2, 'whole hours only');
  assert.equal(a.clear_HARD.done, true);
  assert.equal(a.clear_ABYSS.done, false);
  assert.equal(a.coop_10.current, 0, 'a counter the progress lacks reads 0');
  const empty = achievementsOf();
  assert.equal(empty.length, ACHIEVEMENTS.length);
  assert.ok(empty.every((x) => x.current === 0 && !x.done && x.frac === 0));
  assert.equal(achievementsOf({ games: -5, wins: Number.NaN }).every((x) => x.current === 0), true, 'negative / NaN read 0');
});

test('achievementStats counts the record set the achievements read — counted records only', () => {
  const quit = { ...rec(9), end: 'quit', players: [{ playerId: 'self', alive: true, victory: false, roundsPassed: 0, stats: {} }] };
  const s = achievementStats([rec(1), rec(2), quit]);
  assert.equal(s.games, 2, 'the given-up match never started and does not count');
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.hours - 1) < 1e-9, 'two half-hour records');
  assert.deepEqual(s.clears, { HARD: 2 });
  assert.equal(s.hidden, 2);
  assert.equal(s.hiddenAbyss, 0, 'neither was an ABYSS clear');
  assert.deepEqual(s.sums, { kills: 200, bossDamage: 10000, perfectRounds: 6, merges: 4 });
  assert.equal(s.bandKinds, 1);
  assert.equal(s.titleKinds, 1);
  assert.equal(s.trophies, 8);
  const a = byId(s.achievements);
  assert.equal(s.achievements.length, ACHIEVEMENTS.length);
  assert.equal(a.games_1.done, true);
  assert.equal(a.coop_wins_10.done, false);
  assert.equal(a.clear_HARD.done, true);
  assert.equal(a.kills_1000.done, false);
  assert.equal(a.trophy_10.current, 8);
});

test('an ABYSS clear of the hidden core fills its own achievement', () => {
  const s = achievementStats([rec(1, { roomMode: 'solo' })]);
  const solo = achievementStats([{ ...rec(3), difficulty: 'ABYSS', roomMode: 'solo' }]);
  assert.equal(s.hiddenAbyss, 0);
  assert.equal(solo.hiddenAbyss, 1);
  assert.equal(byId(solo.achievements).hidden_abyss.done, true);
  assert.equal(byId(solo.achievements).solo_wins_10.current, 1);
});

/** Collect the vnodes of a rendered element tree (Preact vnodes are plain objects: type + props). */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  const props = node.props || {};
  out.push({ type: node.type, props });
  const kids = Array.isArray(props.children) ? props.children.flat(Infinity) : [props.children];
  for (const k of kids) walk(k, out);
  return out;
}
const pick = (nodes, cls) => nodes.filter((n) => String(n.props.class || '').split(' ').includes(cls));

test('a row shows the bar with its numbers, or 已达成 once done', () => {
  const open = walk(AchievementMark({ a: { ...ACHIEVEMENTS[1], current: 3, done: false, frac: 0.3 }, icon: 'hourglass' }));
  const bar = pick(open, 'ach-mark__bar')[0];
  assert.equal(bar.props.role, 'progressbar');
  assert.equal(bar.props['aria-valuenow'], 3);
  assert.equal(bar.props['aria-valuemax'], ACHIEVEMENTS[1].goal);
  assert.equal(pick(open, 'ach-mark__got').length, 0);
  const fill = open.find((n) => n.type === 'i');
  assert.equal(fill.props.style, 'width:30.0%');
  const done = walk(AchievementMark({ a: { ...ACHIEVEMENTS[1], current: 10, done: true, frac: 1 }, icon: 'hourglass' }));
  assert.equal(pick(done, 'ach-mark__got').length, 1);
  assert.equal(pick(done, 'ach-mark__bar').length, 0, 'a finished row shows no bar');
  assert.equal(pick(done, 'is-done').length, 1);
  assert.equal(pick(done, 'ach-mark__badge').length, 1, 'the glyph carries its check');
});
