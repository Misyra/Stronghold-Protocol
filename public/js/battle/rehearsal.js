// public/js/battle/rehearsal.js — the host's side of the delegated bot layout rehearsal (DESIGN §14).
//
// The server hands the match's current host the candidate BattleSpecs of one bot prep (`b.rehearsal`); this module runs
// them in a module Worker (battle/rehearsalWorker.js, off the page's main thread) and answers
// `b.rehearsalResult { taskId, choice }` with the index of the pick — or `{ taskId, error: true }` when this browser
// cannot run it (no module Worker, the simulation data did not load, the worker died): the server then simulates the
// very same candidates itself, at once instead of waiting for its timeout.
//
// One Worker serves the whole tab: it reports itself (`{ t: 'ready' }`) once its module graph is evaluated — a message
// posted before that is lost — and is then handed the simulation data once from the runner's own load (the page already
// has those frozen /data/*.json for its own battles — no second fetch, no second parse), followed by one task at a
// time. A 4-seat match has at most 3 AI seats, so the queue is small (MAX_PENDING_TASKS); a task that would have to
// wait past it is answered `error` for the same reason — the server should not hold a bot prep for work this page
// cannot do.
//
// The server also drops tasks it no longer waits for (`b.rehearsalCancel`: a timeout, a host change, the prep ending)
// and so does the page. A task still running is stopped by terminating its Worker — the only thing that interrupts a
// simulation already under way, a message would only be read after it —, and the next task builds a fresh Worker (its
// `ready` / data state belongs to that instance; the data is sent again from the page's own copy). The task id in the
// frame keeps a cancel from touching a task that took its place. The page drops its tasks itself when the match on
// screen is over (`clear`, wired in main.js) and when the socket is not online — an answer could not be delivered
// then. Both terminate the Worker only while a task is still in flight (that is the one thing worth stopping); an
// idle Worker — and one whose task was dropped before it was even sent, its module graph still loading — keeps its
// `ready` / data state, so the next match's first rehearsal finds it warm instead of paying the module-graph load
// again. A Worker that fails at runtime is rebuilt with a bounded budget (MAX_WORKER_FAILURES per match): one crash
// must not disable rehearsal for the whole page session, a Worker that dies every time must not be restarted for
// ever.
//
//   installRehearsal({ net, runner, createWorker, log }) → { pending(), clear(), dispose() } | null   (wired in main.js)

import { battleRunner } from './runner.js';

/** The module Worker that simulates the candidates (public/ is served at the root). */
export const WORKER_URL = '/js/battle/rehearsalWorker.js';
/** Tasks kept while the single worker is busy; one more may always run. */
export const MAX_PENDING_TASKS = 3;
/** Worker failures allowed per match (its script crashed, its module graph failed to load): past it the page stops
 *  rebuilding until the next match's clear() hands out a fresh budget — a browser that loses its worker every time
 *  rehearses nothing, but one crash must not disable rehearsal for the whole page session. */
export const MAX_WORKER_FAILURES = 3;

/**
 * A spec that names a content set is not this worker's job. The worker only has the page's official `/data/`
 * (no plugin pack, no plugin scripts). A missing `cs` is the official data. Gameplay-plugin rooms are not offered
 * the task at all (server/match/match/rehearsal.js); this refuses one that arrived anyway.
 * @param {unknown[]} specs
 */
export function rehearsalSpecsAreOfficial(specs) {
  return !specs.some((s) => s && typeof s === 'object' && typeof s.cs === 'string' && s.cs !== '');
}

/**
 * @param {{ net?: any, runner?: any, createWorker?: () => Worker, log?: object }} [deps] `net` = the app socket
 *   (default: none — the caller passes it), `runner` = the battle runner whose simulation data the worker is given
 *   (default: the browser singleton; its `ensureSim()` warms and caches it), `createWorker` = the Worker factory (tests)
 * @returns {null | { pending: () => number, clear: () => void, dispose: () => void }} null without a socket, or in Node
 */
