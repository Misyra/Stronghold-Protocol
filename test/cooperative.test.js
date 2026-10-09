// FIFO/cancellation cases adapted from xinhai 23d0a929 (GPL-3.0-or-later).
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CooperativeQueue } from '../server/cooperative.js';
import { RealScheduler } from '../server/match/scheduler.js';
import { MatchInfra } from '../server/match/match/infra.js';
import { makeMatch } from './match/harness.js';
import { matchState } from '../server/match/snapshot.js';
import { runHeadless } from '../server/match/fields.js';
import { createBattleFromSpec, resultDigest, compactResult } from '../server/sim/spec.js';
test('shared CPU queue enforces an aggregate budget and FIFO fairness across continuations', () => {
  let now = 0;
  const turns = [];
  const queue = new CooperativeQueue({ now: () => now, schedule: (fn) => { turns.push(fn); return fn; },
    cancel: (fn) => turns.splice(turns.indexOf(fn), 1) });
  const order = [];
  queue.enqueue(() => { order.push('A1'); now += 8; queue.enqueue(() => order.push('A2')); });
  queue.enqueue(() => { order.push('B'); now += 8; });
  turns.shift()();
  assert.deepEqual(order, ['A1']);
  turns.shift()();
  assert.deepEqual(order, ['A1', 'B']);
  turns.shift()();
  assert.deepEqual(order, ['A1', 'B', 'A2']);
  const cancelled = queue.enqueue(() => assert.fail('cancelled work ran'));
  queue.remove(cancelled);
  assert.equal(turns.length, 0);
});

test('real schedulers cancel queued CPU work on timer cancellation and disposal', async () => {
  const a = new RealScheduler(), b = new RealScheduler();
  const order = [];
  a.clearTimeout(a.setWork(() => assert.fail('cancelled work ran')));
  a.setWork(() => assert.fail('disposed work ran'));
  b.setWork(() => order.push('B'));
  a.dispose();
  await nextTurn();
  assert.deepEqual(order, ['B']);
  b.dispose();
});

function manualWork(sched) {
  const jobs=new Map(),clear=sched.clearTimeout.bind(sched);
  sched.setWork=(fn)=>{const h={};jobs.set(h,fn);return h;};
  sched.clearTimeout=(h)=>{if(!jobs.delete(h))clear(h);};
  return { jobs, step() { const [h,fn]=jobs.entries().next().value; jobs.delete(h);fn(); },
    drain() { let n=0;while(jobs.size){if(++n>10000)assert.fail('work did not drain');this.step();}return n; } };
}
function prep(t) {
  const h=makeMatch({mode:'solo',humans:1,seed:7,fake:true,botRehearsal:0});
  t.after(()=>h.m.dispose());h.start();h.toPrep(6);
  h.m.timerScale=0;h.m.botSliceMs=0;h.m.maybeEndPrep=()=>{};h.m.order[0].autoplay=true;
  return h;
}

test('queue enforces max tasks even for zero-time work; thrown work does not strand other owners', () => {
  const turns=[],queue=new CooperativeQueue({maxTasks:2,now:()=>0,schedule:fn=>{turns.push(fn);return fn;},cancel:()=>{}});
  const order=[];for(let i=0;i<5;i++)queue.enqueue(()=>order.push(i));
  turns.shift()();assert.deepEqual(order,[0,1]);turns.shift()();assert.deepEqual(order,[0,1,2,3]);turns.shift()();assert.equal(queue.tasks.size,0);
  queue.enqueue(()=>{throw Error('broken');});queue.enqueue(()=>order.push(5));
  assert.throws(()=>turns.shift()(),/broken/);turns.shift()();assert.equal(order.at(-1),5);assert.equal(queue.handle,null);
});

test('real scheduler isolates callback errors and clears ownership on completion and disposal', async (t) => {
  const errors=[],s=new RealScheduler({onError:e=>errors.push(e.message)});t.after(()=>s.dispose());
  s.setWork(()=>{throw Error('broken');});let ran=false;s.setWork(()=>{ran=true;});
  await nextTurn();assert.equal(ran,true);assert.deepEqual(errors,['broken']);assert.equal(s._work.size,0);
  s.dispose();assert.equal(s.setWork(()=>assert.fail()),null);
});

test('laterWork includes guarded state flushes, tracks cancellation and preserves virtual fallback', async (t) => {
  const scheduler=new RealScheduler();t.after(()=>scheduler.dispose());
  let flushed=0;const m=Object.assign(new MatchInfra(),{sched:scheduler,_timers:new Set(),disposed:false,flush:()=>flushed++,reportError:assert.fail});
  const h=m.laterWork(()=>assert.fail('cancelled'));m.cancel(h);
  m.laterWork(()=>{});await nextTurn();assert.equal(flushed,1);assert.equal(m._timers.size,0);
  const virtual=prep(t);let ran=false;virtual.m.laterWork(()=>{ran=true;});assert.equal(ran,false);virtual.sched.advance(0);assert.equal(ran,true);
});

