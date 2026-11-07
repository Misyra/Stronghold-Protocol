// server/health/watchdog.js — 主线程看门狗（移植自 Stardust fork 的 server/cluster/watchdog.js，2026-11-08）。
//
// 为什么要有它：一次不可恢复的主线程停摆（死循环、死锁、native 卡死）没有任何进程内的东西能救——
// [loop] 采样器、/healthz、事件编码全都在被卡住的主线程上，只能靠运维事后从 journal 断流里推理归因
// （本仓 2026-11-07/08 的线上停摆窗 §37.133 的 3405.8 ms、§37.136 的 2913 ms 与 ~2.9–3.6 s 冷拼、
// 2026-11-08 的 4.6 s / 3.6 s 窗，全是这样定位的）；Stardust fork 的先例更狠：2026-11-04 一次维多利亚
// payout 把 game-08 的主线程打满 1 h 43 min，协调器 15 s 后判 NODE_LOST 迁走了对局，但没有任何东西重启进程。
// 机制：主线程在一个裸 setInterval（刻意不走 RealScheduler——看门狗必须独立于被监视的调度器，
// SP_TURN_BUDGET_MS 的顺延在它面前就是被监视对象）里每拍 Atomics.add 一个 SharedArrayBuffer 计数器；
// 常驻 Worker（./watchdogWorker.js，小 RSS，unref 不挡正常退出）发现计数器静默超过阈值（默认 30 s），
// 经 inspector（session.connectToMainThread——实测本机 Node 26 无需 --inspect 预激活：JS 忙循环与
// Atomics.wait 阻塞都会被 Debugger.pause 的 V8 interrupt 打断，见 test/health-watchdog.test.js 的端到端用例）
// 抓主线程栈前 30 帧，把一行 JSON 直接 writeSync 到 fd 1（卡死的主线程转发不了 Worker 的 console，必须
// Worker 直写；journalctl 原样捕获），然后 SIGKILL 本进程——systemd Restart=always / NSSM / Docker 的
// 重启策略拉起新一代。写栈在 SIGKILL 之前，次序不能反；栈抓不到（captured:false）也照杀。
//
// 只在进程入口（server/http/boot.js runMain）启动：startServer() 的程序化调用（测试、工具、探针）不看门狗，
// 与 SP_VERSIONS_PREWARM 同一先例。SIGINT/SIGTERM 一到就 stop()：运维信号已证明主线程活着，关停有自己的
// SP_SHUTDOWN_TIMEOUT_MS 兜底（systemd 还有 TimeoutStopSec），不该在最后一笔状态落盘的途中被误杀。
//
// SP_MAIN_WATCHDOG_MS：未设/空 = 30 000，'0' = 关，5 000..600 000 之外的值回默认（不因拼写错误关掉保护）。
import { Worker } from 'node:worker_threads';

export const WATCHDOG_DEFAULT_MS = 30_000;
export const WATCHDOG_MIN_MS = 5_000, WATCHDOG_MAX_MS = 600_000;
/** 抓栈帧数上限与抓栈超时：栈是 best-effort，进程拉起才是一等目标。 */
export const WATCHDOG_FRAMES = 30;
export const WATCHDOG_CAPTURE_MS = 5_000;

/**
 * The threshold from the environment: unset = WATCHDOG_DEFAULT_MS, '0' = off (0), anything out of bounds = default.
 * @param {string | number | undefined | null} [value]
 * @returns {number}
 */
export function watchdogMs(value = process.env.SP_MAIN_WATCHDOG_MS) {
  if (value === undefined || value === null || String(value).trim() === '') return WATCHDOG_DEFAULT_MS;
  const n = Number(value);
  if (n === 0) return 0;
  return Number.isSafeInteger(n) && n >= WATCHDOG_MIN_MS && n <= WATCHDOG_MAX_MS ? n : WATCHDOG_DEFAULT_MS;
}

