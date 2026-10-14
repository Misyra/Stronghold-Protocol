import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthBody, createRequestHandler, healthReport } from '../server/http/routes.js';
import { startServer } from '../server/index.js';
import { RoomActionLimiter } from '../server/roomProtection.js';
import { BotPopulation } from '../server/botPopulation.js';

// The process diagnostics: they describe the host, so they belong to /metrics (loopback/private-network) and
// must never appear in the public /healthz body.
const OPS_FIELDS = ['memory', 'wire', 'socketBuffers', 'persist', 'stateDelta', 'staticCache', 'workers',
  'processDiagnostics', 'chatLog', 'rehearsalPressure', 'traffic'];

function fixture() {
  let scans = 0, workerScans = 0, bufferScans = 0;
  const counts = { rooms: 1, matches: 0, humans: 4, bots: 0, spectators: 0 };
  const health = { startedAt: Date.now() - 10000, registry: { size: 4 },
    network: { connectionCount: 4, bufferedBytes() { bufferScans++; return { total: 12, max: 8 }; },
      diagnostics: { stats: () => ({ marker: 'live' }) } },
    lobby: { rooms: new Map([['room', {}]]), roomActions: new RoomActionLimiter(), botPopulation: new BotPopulation(),
      matchmaking: { entries: new Map() }, stats() { scans++; return { ...counts }; } },
    workerPool: { stats() { workerScans++; return { size: 2, completed: workerScans }; } },
    serveStatic: { version: 'code-tag', runtimeVersion: 'runtime-tag', artVersion: 'art-tag', cacheStats: () => ({ gzipBytes: 9 }) },
    cdn: { base: 'https://assets.example', version: 'cdn-tag' }, assetsManifest: { tag: 'manifest-tag' },
    persister: { writes: 7, failures: 0, matchDocs: new Map(), encoder: { memory: { heapUsed: 42 } } },
    store: { kind: 'file', mode: 'sharded' } };
  return { health, counts, scans: () => scans, workerScans: () => workerScans, bufferScans: () => bufferScans };
}
function response() {
  return { headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers) { this.status = status; for (const [k,v] of Object.entries(headers)) this.setHeader(k,v); },
    end(body) { this.body = body; } };
}

test('health: 10000 stable reads reuse one public collection and encoding, and carry no process diagnostics', () => {
  const f = fixture(); let now = 0;
  const read = createHealthBody(f.health, { now: () => now });
  const first = read();
  for (let i=0;i<10000;i++) assert.equal(read(),first);
  assert.equal(f.scans(),1);
  // The public body must not even collect the diagnostics: no worker stats, no socket-buffer walk.
  assert.equal(f.workerScans(),0); assert.equal(f.bufferScans(),0);
  const report=JSON.parse(first);
  assert.equal(report.build,'code-tag'); assert.equal(report.artVersion,'art-tag');
  assert.equal(report.runtimeVersion, 'runtime-tag');
  assert.equal(report.assetsCdnVersion,'cdn-tag'); assert.equal(report.assetsManifest,'manifest-tag');
  assert.equal(report.sockets,4); assert.equal(report.sessions,4); assert.equal(report.rooms,1); assert.equal(report.humans,4);
  assert.equal(report.roomProtection.createDenied, 0);
  assert.equal(report.botPopulation.maxTotal, 300);
  assert.equal(report.botPopulation.maxForeign, 50);
  for (const field of OPS_FIELDS) assert.ok(!(field in report), `/healthz must not carry ${field}`);
  f.counts.matches=1; f.health.persister.writes=8;
  now=999; assert.equal(read(),first);
  now=1000; const next=JSON.parse(read());
  assert.equal(next.matches,1); assert.equal(f.scans(),2);
  assert.ok(!('persist' in next), '/healthz stays free of the persistence accounting');
});

