import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TimingHistogram, NetDiagnostics, ProcessIntervals, socketDiagnostics } from '../server/netDiagnostics.js';
import { Network, SessionRegistry, send, NET_DEFAULTS } from '../server/net.js';

test('completed diagnostic windows are reader-independent, bounded and reset GC', (t) => {
  const d = new ProcessIntervals(); t.after(() => d.close());
  assert.equal(d.snapshot().latest, null);
  d.recordGc([{ duration: 60, detail: { kind: 1 } }, { duration: 25, detail: { kind: 999 } }]);
  d.settle();
  const first = d.snapshot();
  assert.equal(first.latest.gc.totalMs, 85);
  assert.equal(first.latest.gc.over50, 1);
  assert.equal(first.latest.gc.byKind.minor, 1);
  assert.equal(first.latest.gc.byKind.unknown, 1);
  assert.deepEqual(d.snapshot(), first);
  first.latest.gc.count = 999;
  assert.equal(d.snapshot().latest.gc.count, 2);
  d.settle(); assert.equal(d.snapshot().latest.gc.count, 0);
  for (let i = 0; i < 12; i++) d.settle();
  assert.equal(d.snapshot().windows.length, 8);
  assert.equal(d.snapshot().latest.sequence, 14);
});

test('a short real event-loop freeze survives subsequent diagnostic reads', async (t) => {
  const d = new ProcessIntervals({ windowMs: 1000 }); t.after(() => d.close());
  await delay(50);
  const until = performance.now() + 90;
  while (performance.now() < until) { /* controlled main-thread stall */ }
  await delay(35);
  d.settle();
  const first = d.snapshot();
  assert.ok(first.latest.eventLoop.maxMs > 60);
  assert.ok(Number.isFinite(first.latest.eventLoop.p95Ms) && first.latest.eventLoop.p95Ms >= first.latest.eventLoop.p90Ms);
  assert.deepEqual(d.snapshot(), first);
  assert.ok(first.latest.windowMs > 100);
});

function socket(network) {
  const ws=new EventEmitter();Object.assign(ws,{readyState:1,bufferedAmount:0,frames:[],callbacks:[]});
  ws.send=(data,callback)=>{ws.frames.push(JSON.parse(data));ws.callbacks.push(callback);};
  ws.close=ws.terminate=()=>{ws.readyState=3;ws.emit('close');};ws.ping=()=>{};
  network.handleConnection(ws);return ws;
}

test('timing histogram has bounded storage, upper-bound percentiles and finite empty statistics', () => {
  const h=new TimingHistogram();assert.equal(h.stats().p95UpperMs,0);
  for(let i=1;i<=100;i++)h.record(i);
  for(const n of [NaN,Infinity,-1])h.record(n);
  const s=h.stats();assert.equal(s.count,100);assert.equal(s.avgMs,50.5);
  assert.ok(s.p95UpperMs>=95&&s.p95UpperMs<=100);assert.equal(s.maxMs,100);
  assert.equal(s.sumMs,5050);assert.equal(s.buckets.at(-1).count,100);
  assert.equal(h.buckets.length,21);
});

test('histogram snapshots expose the exact sum and cumulative buckets without leaking internals', () => {
  const h=new TimingHistogram();
  for(const ms of [0.01,0.25,2,5,80000])h.record(ms);
  const view=h.stats();
  assert.equal(view.count,5);assert.equal(view.sumMs,80007.26);assert.equal(view.p95UpperMs,80000);
  assert.equal(view.buckets.at(-1).leMs,'+Inf');assert.equal(view.buckets.at(-1).count,5);
  assert.equal(view.buckets.find((b)=>b.leMs===2).count,3);
  assert.ok(view.buckets.every((b,i)=>!i||b.count>=view.buckets[i-1].count));
  view.buckets[0].count=999;view.sumMs=-1;
  assert.equal(h.stats().buckets[0].count,1);assert.equal(h.stats().sumMs,80007.26);
});

test('injected CPU sampler freezes per-window deltas, clamps regressions and passes through NetDiagnostics', (t) => {
  const ticks=[[0,0],[1500000,500000],[3000000,1000000],[2900000,1000000]];let i=0;
  const d=new ProcessIntervals({windowMs:15000,cpuUsage:()=>({user:ticks[i][0],system:ticks[i++][1]})});
  t.after(()=>d.close());
  d.settle();d.settle();
  const windows=d.snapshot().windows;
  assert.deepEqual(windows.map((w)=>w.sequence),[1,2]);
  assert.deepEqual(windows[0].processCpuDelta,{userSeconds:1.5,systemSeconds:0.5});
  assert.deepEqual(windows[1].processCpuDelta,{userSeconds:1.5,systemSeconds:0.5});
  d.settle();
  assert.deepEqual(d.snapshot().latest.processCpuDelta,{userSeconds:0,systemSeconds:0});
  assert.deepEqual(d.snapshot(),d.snapshot());
  const passthrough=[[0,0],[500000,250000]];let j=0;
  const n=new NetDiagnostics({windowMs:15000,cpuUsage:()=>({user:passthrough[j][0],system:passthrough[j++][1]})});
  t.after(()=>n.close());
  n.intervals.settle();
  assert.deepEqual(n.intervals.snapshot().latest.processCpuDelta,{userSeconds:0.5,systemSeconds:0.25});
});

