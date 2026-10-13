// Raw examples of the retired format, used only to seed compatibility tests. No sanitization here.
export function makeRecord(result, playerId, { now = 0, origin = '', appVersion = '' } = {}) {
  const snapshot = structuredClone(result);
  const matchId = snapshot.matchId || JSON.stringify([snapshot.seed, snapshot.modeId, snapshot.stageId,
    snapshot.durationMs, snapshot.players.map((p) => p.playerId).sort()]);
  return { schema: 1, id: JSON.stringify([origin, matchId, playerId]), playerId,
    recordedAt: now, endedAt: Number.isFinite(snapshot.finishedAt) ? snapshot.finishedAt : now,
    origin, appVersion, result: snapshot };
}
export const exportRecords = (records) => JSON.stringify({ format: 'stronghold-match-history', schema: 1, records });