test('metrics report: a single collection carries every detailed ops field', () => {
  const f=fixture();
  const r=healthReport(f.health);
  assert.equal(f.scans(),1); assert.equal(f.workerScans(),1); assert.equal(f.bufferScans(),1);
  // the public half is shared value for value
  assert.equal(r.build,'code-tag'); assert.equal(r.artVersion,'art-tag'); assert.equal(r.runtimeVersion,'runtime-tag');
  assert.equal(r.assetsCdnVersion,'cdn-tag'); assert.equal(r.assetsManifest,'manifest-tag');
  assert.equal(r.sockets,4); assert.equal(r.sessions,4); assert.equal(r.roomProtection.createDenied,0);
  assert.equal(r.botPopulation.maxTotal,300);
  // and the diagnostics only the operations endpoint serves
  assert.ok(r.memory.rss>0); assert.ok(r.wire.byType);
  assert.deepEqual(r.socketBuffers,{total:12,max:8});
  assert.equal(r.persist.backend,'file'); assert.equal(r.persist.workerMemory.heapUsed,42);
  // the state-sync sampling hook: frames, full/delta split, baseline parses, verification mismatches
  assert.equal(r.stateDelta.frames, 0);
  assert.equal(r.stateDelta.deltaFrames, 0);
  // checkpoint bookkeeping of the persistence version (a stub persister exposes none: null, never undefined)
  assert.equal(r.persist.checkpointsSkipped, null);
  assert.equal(r.persist.versionHoles, null);
  assert.equal(r.staticCache.gzipBytes,9); assert.equal(r.workers.size,2);
});

test('health: sockets/sessions/uptime remain current; expiry uses monotonic time', (t) => {
  t.mock.timers.enable({apis:['Date'],now:10000});
  const f=fixture(); let now=0;
  const read=createHealthBody(f.health,{now:()=>now}); read();
  f.health.network.connectionCount=5; f.health.registry.size=6;
  t.mock.timers.tick(1000);
  let report=JSON.parse(read());
  assert.equal(report.sockets,5); assert.equal(report.sessions,6); assert.equal(report.uptimeSec,11); assert.equal(f.scans(),1);
  t.mock.timers.setTime(1000); read(); assert.equal(f.scans(),1);
  now=1000; read(); assert.equal(f.scans(),2);
});

test('health: room/queue topology invalidates immediately; servers have independent snapshots', () => {
  const a=fixture(),b=fixture(),ra=createHealthBody(a.health,{now:()=>0}),rb=createHealthBody(b.health,{now:()=>0});
  ra(); rb(); a.counts.rooms=2; a.health.lobby.rooms.set('new',{});
  assert.equal(JSON.parse(ra()).rooms,2);
  a.health.lobby.matchmaking.entries.set('p',{}); ra();
  assert.equal(a.scans(),3); assert.equal(b.scans(),1); assert.equal(JSON.parse(rb()).rooms,1);
});

test('health routing: synchronous GET/HEAD, query/absolute URL, no-store and method/size checks', async () => {
  const f=fixture(); let staticCalls=0;
  const handler=createRequestHandler({health:f.health,log:{error:assert.fail},serveStatic:async()=>staticCalls++});
  const get=response(),head=response(),query=response();
  handler({url:'/healthz',method:'GET'},get); handler({url:'/healthz',method:'HEAD'},head);
  handler({url:'/healthz?probe=1',method:'GET'},query);
  assert.equal(get.status,200); assert.equal(head.status,200); assert.equal(head.body,undefined);
  assert.equal(head.headers['content-length'],get.body.length); assert.equal(query.body,get.body);
  assert.equal(head.headers['cache-control'],'no-store'); assert.equal(get.headers['x-content-type-options'],'nosniff');
  assert.equal(f.scans(),1);
  const bad=response(); handler({url:'/healthz',method:'POST'},bad);
  assert.equal(bad.status,405); assert.equal(bad.headers.allow,'GET, HEAD'); assert.equal(f.scans(),1);
  const absolute=response(); handler({url:'http://localhost/healthz?x=2',method:'GET'},absolute);
  await Promise.resolve(); assert.equal(absolute.status,200);
  const long=response(); handler({url:'/healthz?'+ 'a'.repeat(4096),method:'GET'},long);
  await Promise.resolve(); assert.equal(long.status,414);
  const other=response(); handler({url:'/healthz-extra',method:'GET'},other);
  await Promise.resolve(); assert.equal(staticCalls,1);
});

