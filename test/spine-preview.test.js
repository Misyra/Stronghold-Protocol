// test/spine-preview.test.js — 干员小人预览 (docs/SKINS.md): the preview frame of the picker is drawn by
// render/spinePreview.js — a static snapshot first, then live playback on the same Spine + PIXI path the battlefield
// uses — and the animation buttons under it come from `clipsOf()`, i.e. from what each model actually ships.
//
// There is no WebGL (nor a `document`) in Node, so what is pinned here is the half that must hold headless: the
// snapshot cache bookkeeping, the dedup of repeated requests, the subscription, the clip list itself — and the one
// that actually matters for the picker, that a render which cannot run ends as `failed` instead of throwing, because
// `failed` is what makes the frame keep the operator's avatar. The rasterisation and the live loop are covered by
// test/ui/skins.e2e.test.js (which needs SP_E2E=1 + Chrome).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_PX, previewKey, previewState, requestPreview, subscribePreviews, clearPreviews, clipsOf } from '../public/js/render/spinePreview.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAR = 'char_498_inside';
const SKIN = 'char_498_inside@kitchen#2';

/** The real manifest — `clipsOf` is pure data, so the buttons can be pinned against what this install has. */
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));

/** Let the queue drain (each job rejects at once headlessly: no PIXI, no document). */
async function settle(ms = 60) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => clearPreviews());

describe('spinePreview: keys and state', () => {
  test('the key separates the operator\'s own model from each skin\'s', () => {
    assert.equal(previewKey(CHAR), `${CHAR}|`);
    assert.equal(previewKey(CHAR, SKIN), `${CHAR}|${SKIN}`);
    assert.notEqual(previewKey(CHAR, SKIN), previewKey(CHAR, 'char_498_inside@summer#22'));
    assert.notEqual(previewKey(CHAR, ''), previewKey(CHAR, SKIN));
  });

  test('nothing is known before it is asked for, and a request does not block the render pass', () => {
    assert.deepEqual(previewState(CHAR, SKIN), { status: 'idle', url: null });
    requestPreview(CHAR, SKIN);
    assert.equal(previewState(CHAR, SKIN).status, 'loading', 'the first read right after the request');
  });

  test('no operator id → no work at all', async () => {
    let calls = 0;
    const off = subscribePreviews(() => { calls++; });
    requestPreview('', SKIN);
    requestPreview(null, '');
    await settle();
    assert.equal(calls, 0);
    assert.equal(previewState('', SKIN).status, 'idle');
    off();
  });
});

describe('spinePreview: headless degradation', () => {
  test('a render that cannot run ends `failed` (the frame then shows the avatar) and never throws', async () => {
    requestPreview(CHAR, SKIN);
    await settle();
    assert.deepEqual(previewState(CHAR, SKIN), { status: 'failed', url: null });
  });

  test('a failed key is not retried by itself — only with { retry: true }', async () => {
    requestPreview(CHAR, SKIN);
    await settle();
    let calls = 0;
    const off = subscribePreviews(() => { calls++; });
    requestPreview(CHAR, SKIN);
    await settle();
    assert.equal(calls, 0, 'a plain re-request of a failed key does nothing (it would re-queue on every render)');
    requestPreview(CHAR, SKIN, { retry: true });
    assert.equal(previewState(CHAR, SKIN).status, 'loading');
    off();
  });
});

describe('spinePreview: subscription and cache', () => {
  test('subscribers hear about a landing, and unsubscribing stops it', async () => {
    let calls = 0;
    const off = subscribePreviews(() => { calls++; });
    requestPreview(CHAR, SKIN);
    await settle();
    assert.ok(calls >= 1, 'a landing notifies');
    off();
    const seen = calls;
    requestPreview(CHAR, 'char_498_inside@summer#22');
    await settle();
    assert.equal(calls, seen, 'after unsubscribe nothing is delivered');
  });

  test('a second request for a key that is loading or done is ignored (the frame re-renders constantly)', async () => {
    let calls = 0;
    const off = subscribePreviews(() => { calls++; });
    requestPreview(CHAR, SKIN);
    requestPreview(CHAR, SKIN);
    requestPreview(CHAR, SKIN);
    await settle();
    // one notify when the work is queued (the frame switches to "loading") + one when it lands — not one per request
    assert.equal(calls, 2, 'three requests while loading → a single job');
    requestPreview(CHAR, SKIN);
    await settle();
    assert.equal(calls, 2, 'and nothing for a request after the landing');
    off();
  });

  test('clearPreviews drops everything (a manifest reload may change the URLs)', () => {
    requestPreview(CHAR, SKIN);
    assert.equal(previewState(CHAR, SKIN).status, 'loading');
    clearPreviews();
    assert.deepEqual(previewState(CHAR, SKIN), { status: 'idle', url: null });
  });

  test('the snapshot is square and big enough to scale down', () => {
    assert.ok(PREVIEW_PX >= 128 && PREVIEW_PX <= 512, `${PREVIEW_PX}px`);
  });
});

