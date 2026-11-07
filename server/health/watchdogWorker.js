// server/health/watchdogWorker.js — 看门狗的 Worker 入口（server/health/watchdog.js 的运行时壳）：真实定时器、
// 真实 fd 1 与真实 SIGKILL。fd 1 直写是有意的：卡死的主线程转发不了 Worker 的 console，必须 Worker 直写，
// journalctl / NSSM / Docker 的日志都按行原样捕获。
import { workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import { runWatchLoop } from './watchdog.js';

const { shared, thresholdMs, checkMs, role, captureMs, root } = workerData;
runWatchLoop({
  counter: new Int32Array(shared), thresholdMs, checkMs, role, captureMs, root,
  write: (line) => { writeSync(1, line); },
  kill: () => { process.kill(process.pid, 'SIGKILL'); },
});