test('injected ELU sampler freezes exact window utilization; zero activity is null and windows never overlap', (t) => {
  const samples=[{idle:10,active:2},{idle:13,active:3},{idle:16,active:7},{idle:16,active:7}];let i=0;
  const d=new ProcessIntervals({windowMs:15000,eluNow:()=>samples[i++]});
  t.after(()=>d.close());
  d.settle();d.settle();
  const windows=d.snapshot().windows;
  assert.deepEqual(windows.map((w)=>w.eventLoop.utilization),[0.25,4/7]);
  assert.deepEqual(d.snapshot(),d.snapshot());
  assert.equal(i,3); // one baseline plus exactly one sample per settle: window deltas sum to the total delta
  const flat=new ProcessIntervals({windowMs:15000,eluNow:()=>({idle:5,active:5})});
  t.after(()=>flat.close());
  flat.settle();
  assert.equal(flat.snapshot().latest.eventLoop.utilization,null);
});

test('diagnostic message keys are bounded and never contain client-controlled unknown type names', (t) => {
  const d=new NetDiagnostics();t.after(()=>d.close());
  for(let i=0;i<1000;i++)d.received('attacker'+i,4,1);
  d.received('ping',6,2);
  const s=d.stats();assert.deepEqual(Object.keys(s.handlerMs).sort(),['invalid','ping']);
  assert.equal(s.receivedFrames,1001);assert.equal(s.receivedBytes,4006);assert.equal(s.handlerMs.invalid.count,1000);
});

test('socket diagnostics count actual queued UTF-8 frames; completion sampled every 64 and failures excluded', async (t) => {
  const network=new Network({registry:new SessionRegistry(),handler:{onMessage(){}}});t.after(()=>network.close());
  const ws=socket(network),msg={t:'ok',text:'中文'};
  for(let i=0;i<64;i++)assert.equal(send(ws,msg),true);
  // The shared send budget may defer writes when the test process itself was descheduled mid-burst.
  while(network.outbound._outbound.size)await new Promise((resolve)=>setImmediate(resolve));
  let stats=network.diagnostics.stats();assert.equal(stats.sentFrames,64);
  assert.equal(stats.sentBytes,Buffer.byteLength(JSON.stringify(msg))*64);
  for(const cb of ws.callbacks.slice(0,63))cb();assert.equal(network.diagnostics.stats().sendCompletionMs.count,0);
  await delay(5);ws.callbacks[63]();stats=network.diagnostics.stats();
  assert.equal(stats.sendCompletionMs.count,1);assert.ok(stats.sendCompletionMs.maxMs>=1);
  ws.send=()=>{throw Error('send failed');};assert.equal(send(ws,msg),false);assert.equal(network.diagnostics.stats().sentFrames,64);
});

test('send callback errors do not become successful completion samples', (t) => {
  const d=new NetDiagnostics();t.after(()=>d.close());
  for(let i=0;i<63;i++)d.sent('x');const cb=d.sendCallback();d.sent('x');cb(Error('closed'));
  assert.equal(d.stats().sendCompletionMs.count,0);
});

test('soft backpressure drops snapshots only; hard backpressure disconnects are counted', (t) => {
  const network=new Network({registry:new SessionRegistry(),handler:{onMessage(){}}});t.after(()=>network.close());
  const ws=socket(network);ws.bufferedAmount=NET_DEFAULTS.snapDropBytes+1;
  assert.equal(send(ws,{t:'b.snap'}),false);assert.equal(send(ws,{t:'ok'}),true);
  ws.bufferedAmount=NET_DEFAULTS.hardBufferBytes+1;assert.equal(send(ws,{t:'ok'}),false);
  const s=network.diagnostics.stats();assert.equal(s.droppedSnapshots,1);assert.equal(s.slowDisconnects,1);assert.equal(s.sentFrames,0, 'reliable replies wait instead of growing the congested socket buffer');
  assert.equal(socketDiagnostics.has(ws),false);
});

test('validated message timings are per server; malformed messages aggregate as invalid; close clears socket ownership', (t) => {
  const a=new Network({registry:new SessionRegistry(),handler:{onMessage(){}}}),b=new Network({registry:new SessionRegistry(),handler:{onMessage(){}}});
  t.after(()=>a.close());t.after(()=>b.close());const ws=socket(a);
  ws.emit('message',Buffer.from('{"t":"ping","c":123}'),false);
  ws.emit('message',Buffer.from('{broken'),false);
  const s=a.diagnostics.stats();assert.equal(s.handlerMs.ping.count,1);assert.equal(s.handlerMs.invalid.count,1);
  assert.equal(s.receivedFrames,2);assert.equal(b.diagnostics.stats().receivedFrames,0);
  assert.equal(socketDiagnostics.has(ws),true);ws.close();assert.equal(socketDiagnostics.has(ws),false);
  assert.equal(a.connectionCount,0);
});
