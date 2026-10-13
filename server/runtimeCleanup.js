/** Release a partially or fully built runtime without writing another state document. */
export async function cleanupRuntime({ lobby, network, persister, chatLog, workerPool, ownsWorkerPool,
  server, wss, roomAdmin, store, log }) {
  const errors = [];
  const attempt = async (label, job) => {
    try { await job(); }
    catch (error) { errors.push(error); log.error(`[shutdown] ${label}`, error); }
  };
  await attempt('persistence timers', () => persister?.stop());
  await attempt('lobby', () => lobby?.shutdown('shutdown'));
  await attempt('network', () => network?.close());
  await attempt('persistence worker', () => persister?.dispose());
  await attempt('chat log', () => chatLog?.close());
  if (ownsWorkerPool) await attempt('workers', () => workerPool?.close());
  await attempt('room admin', () => roomAdmin?.close());
  await attempt('http', () => {
    if (!server?.listening) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => server.closeAllConnections?.(), 500);
      timer.unref();
      server.close((error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      server.closeIdleConnections?.();
    });
  });
  await attempt('websocket', () => wss?.close());
  await attempt('state store', () => store?.close());
  return errors;
}
