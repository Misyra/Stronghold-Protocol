import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createGate,createCachedBanCheck,backendBanCheck} from '../../scripts/hardening/browser-gate/gate.mjs';
import http from 'node:http';

const context=vm.createContext({self:{},TextEncoder,Uint8Array,DataView,Math});
vm.runInContext(readFileSync(new URL('../../scripts/hardening/browser-gate/sha256.js',import.meta.url),'utf8'),context);
test('worker SHA-256 agrees with node for padding boundaries and Unicode',()=>{
  for(const text of ['', 'abc','中文','a'.repeat(55),'a'.repeat(56),'a'.repeat(63),'a'.repeat(64),'a'.repeat(500),randomBytes(1000).toString('hex')])
    assert.equal(Buffer.from(context.self.spSha256(text)).toString('hex'),createHash('sha256').update(text).digest('hex'));
});

test('ban lookups merge concurrent requests, expire from lookup start, and never reuse expired success on failure',async()=>{
  let clock=0,calls=0,status=204,release;
  const cached=createCachedBanCheck(async()=>{calls++;await new Promise(r=>{release=r;});return status;},{now:()=>clock});
  const pending=Array.from({length:25},()=>cached('114.114.114.114'));
  await Promise.resolve();assert.equal(calls,1);
  clock=1500;release();assert.deepEqual(await Promise.all(pending),Array(25).fill(204));
  clock=1999;assert.equal(await cached('114.114.114.114'),204);assert.equal(calls,1);
  clock=2000;status=403;const changed=cached('114.114.114.114');await Promise.resolve();release();assert.equal(await changed,403);assert.equal(calls,2);
  clock=4000;status=503;const failure=cached('114.114.114.114');await Promise.resolve();release();assert.equal(await failure,503);
  status=204;const recovered=cached('114.114.114.114');await Promise.resolve();release();assert.equal(await recovered,204);assert.equal(calls,4);
});

test('ban cache bounds in-flight work, handles rejected lookups, and can be disabled',async()=>{
  const releases=[];let calls=0;
  const cached=createCachedBanCheck(()=>{calls++;return new Promise(r=>releases.push(r));},{maxEntries:2});
  const a=cached('a'),b=cached('b');await Promise.resolve();
  assert.equal(await cached('c'),503);assert.equal(calls,2);
  releases.forEach(r=>r(204));await Promise.all([a,b]);
  const c=cached('c');await Promise.resolve();releases[2](403);assert.equal(await c,403);
  let attempts=0;
  const fails=createCachedBanCheck(()=>{attempts++;throw new Error('unavailable');});
  assert.equal(await fails('a'),503);assert.equal(await fails('a'),503);assert.equal(attempts,2);
  let uncached=0;const disabled=createCachedBanCheck(async()=>{uncached++;return 204;},{ttlMs:0});
  await disabled('a');await disabled('a');assert.equal(uncached,2);
  for(const ttlMs of [-1,5001,NaN,1.5])assert.throws(()=>createCachedBanCheck(async()=>204,{ttlMs}),RangeError);
});

