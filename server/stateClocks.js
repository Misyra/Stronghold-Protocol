// The same clock envelope travels through the Worker, both storage layouts and recovery. (移植自用户分支)
export function splitClocks(checkpoint) {
  const { deadlineRemainingMs, startedAtAgoMs, ...body } = checkpoint;
  return { body, clocks: { deadlineRemainingMs, startedAtAgoMs } };
}

export function mergeClocks(checkpoint, clocks) {
  if (!clocks) return checkpoint;
  const result = { ...checkpoint };
  for (const key of ['deadlineRemainingMs', 'startedAtAgoMs']) {
    if (Number.isFinite(clocks[key])) result[key] = clocks[key];
  }
  return result;
}