test('build-only health skips diagnostics and keeps GET/HEAD, absolute URLs and no-store semantics', async () => {
  const f = fixture();
  const handler = createRequestHandler({ health: f.health, log: { error: assert.fail }, serveStatic: assert.fail });
  for (const url of ['/healthz?build=1', 'http://localhost/healthz?build=1']) {
    for (const method of ['GET', 'HEAD']) {
      const res = response(); handler({ url, method }, res); await Promise.resolve();
      assert.equal(res.status, 200); assert.equal(res.headers['cache-control'], 'no-store');
      if (method === 'GET') assert.deepEqual(JSON.parse(res.body), { build: 'code-tag' });
      else assert.equal(res.body, undefined);
    }
  }
  assert.equal(f.scans(), 0); assert.equal(f.workerScans(), 0); assert.equal(f.bufferScans(), 0);
  const bad = response(); handler({ url: '/healthz?build=1', method: 'POST' }, bad); assert.equal(bad.status, 405);
  const full = response(); handler({ url: '/healthz', method: 'GET' }, full);
  assert.equal(JSON.parse(full.body).build, 'code-tag');
  assert.ok(!('memory' in JSON.parse(full.body)), '/healthz is the public body');
  const ops = response(); handler({ url: '/metrics', method: 'GET' }, ops);
  assert.equal(ops.status, 200); assert.ok(JSON.parse(ops.body).memory.rss > 0);
});

