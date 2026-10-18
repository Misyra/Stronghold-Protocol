// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）：本机的微基准，不测线上容量。
// Serialization-only benchmark: repeat a real four-seat R4 state; FakeBattle only advances the fixture quickly.
// No browser, Redis traffic, or concurrent battle CPU is included.
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { makeMatch } from '../test/match/harness.js';
import { canSnapshot, snapshotMatch } from '../server/match/snapshot.js';
import { Persister } from '../server/persist.js';

const h = makeMatch({ humans: 1, bots: 3, seed: 42, fake: true, captureFrames: false });
h.start();
if (!h.drive(() => h.m.round === 4 && h.m.phase === 'PREP' && canSnapshot(h.m), { maxSteps: 1e6 })) {
  throw new Error('could not reach benchmark prep');
}
const fixtureBytes = Buffer.byteLength(JSON.stringify(snapshotMatch(h.m)));
for (const count of [1, 50, 250]) {
  const items = Array.from({ length: count }, (_, i) => ({ key: `queue:M${i}`, match: h.m }));
  let baselineMs = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const matches = Object.fromEntries(items.map(({ key, match }) => [key, snapshotMatch(match)]));
    JSON.stringify({ matches });
    baselineMs += performance.now() - start;
    await nextTurn();
  }
  let bytes = 0;
  // 本仓库的 Persister 只会给「房间里正在跑的对局」拍检查点（flush → checkpointMatches → lobby.rooms），
  // 所以基准也把它们摆成真实房间的形状；否则测到的只是元数据文档（几十字节），不是 250 份快照。
  const rooms = new Map(items.map(({ key, match }) => [key, {
    code: key, roomId: key, createdAt: 1, mode: 'solo', difficulty: 'NORMAL', aiPicksLast: false,
    hostId: null, ownerKey: null, matchKey: null, matchCount: 1, seats: [], spectators: [], lastSummary: null, replay: null,
    match, disposed: false,
  }]));
  const persister = new Persister({ registry: { all: () => [] },
    lobby: { rooms, persistenceMatches: () => items },
    // 本仓库的 Persister 写的是「文档 / 分片」（store.save / store.saveSharded），不是上游的 saveSerialized(Buffer)：
    // 按本分支的 store 契约来测，否则 flush 会失败、测不到任何东西。
    store: { async save(doc) { bytes = Buffer.byteLength(JSON.stringify(doc)); return true; } },
  });
  let heartbeat;
  try {
    await persister.flush('warmup');
    let mainMs = 0, copyMaxMs = 0;
    const request = persister.encoder.request.bind(persister.encoder);
    persister.encoder.request = (...args) => {
      const start = performance.now();
      const result = request(...args);
      const duration = performance.now() - start;
      mainMs += duration;
      copyMaxMs = Math.max(copyMaxMs, duration);
      return result;
    };
    let longestGap = 0, previous = performance.now();
    heartbeat = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - previous);
      previous = now;
    }, 1);
    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      if (!await persister.flush('bench')) throw new Error('benchmark save failed');
      await nextTurn();
    }
    clearInterval(heartbeat);
    console.log(JSON.stringify({ matches: count, fixtureBytes, documentBytes: bytes,
      synchronousBaselineMs: +(baselineMs / 5).toFixed(2),
      averageSaveMs: +((performance.now() - start) / 5).toFixed(2),
      averageMainPostMs: +(mainMs / 5).toFixed(2), largestPostMs: +copyMaxMs.toFixed(2),
      largestHeartbeatGapMs: +longestGap.toFixed(2) }));
  } finally { clearInterval(heartbeat); await persister.encoder.close(); }
}
h.m.dispose();
