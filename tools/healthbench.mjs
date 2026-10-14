// Health body CPU benchmark; no HTTP/TLS throughput or full-match capacity claim.
// node tools/healthbench.mjs --rooms 500 --reads 100000
// Snapshot reuse inspired by xinhai 23d0a929 (GPL-3.0-or-later).
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { Network } from '../server/net.js';
import { healthReport, publicHealthReport, createHealthBody } from '../server/http/routes.js';
const args=process.argv.slice(2);
const option=(name,fallback,max)=>{
  const i=args.indexOf('--'+name),value=Number(i<0?fallback:args[i+1]);
  if(!Number.isInteger(value)||value<1||value>max)throw Error('invalid --'+name);return value;
};
const rooms=option('rooms',500,10000),reads=option('reads',100000,1000000);
let scans=0,bufferScans=0;
const lobby=Object.assign(Object.create(Lobby.prototype),{
  rooms:new Map(Array.from({length:rooms},(_,i)=>[String(i),{match:i%2?{}:null,
    seats:Array.from({length:4},(_,j)=>({isBot:j===3,left:false})),spectators:[]}])),matchmaking:{entries:new Map()},
});
const originalStats=lobby.stats.bind(lobby);lobby.stats=()=>{scans++;return originalStats();};
// Lobby.stats() and the public report read these collaborators; Object.create skips the constructor.
lobby.roomReclamation={stats:()=>({})};lobby.roomActions={stats:()=>({})};lobby.botPopulation={stats:()=>({})};
const network=Object.assign(Object.create(Network.prototype),{
  conns:new Map(Array.from({length:rooms*4},(_,i)=>[i,{ws:{bufferedAmount:0}}])),
  _outbound:new Map(),_blockedOutbound:new Map(),
});
const originalBuffers=network.bufferedBytes.bind(network);network.bufferedBytes=()=>{bufferScans++;return originalBuffers();};
const health={startedAt:Date.now(),lobby,network,registry:{size:rooms*4}};
// Warm both paths before the timed loops.
healthReport(health);createHealthBody(health)();
const measure=(read)=>{
  scans=0;bufferScans=0;let bytes=0;
  const cpuStart=process.cpuUsage(),start=performance.now();
  for(let i=0;i<reads;i++)bytes+=read().length;
  const elapsedMs=performance.now()-start,cpu=process.cpuUsage(cpuStart);
  return {reads,elapsedMs:+elapsedMs.toFixed(2),cpuMs:(cpu.user+cpu.system)/1000,roomScans:scans,socketScans:bufferScans,bytes};
};
// full: what GET /metrics pays per request — the whole diagnostic report, always collected fresh.
const full=measure(()=>Buffer.from(JSON.stringify(healthReport(health))));
// cached: what GET /healthz pays per read — the public body, one collection per second at most.
const read=createHealthBody(health),cached=measure(read);
const strip=(report)=>{const {uptimeSec:_u,memory:_m,...rest}=report;return rest;};
assert.deepEqual(strip(JSON.parse(read())),strip(publicHealthReport(health)));
// The reused body is the public one: no process diagnostic may reach /healthz (they are /metrics-only).
const publicBody=JSON.parse(read());
for(const key of ['memory','workers','persist','processDiagnostics','socketBuffers','wire','staticCache','stateDelta','chatLog','rehearsalPressure','traffic'])
  assert.ok(!(key in publicBody),`/healthz must not carry ${key}`);
console.log(JSON.stringify({passed:true,node:process.version,rooms,sockets:rooms*4,reads,full,cached,
  cpuReduction:1-cached.cpuMs/full.cpuMs,scope:'health body collection/encoding only; /healthz is the cached public body, /metrics the fresh full one; memory and uptime may change'},null,2));