test('metrics is loopback/private-network only: every other caller falls through to the static handler', async () => {
  const f = fixture(); let staticCalls = 0;
  const handler = createRequestHandler({ health: f.health, log: { error: assert.fail },
    serveStatic: async () => { staticCalls++; } });
  const call = async (req) => { const res = response(); handler({ url: '/metrics', method: 'GET', ...req }, res);
    await Promise.resolve(); return res; };
  // a public visitor: the route does not exist for them, and nothing is collected
  const pub = await call({ socket: { remoteAddress: '203.0.113.9' } });
  assert.equal(pub.status, null); assert.equal(staticCalls, 1); assert.equal(f.scans(), 0); assert.equal(f.workerScans(), 0);
  // the host itself, and the private networks it sits in, get the diagnostics
  const loop = await call({ socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(loop.status, 200); assert.ok(JSON.parse(loop.body).memory.rss > 0);
  const lan = await call({ socket: { remoteAddress: '10.1.2.3' } });
  assert.equal(lan.status, 200); assert.equal(JSON.parse(lan.body).workers.size, 2);
  // a tunnel/proxy on this machine forwards a public client: still public, still gated
  const tunnel = await call({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '2001:db8::7' } });
  assert.equal(tunnel.status, null); assert.equal(staticCalls, 2);
  const proxied = await call({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.4' } });
  assert.equal(proxied.status, null); assert.equal(staticCalls, 3);
});

test('metrics: fresh detailed collections do not read or replace the cached health snapshot', async () => {
  const f=fixture();
  const handler=createRequestHandler({health:f.health,log:{error:assert.fail},serveStatic:assert.fail});
  const first=response(); handler({url:'/healthz',method:'GET'},first);
  f.counts.matches=1;
  for(const method of ['GET','HEAD']) {
    const res=response(); handler({url:'/metrics',method},res); await Promise.resolve();
    assert.equal(res.status,200); assert.equal(res.headers['cache-control'],'no-store');
    if(method==='GET') { const m=JSON.parse(res.body); assert.equal(m.matches,1); assert.equal(m.websocket.diagnostics.marker,'live'); }
    else assert.equal(res.body,undefined);
  }
  assert.equal(f.scans(),3);
  const cached=response(); handler({url:'/healthz',method:'GET'},cached);
  assert.equal(cached.body,first.body); assert.equal(f.scans(),3);
  assert.ok(!('memory' in JSON.parse(cached.body)), 'the cached snapshot is the public body');
  const bad=response(); handler({url:'/metrics',method:'POST'},bad); await Promise.resolve(); assert.equal(bad.status,405);
});

test('failed collection returns 500 and retries; stale success is never substituted', () => {
  const f=fixture(); const stats=f.health.lobby.stats; let fail=true,logged=0;
  f.health.lobby.stats=()=>{if(fail)throw Error('unavailable');return stats();};
  const handler=createRequestHandler({health:f.health,serveStatic:assert.fail,log:{error:()=>logged++}});
  const bad=response();handler({url:'/healthz',method:'GET'},bad);assert.equal(bad.status,500);assert.equal(logged,1);
  fail=false;const good=response();handler({url:'/healthz',method:'GET'},good);assert.equal(good.status,200);
  let now=0;const read=createHealthBody(f.health,{now:()=>now});read();now=1000;fail=true;
  assert.throws(read,/unavailable/);fail=false;assert.ok(read());
});

test('real HTTP: health stays public, metrics carries the operations metadata and network diagnostics', async (t) => {
  const srv=await startServer({host:'127.0.0.1',port:0,quiet:true,workers:0,store:null,announcementFile:null});
  t.after(()=>srv.close());
  const diag=srv.network.diagnostics;
  diag.received('ping',6,2);diag.intervals.settle();
  const h=await (await fetch(srv.url+'/healthz')).json();
  assert.equal(h.ok,true);
  assert.equal(typeof h.sockets,'number'); assert.equal(typeof h.rooms,'number'); assert.equal(typeof h.build,'string');
  for(const field of OPS_FIELDS) assert.ok(!(field in h), `/healthz must not carry ${field}`);
  const m=await (await fetch(srv.url+'/metrics')).json();
  assert.ok(m.memory.rss>0);assert.ok(m.wire.byType);assert.equal(m.workers,null);assert.equal(m.persist,null);
  assert.equal(m.build,h.build);assert.equal(m.websocket.diagnostics.period,'sinceStart');
  assert.equal(m.websocket.diagnostics.eventLoop.resolutionMs,20);
  assert.ok(Number.isFinite(m.websocket.diagnostics.eventLoop.p95Ms));
  assert.ok(m.websocket.diagnostics.processCpu.userSeconds>=0&&m.websocket.diagnostics.processCpu.systemSeconds>=0);
  assert.equal(m.websocket.diagnostics.handlerMs.ping.sumMs,2);
  assert.equal(m.websocket.diagnostics.handlerMs.ping.buckets.at(-1).leMs,'+Inf');
  assert.equal(m.websocket.diagnostics.handlerMs.ping.buckets.at(-1).count,1);
  const latest=m.processDiagnostics.latest;assert.ok(latest);
  const util=latest.eventLoop.utilization;
  assert.ok(util==null||(util>=0&&util<=1));
  assert.ok(latest.processCpuDelta&&Number.isFinite(latest.processCpuDelta.userSeconds)&&Number.isFinite(latest.processCpuDelta.systemSeconds));
  const head=await fetch(srv.url+'/metrics',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('failed snapshot encoding does not advance expiry or serve an older success on the next request', () => {
  const f=fixture();let now=0;const read=createHealthBody(f.health,{now:()=>now});read();
  // Poison a PUBLIC field (sessions is re-stamped from the live registry on every read): the encoding fails, so
  // the refresh must neither commit nor advance the expiry.
  f.health.registry.size=1n;now=1000;
  assert.throws(read,/BigInt/);assert.throws(read,/BigInt/);
  f.health.registry.size=4;f.counts.matches=1;
  assert.equal(JSON.parse(read()).matches,1);assert.equal(f.scans(),4);
});
