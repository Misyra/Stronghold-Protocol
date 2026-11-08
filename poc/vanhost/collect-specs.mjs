// poc/vanhost/collect-specs.mjs — PoC 采集器：驱动真实 Match（clientCombat，SimClient 代打真人席）跑多个回合，
// 抓下每个「服务器侧 headless 战斗」（bot 场 / 接管 / 联防无人类权威场——即生产里主线程 HeadlessJob 的全部来源）
// 的 BattleSpec，存 specimens.json 供 bench.mjs 做 worker vs 主线程对比。不接生产路径；跑完即弃。
//
// 用法：node poc/vanhost/collect-specs.mjs [--out poc/vanhost/specimens.json]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from '../../test/match/harness.js';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), 'specimens.json');

// 每个配置跑一局：coop、真人 1-2 席（SimClient 代打）、bot 1-3 席、三种难度、多 seed，跑到 R8 或终局。
const configs = [];
for (const difficulty of ['NORMAL', 'HARD', 'ABYSS']) {
  for (let seed = 9100; seed < 9100 + 4; seed++) {
    configs.push({ difficulty, seed, humans: 1, bots: 3 });
  }
}
configs.push({ difficulty: 'NORMAL', seed: 9201, humans: 2, bots: 2 });
configs.push({ difficulty: 'HARD', seed: 9202, humans: 2, bots: 2 });

const specimens = [];
let captured = 0;
for (const c of configs) {
  const h = makeMatch({ mode: 'coop', difficulty: c.difficulty, humans: c.humans, bots: c.bots, seed: c.seed, captureFrames: false, clientCombat: true });
  h.autoHumans();
  const m = h.m;
  const seen = new Set();
  let lastKey = '';
  m.start();
  h.run(() => {
    const key = `${m.phase}:${m.round}`;
    if (key !== lastKey) {
      lastKey = key;
      if (m.phase === PHASE.COMBAT || m.phase === PHASE.UNITE) {
        for (const f of m.fields) {
          if (!f.cc || f.mode !== 'server' || !f.spec || seen.has(f.spec.battleId)) continue;
          seen.add(f.spec.battleId);
          captured++;
          specimens.push({
            battleId: f.spec.battleId, fieldId: f.fieldId, kind: f.spec.kind, round: f.spec.round,
            difficulty: c.difficulty, seed: c.seed, modeId: f.spec.modeId,
            spec: JSON.parse(JSON.stringify(f.spec)), players: f.players.slice(),
          });
        }
      }
    }
    return h.ended != null || m.round >= 8;
  }, { maxSteps: 5e6 });
  const errors = m.errorCount;
  m.dispose();
  console.log(`[collect] ${c.difficulty} seed=${c.seed} humans=${c.humans} bots=${c.bots}: rounds=${m.round} errors=${errors} captured=${captured}`);
}
writeFileSync(out, JSON.stringify(specimens));
console.log(`[collect] wrote ${specimens.length} specimens -> ${out}`);