describe('spinePreview: clipsOf — the animation buttons follow the model', () => {
  const ids = (r) => r.clips.map((c) => c.id);

  test('一个模型的按钮就是它实际有的动画，且待机排在最前、死亡不会循环回待机', () => {
    const r = clipsOf(MANIFEST, CHAR);
    assert.ok(ids(r).includes('idle'), ids(r).join(','));
    assert.ok(ids(r).includes('deploy'));
    assert.ok(ids(r).includes('attack'));
    assert.ok(ids(r).includes('die'));
    const idle = r.clips.find((c) => c.id === 'idle');
    assert.deepEqual(idle.steps, [['Idle', true]], '待机是单剪辑循环');
    const attack = r.clips.find((c) => c.id === 'attack');
    assert.ok(attack.steps.length >= 3, '攻击是 起手→循环→收尾 的序列');
    assert.equal(attack.steps.at(-1)[1], true, '打完回到待机（最后一个剪辑循环）');
    const die = r.clips.find((c) => c.id === 'die');
    assert.equal(die.steps.at(-1)[1], false, '死亡播完就停住，不回待机');
    assert.ok(r.total >= r.clips.length, 'total 数的是骨架里的全部剪辑（含姿势变体）');
    assert.ok(r.total > 10, `隐现本体剪辑不少，实际 ${r.total}`);
  });

  test('技能按钮来自骨架自己的剪辑，不是清单里预设的那几个', () => {
    // 锏's model ships Skill_1 / Skill_2 (one-clip skills) and a Skill_3_Begin/Loop/End trio, but the pool the
    // manifest was built from only fields her S3 — `skillIndicesByChar()` resolves exactly the skills a mode uses,
    // so the resolved `skills` map carried index 2 alone and the preview showed a single 技能 button.
    const degen = clipsOf(MANIFEST, 'char_4116_blkkgt');
    const skills = degen.clips.filter((c) => c.kind === 'skill');
    assert.equal(skills.length, 3, `锏的三个技能都该有按钮，实际 ${skills.map((c) => c.id).join(',')}`);
    assert.deepEqual(skills.map((c) => c.id), ['skill0', 'skill1', 'skill2']);
    assert.deepEqual(skills.map((c) => c.skillIndex), [0, 1, 2]);
    assert.deepEqual(skills[0].steps, [['Skill_1', false], ['Idle', true]], '单剪辑技能：放一次再回待机');
    assert.equal(skills[2].steps.length, 5, '三段式技能：Begin → Loop → Loop → End → 待机');
    for (const c of skills) assert.ok(c.names.length >= 1 && c.names.every((n) => typeof n === 'string' && n), c.id);
  });

  test('换皮肤后按钮跟着模型走；皮肤未安装时回退到本体', () => {
    const base = clipsOf(MANIFEST, CHAR);
    const skin = clipsOf(MANIFEST, CHAR, SKIN);
    const skills = (r) => r.clips.filter((c) => c.id.startsWith('skill')).map((c) => c.id);
    // data/assets.json decides: a checkout with no skins installed has no skin record at all, and then the lookup
    // falls back to the operator's own model (which is what the picker shows too) — both states end at the same
    // clip list, because the buttons follow the SKELETON's own clips either way
    assert.deepEqual(skills(skin), skills(base), MANIFEST.chars?.[CHAR]?.skins?.[SKIN] ? '同一模型 → 按钮一致' : '未安装 → 回退本体');
    assert.ok(skills(base).length >= 2, '隐现的模型有两套技能剪辑');
    assert.ok(ids(skin).includes('idle') && ids(skin).includes('attack'));
  });

  test('每个骨架剪辑都能被某个按钮点到（含没有角色指向的变体）', () => {
    // 锏 ships 13 clips: the seven semantic buttons cover nine of them (Start+Idle, the Skill_3 trio), and the rest —
    // Default, Skill_2_B, Skill_Down_2, Skill_Down_2_B — come back as `raw` entries labelled with their clip name.
    // The invariant is what matters: total clips === names reachable from the buttons.
    for (const [id, skin] of [['char_4116_blkkgt', 'char_4116_blkkgt@witch#5'], [CHAR, ''], ['char_1012_skadi2', 'char_1012_skadi2@boc#4']]) {
      const r = clipsOf(MANIFEST, id, skin);
      const src = MANIFEST.chars[id].skins?.[skin]?.spine?.front || MANIFEST.chars[id].spine.front;
      const all = Object.keys(src.animations || {});
      const covered = new Set(r.clips.flatMap((c) => c.names));
      const missing = all.filter((n) => !covered.has(n));
      assert.deepEqual(missing, [], `${id} ${skin || '(本体)'}: 未覆盖的剪辑`);
      assert.equal(r.total, all.length);
      const raw = r.clips.filter((c) => c.kind === 'raw');
      for (const c of raw) {
        assert.equal(c.names[0], c.clipName, 'raw 条目用剪辑名当标签');
        assert.deepEqual(c.steps, [[c.clipName, true]]);
      }
    }
    const degen = clipsOf(MANIFEST, 'char_4116_blkkgt', 'char_4116_blkkgt@witch#5');
    assert.equal(degen.total, 13);
    assert.equal(degen.clips.filter((c) => c.kind === 'raw').length, 4, '锏的四个变体剪辑各有一个按钮');
  });

  test('每个按钮都带底层剪辑名（按钮 title 用）', () => {
    for (const c of clipsOf(MANIFEST, CHAR).clips) {
      assert.ok(c.names.length >= 1, c.id);
      assert.ok(c.names.every((n) => typeof n === 'string' && n.length), c.id);
      assert.equal(c.names.length, c.steps.length);
    }
  });

  test('没有这个干员 / 没有 anims → 空列表，不抛', () => {
    assert.deepEqual(clipsOf(MANIFEST, 'char_nope'), { total: 0, clips: [] });
    assert.deepEqual(clipsOf(null, CHAR), { total: 0, clips: [] });
  });
});