export function installRehearsal({ net, runner = battleRunner, createWorker = () => new Worker(WORKER_URL, { type: 'module' }), log = console } = {}) {
  if (!net || typeof net.on !== 'function' || !runner || typeof runner.ensureSim !== 'function') return null;
  /** The tasks waiting for the worker, oldest first. */
  const queue = [];
  /**
   * The live worker with its own state — `task` is the one it runs now, `ready` (its script is evaluated) and `data`
   * (it was given the simulation data) belong to this instance. It is dropped as a whole, so a replacement starts with
   * fresh flags and a late callback of the old one finds itself unknown (`w !== inst`).
   */
  let w = null;
  /**
   * This browser cannot run the tasks at all (no module Worker, or the worker failed MAX_WORKER_FAILURES times this
   * match): every task is answered `error` at once. Reset by clear() — a new match may try again.
   */
  let broken = false;
  /** Runtime failures of live workers this match; the budget behind `broken`. */
  let failures = 0;

  const answer = (task, fields) => {
    if (task.settled) return;
    task.settled = true;
    net.send('b.rehearsalResult', { taskId: task.id, ...fields });
  };

  /** Give one worker instance the page's simulation data (once): its frozen /data/*.json as the runner loaded them. */
  const sendData = (inst) => runner.ensureSim().then((sim) => {
    // official data only: a content-set load names its `cs` and may carry scripts this worker must not run
    if (!sim || !sim.raw || (typeof sim.cs === 'string' && sim.cs !== '')) throw new Error('no official simulation data');
    if (w !== inst) return; // the instance was dropped while the data loaded: nothing is posted into it
    inst.port.postMessage({ t: 'data', raw: sim.raw });
    inst.data = true;
  });

  /** Terminate the live worker (the only way to stop a simulation already running in it) and forget it. */
  const killWorker = () => {
    const dead = w;
    w = null;
    if (dead) { try { dead.port.terminate(); } catch { /* ignore */ } }
    return dead;
  };

  /**
   * A worker failed (its script, its module graph): answer the running one and everything queued `error`, so the
   * server rehearses those candidates itself instead of waiting for its timeout. `fatal` (no module Worker at all)
   * breaks the page for good; a runtime failure only counts against this match's budget (failWorker is what makes
   * `broken` bounded — one crash is rebuilt, a worker that dies every time is not).
   */
  const failWorker = (why, err, fatal = false) => {
    log.warn?.(`[rehearsal] ${why}`, err || '');
    if (fatal || ++failures >= MAX_WORKER_FAILURES) broken = true;
    const dead = killWorker();
    const tasks = queue.splice(0);
    if (dead && dead.task) tasks.unshift(dead.task);
    for (const task of tasks) answer(task, { error: true });
  };

  /** The live worker, created on the first task (null once this browser was found unable to run one). */
  function startWorker() {
    if (w || broken) return w;
    const inst = { port: null, ready: false, data: false, task: null, sent: false, wantData: false };
    try {
      inst.port = createWorker();
    } catch (err) {
      failWorker('module Worker unavailable', err, true);
      return null;
    }
    inst.port.onmessage = (ev) => onWorkerMessage(inst, ev && ev.data);
    // a late error of a worker that was already dropped (its task was cancelled) says nothing about the live one
    inst.port.onerror = (ev) => { if (w === inst) failWorker('worker failed', ev && ev.message); };
    w = inst;
    return inst;
  }

  /**
   * Warm the worker without a task: create it and hand it the simulation data so the next task finds it ready.
   * Called when a running task is cancelled (its worker can only be stopped by terminating it) — the replacement loads
   * while the page waits for the next prep, instead of doing that loading inside that task's 3 s answer budget. The
   * first task of a page cannot be warmed this way (there is no worker yet when the server offers it); it pays the
   * module-graph load, which is why a cancelled *waiting* task keeps its worker alive instead of dropping it.
   * A worker that has not reported `ready` yet drops anything posted to it (a module Worker is not listening until its
   * imports are evaluated), so the data goes out from the ready handler instead.
   */
  function warm() {
    const inst = startWorker();
    if (!inst || inst.data) return;
    if (!inst.ready) { inst.wantData = true; return; }
    sendData(inst).catch((err) => log.warn?.('[rehearsal] simulation data unavailable', err));
  }

  /** Hand one task to a worker whose script has run: the data first (once per instance), then the task itself. */
  function sendTask(inst, task) {
    Promise.resolve(inst.data ? null : sendData(inst)).then(() => {
      if (w !== inst || inst.task !== task) return;
      inst.port.postMessage({ t: 'rehearsal', taskId: task.id, playerId: task.playerId, cap: task.cap, specs: task.specs, ...(task.limits ? { limits: task.limits } : {}) });
      inst.sent = true;
    }, (err) => {
      log.warn?.('[rehearsal] simulation data unavailable', err);
      if (w !== inst || inst.task !== task) return;
      inst.task = null;
      inst.sent = false;
      answer(task, { error: true });
      pump();
    });
  }

  function onWorkerMessage(inst, msg) {
    if (!msg || w !== inst) return; // a late message of a worker that was dropped
    if (msg.t === 'ready') { // only now can the worker receive anything: the waiting task finally goes out
      inst.ready = true;
      if (inst.task) { inst.wantData = false; sendTask(inst, inst.task); }
      else if (inst.wantData) { // warmed with no task: load the data so the next task does not pay for it
        inst.wantData = false;
        sendData(inst).catch((err) => log.warn?.('[rehearsal] simulation data unavailable', err));
      }
      return;
    }
    const task = inst.task;
    if (!task || msg.taskId !== task.id) return; // an answer to a task the server already took over
    inst.task = null;
    inst.sent = false;
    if (msg.t === 'done' && Number.isInteger(msg.choice)) answer(task, { choice: msg.choice });
    else { log.warn?.('[rehearsal] the task failed', msg && msg.message); answer(task, { error: true }); }
    pump();
  }

  /** Hand the next queued task to the worker (a fresh one after a termination). */
  function pump() {
    if (w && w.task) return; // the worker is busy
    const task = queue.shift();
    if (!task) return;
    const inst = startWorker();
    if (!inst) { answer(task, { error: true }); return; } // no module Worker: failWorker answered the rest of the queue
    inst.task = task;
    if (inst.ready) sendTask(inst, task); // else it waits for the worker's ready
  }

  /** A task from the match (its own validation: the server's frames are trusted, but a shape check keeps the worker safe). */
  function onTask(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.taskId !== 'string' || typeof msg.playerId !== 'string'
      || !Number.isFinite(msg.cap) || !Array.isArray(msg.specs)) return;
    const task = { id: msg.taskId, playerId: msg.playerId, cap: msg.cap, specs: msg.specs, limits: msg.limits, settled: false };
    // past the queue, or a spec that names a content set: answer now, so the server rehearses on its own data
    if (broken || queue.length >= MAX_PENDING_TASKS || !rehearsalSpecsAreOfficial(msg.specs)) { answer(task, { error: true }); return; }
    queue.push(task);
    pump();
  }

  /**
   * The server dropped one task (`b.rehearsalCancel`, DESIGN §14): the page drops it too. A task still queued is simply
   * forgotten. A task the worker is still *waiting* to take (its script has not reported ready yet) only drops the
   * task — the worker keeps loading, so the next prep finds it ready instead of paying the module-graph load inside its
   * own 3 s answer budget (that load is what makes a page's first rehearsal time out, and terminating here made every
   * following one start from zero again). A task the worker is running is stopped by terminating it — a message would
   * only be read after the simulation — and a fresh one is warmed at once for the next task. A cancel for any other
   * task is ignored, so it can never touch the task that replaced it.
   */
  function onCancel(msg) {
    if (!msg || typeof msg.taskId !== 'string') return;
    if (w && w.task && w.task.id === msg.taskId) {
      const task = w.task;
      task.settled = true;
      if (w.sent) {
        // the simulation is under way: only a terminated Worker stops it
        killWorker();
        warm();
      } else {
        // the worker is still loading; the task never reached it. Keep the loading progress and warm the data too.
        w.task = null;
        warm();
      }
      pump();
      return;
    }
    const i = queue.findIndex((task) => task.id === msg.taskId);
    if (i >= 0) queue.splice(i, 1)[0].settled = true;
  }

  /** Drop every task of the match that is over: a Worker with a simulation already under way (`sent`) is terminated
   *  — the page could not answer it any more, and only a terminated Worker stops it —, one still waiting for its
   *  module graph only loses the task (as onCancel: the next match's first rehearsal finds the Worker ready instead
   *  of paying the load inside its 3 s answer budget), an idle one keeps its `ready` / data state; the queue is
   *  emptied either way and the worker's failure budget starts over. */
  function clear() {
    if (w && w.sent) {
      const dead = killWorker();
      if (dead.task) dead.task.settled = true;
    } else if (w && w.task) {
      w.task = null;
      warm();
    }
    for (const task of queue.splice(0)) task.settled = true;
    failures = 0;
    broken = false;
  }

  /**
   * The socket is not online (a drop, a reconnect, another page taking this session over): `net.send` refuses every
   * frame then, so this page could not answer the task any more and the `b.rehearsalCancel` that would drop it cannot
   * arrive either — a task still running must stop (only a terminated Worker stops it), while a Worker without one in
   * flight keeps its warmth for the next match. main.js drops the tasks of a match that is over the same way.
   */
  function onStatus(snap) {
    if (!snap || snap.status !== 'online') clear();
  }

  const offTask = net.on('b.rehearsal', onTask);
  const offCancel = net.on('b.rehearsalCancel', onCancel);
  const offStatus = net.on('status', onStatus);
  return {
    /** The tasks queued but not started (tests). */
    pending: () => queue.length,
    /** The match context is over (main.js): nothing of it may keep the worker busy. */
    clear,
    dispose() {
      offTask();
      offCancel();
      offStatus();
      clear();
    },
  };
}