test('real Bot generator split across queued continuations preserves economy, inventory, layout and RNG', (t) => {
  const a=prep(t),b=prep(t);const work=manualWork(b.sched);
  a.m.scheduleBotPrep(a.m.order[0]);a.sched.advance(0);
  b.m.scheduleBotPrep(b.m.order[0]);b.sched.advance(0);
  assert.equal(b.m.order[0].ready,false);assert.ok(work.jobs.size>0);
  assert.ok(work.drain()>1);assert.equal(b.m.order[0].ready,true);
  assert.deepEqual(matchState(b.m),matchState(a.m));assert.equal(b.m.errorCount,0);
});

test('queued Bot work checks phase/token again and disposal releases pending callbacks', (t) => {
  const h=prep(t),work=manualWork(h.sched);h.m.scheduleBotPrep(h.m.order[0]);h.sched.advance(0);
  const before=matchState(h.m);h.m.phase='COMBAT';work.drain();h.m.phase='PREP';
  assert.deepEqual(matchState(h.m),before);
  h.m.scheduleBotPrep(h.m.order[0]);h.sched.advance(0);assert.ok(work.jobs.size>0);
  h.m.dispose();assert.equal(work.jobs.size,0);assert.equal(h.m._timers.size,0);
});

test('Worker-selected Bot end is queued, then ignores a result from an older prep token', async (t) => {
  const h=prep(t),work=manualWork(h.sched),ps=h.m.order[0];let resolve;
  h.m.botRehearsal=1;
  h.m.workerPool={submit:()=>({promise:new Promise(yes=>{resolve=yes;}),cancel(){}})};
  h.m.scheduleBotPrep(ps);h.sched.advance(0);work.drain();assert.equal(typeof resolve,'function');
  resolve({bestIndex:0});await Promise.resolve();assert.ok(work.jobs.size>0);assert.equal(ps.ready,false);
  const before=matchState(h.m);ps._botPrepToken++;work.drain();assert.deepEqual(matchState(h.m),before);
});

function combat(t) {
  const h=makeMatch({humans:2,seed:9112,clientCombat:true,clients:false});t.after(()=>h.m.dispose());
  h.start();h.drive(()=>h.m.phase==='COMBAT');h.m.headlessSliceMs=1;
  return h;
}

test('bounded local takeover uses queued work; cancellation drops stale slices; output stays exact', (t) => {
  const h=combat(t),m=h.m,f=m.fields[0],work=manualWork(h.sched);
  const expected=runHeadless(createBattleFromSpec(f.spec,m.ds),{players:f.players}).result;
  m._runOnServer(f,'test',{local:true});assert.ok(f.sliceTimer);assert.ok(work.jobs.has(f.sliceTimer));
  m._clearFieldTimers(f);assert.equal(work.jobs.size,0);assert.equal(f.job,null);assert.equal(f.result,null);
  m._runOnServer(f,'test',{local:true});assert.ok(work.drain()>0);
  assert.equal(resultDigest(f.result).hash,resultDigest(expected).hash);assert.equal(m.errorCount,0);
});

test('strict local verification queues slices, holds paused results and cancels replaced fields', (t) => {
  const h=combat(t),m=h.m,f=m.fields[0],work=manualWork(h.sched);m.verifyMode='all';
  const result=compactResult(runHeadless(createBattleFromSpec(f.spec,m.ds),{players:f.players}).result);
  m.handle('p_0',{t:'b.result',battleId:f.battleId,result});assert.ok(work.jobs.has(f.verifyTimer));
  m._clearFieldTimers(f);assert.equal(work.jobs.size,0);assert.equal(f.result,null);
  m.isSolo=true;m.handle('p_0',{t:'b.result',battleId:f.battleId,result});
  m.setPause(m.players.get('p_0'),true);assert.equal(m.paused,true);work.drain();
  assert.ok(f.result);assert.equal(f.verifying,true);assert.equal(f.done,false);
  m.setPause(m.players.get('p_0'),false);assert.equal(f.done,true);assert.equal(m.errorCount,0);
});

test('pending CPU continuations keep running without an unrelated I/O wakeup, then release the process', () => {
  const url=new URL('../server/match/scheduler.js',import.meta.url).href;
  const code='import { RealScheduler } from '+JSON.stringify(url)+'; const s=new RealScheduler(); let n=0; for(let i=0;i<130;i++)s.setWork(()=>{if(++n===130)console.log(n);});';
  const out=execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(out.trim(),'130');
});
