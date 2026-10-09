// Actual Bot economy/layout/rehearsal/flush under legacy timers vs the shared CPU queue.
// node tools/bench-cooperative.mjs --variant legacy|cooperative --matches 32 --rehearsal 3 --clients 16
// Test fixture holds real prepared matches at PREP R7 with a fixed game clock; combat rehearsal is real.
// Worker disabled to exercise the local CPU path. Real WS ping requests run in a separate process.
// Not a full-match capacity test; no render, production users, TLS or persistent writes.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { startServer } from '../server/index.js';
import { RealScheduler } from '../server/match/scheduler.js';
import { makeMatch } from '../test/match/harness.js';
import { botPrepBegin } from '../server/match/bot.js';
import { Battle } from '../server/sim/Battle.js';
import { matchState } from '../server/match/snapshot.js';
import { TestClient } from '../test/helpers/wsClient.js';
const args=process.argv.slice(2);
const arg=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
const variant=arg('variant','cooperative'),matches=Number(arg('matches',32)),rehearsal=Number(arg('rehearsal',3)),clients=Number(arg('clients',16));
if(!['legacy','cooperative'].includes(variant)||![matches,clients].every(n=>Number.isInteger(n)&&n>0&&n<=256)
  ||!Number.isInteger(rehearsal)||rehearsal<1||rehearsal>8)throw Error('invalid benchmark options');
const distribution=values=>{
  values.sort((a,b)=>a-b);const p=q=>values.length?+values[Math.ceil(values.length*q)-1].toFixed(2):null;
  return {count:values.length,p50:p(.5),p95:p(.95),p99:p(.99),max:values.length?+values.at(-1).toFixed(2):null};
};
if(args.includes('--server')) {
  const srv=await startServer({host:'127.0.0.1',port:0,quiet:true,workers:0,store:null,announcementFile:null,
    ratePerSec:2000,rateBurst:2000,wsCompression:true});
  const games=[];
  const prepare=seed=>{
    const h=makeMatch({mode:'solo',humans:1,seed,fake:true,botRehearsal:0,captureFrames:false,
      script:()=>({duration:2,leaks:{},bossDps:1e9})});
    h.start();
    for(let r=1;r<=6;r++){h.toPrep(r);botPrepBegin(h.m,h.m.order[0]);}
    h.toPrep(7);h.sched.dispose();h.m._timers.clear();
    // Real scheduling, fixed gameplay time for exact A/B fingerprints and no phase deadlines.
    h.m.sched=new RealScheduler({now:()=>h.sched.now(),onError:e=>h.m.reportError('timer',e)});h.m.ownsScheduler=true;
    if(variant==='legacy')h.m.sched.setWork=undefined;
    h.m.BattleClass=Battle;h.m.botRehearsal=rehearsal;h.m.botSliceMs=2;h.m.timerScale=0;
    h.m.workerPool=null;h.m.maybeEndPrep=()=>{};h.m.order[0].autoplay=true;
    return h;
  };
  const run=async list=>{
    for(const h of list)h.m.scheduleBotPrep(h.m.order[0]);
    const end=Date.now()+90000;
    while(list.some(h=>!h.m.order[0].ready)){
      if(Date.now()>end)throw Error('Bot work timeout');await delay(5);
    }
  };
  process.send({port:srv.port});
  process.on('message',async msg=>{
    try {
      if(msg.prepare){
        const warm=prepare(999);await run([warm]);warm.m.dispose();
        for(let i=0;i<matches;i++)games.push(prepare(700+i));
        process.send({prepared:true});
      }else if(msg.run){
        const start=performance.now(),cpuStart=process.cpuUsage();
        await run(games);
        const cpu=process.cpuUsage(cpuStart),elapsedMs=performance.now()-start;
        const errors=games.reduce((n,h)=>n+h.m.errorCount,0);
        const stateHash=createHash('sha256').update(JSON.stringify(games.map(h=>matchState(h.m)))).digest('hex');
        process.send({done:true,elapsedMs,cpuMs:(cpu.user+cpu.system)/1000,errors,stateHash,
          completed:games.filter(h=>h.m.order[0].ready).length,diagnostics:srv.network.diagnostics.stats()});
      }else if(msg.close){
        for(const h of games)h.m.dispose();await srv.close();process.disconnect();
      }
    }catch(e){process.send({error:e.stack});}
  });
}else{
  const child=fork(fileURLToPath(import.meta.url),[...args,'--server'],{stdio:['ignore','ignore','inherit','ipc']});
  const sockets=[],pings=[];let running=false,failures=0;
  const wait=predicate=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.off('message',receive);reject(Error('child timeout'));},120000);
    const receive=msg=>{if(msg.error||predicate(msg)){clearTimeout(timer);child.off('message',receive);if(msg.error)reject(Error(msg.error));else resolve(msg);}};
    child.on('message',receive);
  });
  const command=(msg,predicate)=>{const p=wait(predicate);child.send(msg);return p;};
  try{
    const {port}=await wait(msg=>msg.port);
    for(let i=0;i<clients;i++){const c=await TestClient.connect('ws://127.0.0.1:'+port+'/ws');await c.hello('probe'+i);sockets.push(c);}
    await command({prepare:true},msg=>msg.prepared);
    running=true;
    const probes=sockets.map(async c=>{
      while(running){
        const start=performance.now();
        try{await c.request({t:'ping',c:Date.now()});pings.push(performance.now()-start);}catch{failures++;}
        await delay(20);
      }
    });
    const stats=await command({run:true},msg=>msg.done);running=false;await Promise.all(probes);
    const passed=failures===0&&stats.errors===0&&stats.completed===matches;
    if(!passed)process.exitCode=1;
    console.log(JSON.stringify({passed,node:process.version,variant,matches,rehearsal,clients,sliceMs:2,
      failures,pingMs:distribution(pings),server:stats},null,2));
  }finally{
    running=false;for(const c of sockets)c.terminate();
    if(child.connected)child.send({close:true});
    const timer=setTimeout(()=>child.kill(),10000);
    await new Promise(resolve=>{child.once('exit',resolve);if(child.exitCode!==null)resolve();});clearTimeout(timer);
  }
}
