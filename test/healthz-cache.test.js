import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthBody, createRequestHandler } from '../server/http/routes.js';
import { startServer } from '../server/index.js';

function fixture() {
  let scans = 0, workerScans = 0, bufferScans = 0;
  const counts = { rooms: 1, matches: 0, humans: 4, bots: 0, spectators: 0 };
  const health = { startedAt: Date.now() - 10000, registry: { size: 4 },
    network: { connectionCount: 4, bufferedBytes() { bufferScans++; return { total: 12, max: 8 }; },
      diagnostics: { stats: () => ({ marker: 'live' }) } },
    lobby: { rooms: new Map([['room', {}]]), matchmaking: { entries: new Map() }, stats() { scans++; return { ...counts }; } },
    workerPool: { stats() { workerScans++; return { size: 2, completed: workerScans }; } },
    serveStatic: { version: 'code-tag', artVersion: 'art-tag', cacheStats: () => ({ gzipBytes: 9 }) },
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

test('health: 10000 stable reads reuse one full collection and encoding; detailed ops fields survive', () => {
  const f = fixture(); let now = 0;
  const read = createHealthBody(f.health, { now: () => now });
  const first = read();
  for (let i=0;i<10000;i++) assert.equal(read(),first);
  assert.equal(f.scans(),1); assert.equal(f.workerScans(),1); assert.equal(f.bufferScans(),1);
  const report=JSON.parse(first);
  assert.equal(report.build,'code-tag'); assert.equal(report.artVersion,'art-tag');
  assert.equal(report.assetsCdnVersion,'cdn-tag'); assert.equal(report.assetsManifest,'manifest-tag');
  assert.ok(report.memory.rss>0); assert.ok(report.wire.byType);
  assert.deepEqual(report.socketBuffers,{total:12,max:8});
  assert.equal(report.persist.backend,'file'); assert.equal(report.persist.workerMemory.heapUsed,42);
  assert.equal(report.staticCache.gzipBytes,9); assert.equal(report.workers.size,2);
  f.counts.matches=1; f.health.persister.writes=8;
  now=999; assert.equal(read(),first);
  now=1000; const next=JSON.parse(read());
  assert.equal(next.matches,1); assert.equal(next.persist.writes,8); assert.equal(f.scans(),2);
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
  assert.equal(JSON.parse(full.body).build, 'code-tag'); assert.ok(JSON.parse(full.body).memory.rss > 0);
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

test('real HTTP: health keeps operations metadata, metrics exposes per-instance network diagnostics', async (t) => {
  const srv=await startServer({host:'127.0.0.1',port:0,quiet:true,workers:0,store:null,announcementFile:null});
  t.after(()=>srv.close());
  const h=await (await fetch(srv.url+'/healthz')).json();
  assert.ok(h.memory.rss>0);assert.ok(h.wire.byType);assert.equal(h.workers,null);assert.equal(h.persist,null);
  const m=await (await fetch(srv.url+'/metrics')).json();
  assert.equal(m.build,h.build);assert.equal(m.websocket.diagnostics.period,'sinceStart');
  assert.equal(m.websocket.diagnostics.eventLoop.resolutionMs,20);
  assert.ok(Number.isFinite(m.websocket.diagnostics.eventLoop.p95Ms));
  const head=await fetch(srv.url+'/metrics',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('failed snapshot encoding does not advance expiry or serve an older success on the next request', () => {
  const f=fixture();let now=0;const read=createHealthBody(f.health,{now:()=>now});read();
  const good=f.health.workerPool.stats;f.health.workerPool.stats=()=>({bad:1n});now=1000;
  assert.throws(read,/BigInt/);assert.throws(read,/BigInt/);
  f.health.workerPool.stats=good;f.counts.matches=1;
  assert.equal(JSON.parse(read()).matches,1);assert.equal(f.scans(),4);
});