/** 一个 CallFrame 的 `fn` / `at`：url 常为空，靠 Debugger.enable 广播的 scriptParsed 表补；剥掉仓库根前缀。 */
const where = (f, urls, root) => {
  const url = (typeof f.url === 'string' && f.url) || urls.get(f.location.scriptId) || '';
  const file = url.startsWith(root) ? url.slice(root.length) : url.replace(/^file:\/\//, '');
  return `${file || '?'}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`;
};

/**
 * 主线程栈前 WATCHDOG_FRAMES 帧，或 null（通路不可用，或 captureMs 内没有答案）。只在 Worker 线程调用：
 * 主线程上 connectToMainThread 没有效果。CallFrame 的 url 常为空，靠 Debugger.enable 广播的 scriptParsed 补。
 * @param {number} [captureMs]
 * @param {string} [root] 从栈帧 URL 上剥掉的仓库根前缀（file://…/ → 相对路径）
 * @returns {Promise<Array<{ fn: string, at: string }> | null>}
 */
export function captureMainThreadFrames(captureMs = WATCHDOG_CAPTURE_MS, root = '') {
  return new Promise((resolve) => {
    let session = null, done = false;
    const finish = (frames) => {
      if (done) return; done = true; clearTimeout(timer);
      try { session?.disconnect(); } catch { /* 都要死了 */ }
      resolve(frames);
    };
    const timer = setTimeout(() => finish(null), captureMs);
    import('node:inspector').then((inspector) => {
      session = new inspector.Session();
      session.connectToMainThread();
      const urls = new Map();
      session.on('Debugger.scriptParsed', ({ params }) => { if (params?.url) urls.set(params.scriptId, params.url); });
      session.once('Debugger.paused', ({ params }) => finish((params.callFrames || []).slice(0, WATCHDOG_FRAMES)
        .map((f) => ({ fn: f.functionName || '(anonymous)', at: where(f, urls, root) }))));
      session.post('Debugger.enable', (err) => {
        if (err) return finish(null);
        session.post('Debugger.pause', (e) => { if (e) finish(null); });
      });
    }, () => finish(null));
  });
}

/**
 * 看门狗 Worker 的主循环。生产只由 ./watchdogWorker.js 调用（真实定时器、真实 fd 1、真实 SIGKILL）；
 * 测试注入 now/schedule/capture/write/kill，用假时钟逐拍驱动，验证静默判定、JSON 行的形状与
 * 「写栈先于 SIGKILL」的次序。write/kill 必须显式传入：测试忘了 mock 不能拿真 fd 1 与真 SIGKILL 去赌。
 * @param {object} opts
 * @param {Int32Array} opts.counter 主线程每拍 Atomics.add 的计数器
 * @param {number} opts.thresholdMs 静默阈值（Worker 侧不再读环境；主线程已解析定案）
 * @param {number} opts.checkMs 检查间隔（= 主线程的拍长）
 * @param {string} [opts.role] JSON 行里的角色名
 * @param {number} [opts.captureMs] inspector 抓栈的超时
 * @param {string} [opts.root] 栈帧 URL 上剥掉的仓库根前缀
 * @param {() => number} [opts.now] 单调毫秒
 * @param {(fn: () => void, ms: number) => unknown} [opts.schedule] 定时器（默认 setInterval；测试注入）
 * @param {(handle: unknown) => void} [opts.unschedule] 定时器的取消（默认 clearInterval；测试注入）
 * @param {(captureMs: number, root: string) => Promise<Array<{ fn: string, at: string }> | null>} [opts.capture]
 *   主线程栈抓取（默认 inspector 通路；测试注入）
 * @param {(line: string) => void} opts.write 直写 fd 1 的一行（含结尾换行）
 * @param {() => void} opts.kill 终结进程
 * @param {() => number | null} [opts.rss] 进程 RSS 字节
 * @param {() => number} [opts.uptime] 进程 uptime 秒
 * @returns {{ stop(): void }}
 */
export function runWatchLoop({ counter, thresholdMs, checkMs, role = 'server', captureMs = WATCHDOG_CAPTURE_MS, root = '',
  now = () => performance.now(), schedule = (fn, ms) => setInterval(fn, ms), unschedule = (h) => clearInterval(h),
  capture = captureMainThreadFrames, write, kill, rss = () => process.memoryUsage().rss, uptime = () => process.uptime() }) {
  if (typeof write !== 'function' || typeof kill !== 'function') throw new TypeError('watchdog worker needs write and kill');
  let last = Atomics.load(counter, 0), lastAt = now(), firing = false;
  /** 触发后的处置：栈、一行 JSON、SIGKILL。任何一步失败都不拦住 kill——它是唯一的不变量。 */
  const fire = async (blockedMs) => {
    const frames = await Promise.resolve().then(() => capture(captureMs, root)).catch(() => null);
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    const line = { event: 'watchdog', role, blockedMs: Math.round(blockedMs), thresholdMs, captured: frames != null,
      frames: frames ?? [], rssBytes: safe(rss), uptimeSec: safe(uptime) };
    try { write(`${JSON.stringify(line)}\n`); } catch { /* 杀进程比写日志更要紧 */ }
    try { kill(); } catch { /* 已经在退了 */ }
  };
  const tick = () => {
    if (firing) return;
    const t = now(), cur = Atomics.load(counter, 0);
    if (cur !== last) { last = cur; lastAt = t; return; } // 有进展：基线前移，一次 GC 停顿到不了下面
    const blocked = t - lastAt;
    if (blocked < thresholdMs) return; // 静默未满阈值
    firing = true; // 决策即置位：抓栈期间（最多 captureMs）不再重复触发
    void fire(blocked).catch(() => { try { kill(); } catch { /* 没有更多能做的 */ } });
  };
  const handle = schedule(tick, checkMs);
  return { stop() { unschedule(handle); } };
}

/**
 * 启动本进程的主线程看门狗：每拍计数器 + 常驻 Worker。thresholdMs 由 watchdogMs() 解析（0 = 关，返回 null）；
 * 更小的值仅供测试（≥ 200）。SIGINT/SIGTERM 的关停路径先 stop()（见文件头）。
 * @param {{ thresholdMs?: number, beatMs?: number, role?: string, captureMs?: number }} [options]
 * @returns {{ stop(): Promise<void> } | null}
 */
export function startMainWatchdog({ thresholdMs = watchdogMs(), beatMs, role = 'server', captureMs = WATCHDOG_CAPTURE_MS } = {}) {
  if (!thresholdMs) return null;
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 200 || thresholdMs > WATCHDOG_MAX_MS) throw new RangeError('invalid watchdog threshold');
  const beat = Math.max(50, Math.min(1000, beatMs ?? Math.floor(thresholdMs / 10)));
  const shared = new SharedArrayBuffer(4), counter = new Int32Array(shared);
  const timer = setInterval(() => { Atomics.add(counter, 0, 1); }, beat);
  timer.unref();
  const worker = new Worker(new URL('./watchdogWorker.js', import.meta.url), {
    name: 'sp-watchdog', // 运维采样把它和模拟池的 WorkerThreads 分开数
    // 空 execArgv（fork 原样透传 process.execArgv，只滤 --input-type；本仓实测 node --test 的进程 execArgv
    // 带着一串 per-thread 无效的 V8 flags，透传直接 ERR_WORKER_INVALID_EXEC_ARGV）：看门狗 worker 只用
    // plain Node API，不需要父进程的任何 flag，空表永远不会非法。
    execArgv: [],
    workerData: { shared, thresholdMs, checkMs: beat, role, captureMs, root: new URL('../../', import.meta.url).href } });
  worker.unref();
  // 起不来的看门狗不能反过来杀节点：报一行，回到没有看门狗的旧世界继续跑。
  worker.on('error', (e) => { console.error(`[watchdog] stopped: ${e?.code || e?.message || e}`); }); // i18n-ignore 开发者日志
  let stopped = false;
  return {
    async stop() {
      if (stopped) return; stopped = true;
      clearInterval(timer);
      await worker.terminate();
    },
  };
}