test('signed business cookie is checked on every request while 100 requests use one game ban lookup',async t=>{
  let clock=100000000,hits=0,status=204;
  const backend=http.createServer((req,res)=>{hits++;assert.equal(req.url,'/_sp/ip-check');setTimeout(()=>{res.writeHead(status);res.end();},10);});
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>backend.close(r)));
  const banCheck=createCachedBanCheck(backendBanCheck(backend.address().port),{now:()=>clock});
  const gate=createGate({key:randomBytes(32),bits:8,now:()=>clock,banCheck});
  await new Promise(r=>gate.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>gate.close(r)));
  const base=`http://127.0.0.1:${gate.address().port}`;
  const headers={'X-Gate-IP':'114.114.114.114','X-Gate-Host':'game.example.com','X-Gate-Scheme':'https','User-Agent':'BusinessTokenTest'};
  const proof=await(await fetch(base+'/_gate/challenge',{headers})).json();
  let counter=0;while(createHash('sha256').update(proof.token+'.'+counter).digest()[0]!==0)counter++;
  const grant=await fetch(base+'/_gate/verify',{method:'POST',headers:{...headers,Origin:'https://game.example.com','Content-Type':'application/json'},body:JSON.stringify({token:proof.token,counter})});
  assert.equal(grant.status,204);const cookie=grant.headers.get('set-cookie').split(';')[0];
  clock+=2000;const before=hits;
  const check=extra=>fetch(base+'/check',{headers:{...headers,Cookie:cookie,'X-Gate-Original-URI':'/assets/file',...extra}});
  const batch=await Promise.all(Array.from({length:100},()=>check()));
  assert.ok(batch.every(res=>res.status===204));assert.equal(hits-before,1);
  for(const extra of [{Cookie:''},{Cookie:cookie+'x'},{'X-Gate-IP':'223.5.5.5'},{'X-Gate-Host':'other.example'},{'User-Agent':'other'}])
    assert.equal((await check(extra)).status,401);
  assert.equal(hits-before,1,'invalid tokens are rejected locally even when a good IP result is cached');
  status=403;clock+=2000;assert.equal((await check()).status,403);
  status=503;clock+=2000;assert.equal((await check()).status,503);
  assert.equal((await check()).status,503,'backend failure does not extend a previous success');
});
test('admission proof, replay, binding, expiration, renewal, bans and fail-closed',async t=>{
  let clock=100000000,status=204,calls=0;
  const gate=createGate({key:randomBytes(32),bits:8,now:()=>clock,banCheck:async()=>{calls++;return status;}});
  await new Promise(r=>gate.listen(0,'127.0.0.1',r));t.after(()=>gate.close());
  const base=`http://127.0.0.1:${gate.address().port}`;
  const defaults={'X-Gate-IP':'114.114.114.114','X-Gate-Host':'game.example.com','X-Gate-Scheme':'https','User-Agent':'TestBrowser'};
  const request=(url,opts={})=>fetch(base+url,{...opts,headers:{...defaults,...opts.headers}});
  assert.equal((await request('/check')).status,401);assert.equal(calls,0);
  const proof=await(await request('/_gate/challenge')).json();
  let counter=0;while(createHash('sha256').update(proof.token+'.'+counter).digest()[0]!==0)counter++;
  const submit=(headers={},token=proof.token)=>request('/_gate/verify',{method:'POST',headers:{Origin:'https://game.example.com','Content-Type':'application/json',...headers},body:JSON.stringify({token,counter})});
  assert.equal((await submit({Origin:'https://evil.example'})).status,403);
  assert.equal((await submit({'X-Gate-IP':'8.8.8.8'})).status,403);
  assert.equal((await submit({},proof.token+'a')).status,403);
  const verified=await submit();assert.equal(verified.status,204);
  assert.match(verified.headers.get('set-cookie'),/^__Host-sp_browser_gate=.*HttpOnly; SameSite=Lax; Max-Age=21600; Secure/);
  const cookie=verified.headers.get('set-cookie').split(';')[0];
  assert.equal((await submit()).status,403);
  const check=(headers={})=>request('/check',{headers:{Cookie:cookie,'X-Gate-Original-URI':'/ws',...headers}});
  assert.equal((await check()).status,204);
  const probe=(headers={})=>request('/_gate/status',{headers:{Cookie:cookie,...headers}});
  assert.equal((await probe()).status,204);
  for(const headers of [{Cookie:''},{Cookie:cookie+'x'},{'X-Gate-IP':'8.8.8.8'}]){
    const response=await probe(headers);
    assert.equal(response.status,200);assert.equal(response.headers.get('x-gate-required'),'1');
    assert.equal(response.headers.get('set-cookie'),null,'failure never mints admission');
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  for(const headers of [{'X-Gate-IP':'8.8.8.8'},{'X-Gate-Host':'other.example'},{'X-Gate-Scheme':'http',Cookie:cookie.replace('__Host-','')},{'User-Agent':'curl'}, {Cookie:cookie+'a'}, {Cookie:cookie+'; '+cookie}])
    assert.equal((await check(headers)).status,401);
  status=403;assert.equal((await check()).status,403);
  assert.equal((await probe()).status,403);
  status=503;assert.equal((await check()).status,503);assert.equal((await probe()).status,503);status=204;
  clock+=11000000;
  for(const uri of ['/healthz?build=1','/','/api/announcement','/ws']){
    const renewal=await check({'X-Gate-Original-URI':uri});
    assert.equal(renewal.status,204);assert.match(renewal.headers.get('x-gate-renew'),/sp_browser_gate=/,uri);
  }
  const renewed=await probe();
  const renewedCookie=renewed.headers.get('set-cookie').split(';')[0];
  assert.equal(renewed.status,204);assert.equal(renewed.headers.get('x-gate-renew'),null,'HttpOnly token is not exposed to JS');
  clock+=11000000;assert.equal((await check()).status,401);
  assert.equal((await probe()).headers.get('x-gate-required'),'1');
  assert.equal((await probe({Cookie:renewedCookie})).status,204,'renewed cookie survives the original expiry');
  assert.equal((await submit()).status,403);
  assert.equal((await request('/check',{headers:{'X-Gate-IP':'127.0.0.1','X-Gate-Original-URI':'/healthz'}})).status,204);
  assert.equal((await request('/check',{headers:{'X-Gate-IP':'127.0.0.1','X-Gate-Original-URI':'/ws'}})).status,401);
  const page=await request('/somewhere?room=abc',{headers:{'X-Gate-Entry':'1','X-Gate-Original-URI':'//evil.example'}});
  assert.match(await page.text(),/data-next="\/"/);
  assert.equal((await request('/_gate/assets/../../gate.mjs')).status,404);
  assert.equal((await request('/_gate/check')).status,404);
});
