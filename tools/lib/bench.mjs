/** Nearest-rank percentiles. Copy the samples so callers keep their measurement order. */
export function distribution(samples) {
  const values = [...samples].sort((a, b) => a - b);
  const pct = (p) => values.length ? +values[Math.ceil(values.length * p) - 1].toFixed(2) : null;
  return { count: values.length, p50: pct(.5), p95: pct(.95), p99: pct(.99), max: values.length ? +values.at(-1).toFixed(2) : null };
}
