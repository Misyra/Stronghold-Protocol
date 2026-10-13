import { getData } from '../../server/data.js';
import { utf8, sha256Hex } from '../../shared/sha256.js';
export const scriptPlugin = source => {
  const bytes = utf8(source);
  return { id: 'sandbox-probe', class: 'script', entry: 'main.js', files: { 'main.js': { bytes: [...bytes], sha256: sha256Hex(bytes) } } };
};
export const fixtureSet = () => ({ cs: 'a'.repeat(64), data: getData(), bounds: { v: 1, bb: { times: 12 }, fields: {}, bbMin: {}, fieldMin: {}, text: {} } });
export const fixtureSpec = () => ({ v: 1, kind: 'normal', fieldId: 'n:p1', battleId: 'probe', seed: 73,
  stageId: 'act1autochess_m01', rect: { r0: 9, r1: 12, c0: 0, c1: 10 }, timeLimit: 8,
  players: [{ playerId: 'p1', units: [{ uid: 1, chessId: 'chess_char_1_01_a', row: 10, col: 4 }], bonds: {} }],
  routes: [{ start: [10, 6], end: [10, 0], motion: 'WALK' }], spawns: [{ time: 0, enemyKey: 'enemy_1001_bigbo', count: 3, routeIndex: 0 }] });
export const operatorScript = "export default function setup(sp) { sp.registerKit('chess_char_1_01_a', () => ({ skill: { kind: 'passive', mods: { atkPct: Math.sin(0.7) } } })); }";
