import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSensitiveNickname } from '../server/moderation/nickname.js';
import { loadLexicon } from '../server/moderation/lexicon.js';
import { ERR, ERR_TEXT } from '../shared/constants.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const blocked = ['傻逼博士', '傻·逼', '傻\u200b逼', '操 你 妈', '操你媽', '约＿炮', '裸聊',
  '傻 Ｂ', 'FUCK', 'ｆｕｃｋ', 'f.u.c.k', 'f\u200du\u2060c\ufeffk', 'fu\u0301ck', 'bitch42', 'NMSL', 'fuck doctor', '习·近平', '習\u200b近平', '法 輪 功', '香港獨立', '８９６４', 'XI JINPING'];
test('nickname policy catches common abuse and normalized evasions without blocking ordinary names', () => {
  for (const value of blocked) assert.equal(hasSensitiveNickname(value), true, JSON.stringify(value));
  for (const value of ['博士', '凯尔希', '阿米娅', 'SilverAsh', 'Assassin', 'Scunthorpe', 'Mashita', 'Bushido',
    '泡泡', '小草', '正常😀代号', '', null, undefined, 123])
    assert.equal(hasSensitiveNickname(value), false, JSON.stringify(value));
});

test('ordinary family names, food, game vocabulary and abbreviations do not cause nickname false positives', () => {
  const ordinary = ['哥哥', '圣葬哥哥的小娇妻', '龙哥哥的小批', '冯宝宝', '冰冻爷爷', '克洛丝老婆贴贴',
    '普瑞赛斯的妻子', '拉普兰德小姐的狗', '苹果派', '青苹果（网络延迟版）', '土豆片', '塔卫二的太阳',
    '初音未来', '第一次玩卫戍', 'M3世界第一可爱', 'AAA专业谢拉格', 'AAA不融冰批发', '审判时间',
    '服务器别断了', '无人和悲歌', '逗比', '逗比寒MillerRHa', '南京大学', '咖啡因', '三点水', '10086', '24', '250', 'game', 'ice', 'please', 'QQ', 'kg'];
  for (const name of ordinary) assert.equal(hasSensitiveNickname(name), false, name);
  // Removing a neutral term does not whitelist the entire surrounding nickname.
  for (const name of ['哥哥', '苹果', '第一', '逗比']) assert.equal(hasSensitiveNickname(name + blocked[0]), true, name);
});

test('merged dictionary indexes every effective term and keeps ordinary words and unrelated numbers allowed', () => {
  const words = loadLexicon().toString('utf8')
    .split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  assert.equal(new Set(words).size, words.length, 'deduplicated before startup');
  assert.deepEqual(words, [...words].sort(), 'stable ordering for review');
  for (const word of words) {
    assert.equal(hasSensitiveNickname(word), true, word);
    assert.equal(hasSensitiveNickname([...word].join('·')), true, word + ' with separators');
  }
  for (const name of ['中国博士', '香港玩家', '台湾博士', '自由之翼', '独立模拟', '獨立模擬', '民主', '主席', '包子', '小熊维尼',
    '博士1989', '博士64', '博士189640', '博士198906040', '博士89640', 'CCPlayer'])
    assert.equal(hasSensitiveNickname(name), false, name);
  for (const name of ['博士8964', '８９６４博士', '1989-06-04', 'X I J I N P I N G', '天安門屠殺'])
    assert.equal(hasSensitiveNickname(name), true, name);
});

test('real hello rejects names before session creation; a valid retry succeeds on the same socket', async t => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const client = await TestClient.connect(server.url.replace('http:', 'ws:') + '/ws');
  t.after(async () => { await client.close(); await server.close(); });
  for (const name of blocked) {
    if (name.length > 12) continue;
    const reply = await client.request({ t: 'hello', name });
    assert.equal(reply.code, ERR.NICKNAME_SENSITIVE, name);
    assert.equal(reply.msg, ERR_TEXT.NICKNAME_SENSITIVE);
    assert.equal(reply.detail, undefined, 'do not echo the rejected word');
    assert.equal(server.registry.size, 0);
  }
  const good = await client.hello('正常博士');
  assert.equal(good.name, '正常博士'); assert.equal(server.registry.size, 1);
  const rename = await client.request({ t: 'hello', name: '傻逼' });
  assert.equal(rename.code, ERR.NICKNAME_SENSITIVE);
  assert.equal(server.registry.byToken(good.token).name, '正常博士', 'rejected repeat hello does not rename the session');
  assert.equal((await client.hello('换个代号')).name, '换个代号');
});

test('a rejected token-based hello cannot take over or rename a live session', async t => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = server.url.replace('http:', 'ws:') + '/ws';
  const owner = await TestClient.connect(url), other = await TestClient.connect(url);
  t.after(async () => { await other.close(); await owner.close(); await server.close(); });
  const good = await owner.hello('原博士');
  const rejected = await other.request({ t: 'hello', name: '傻逼', token: good.token });
  assert.equal(rejected.code, ERR.NICKNAME_SENSITIVE);
  assert.equal(owner.isOpen, true);
  assert.equal(server.registry.byToken(good.token).name, '原博士');
  assert.equal(server.registry.size, 1);
  assert.equal((await owner.request({ t: 'ping', c: 1 })).t, 'pong');
  const restored = await other.hello('新博士', good.token);
  assert.equal(restored.resumed, true); assert.equal(restored.playerId, good.playerId);
});
