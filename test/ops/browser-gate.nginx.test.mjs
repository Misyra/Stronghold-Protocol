// Opt in: NGINX_PATH=<binary> [CHROME_PATH=<chrome>] node --test this-file
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createGate} from '../../scripts/hardening/browser-gate/gate.mjs';
import {WebSocketServer,WebSocket} from 'ws';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('real Nginx checks admission before static files, cache, API and WS; real browser computes proof',
  {skip:!process.env.NGINX_PATH,timeout:60000},async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-browser-gate-')),prefix=dir.replaceAll('\\','/')+'/';
    fs.mkdirSync(path.join(dir,'logs'));fs.mkdirSync(path.join(dir,'cache'));fs.mkdirSync(path.join(dir,'temp'));fs.writeFileSync(path.join(dir,'icon.svg'),'<svg/>');
    let banned=false,hits=0,clock=Date.now();
    const gate=createGate({key:randomBytes(32),bits:16,now:()=>clock,banCheck:async()=>banned?403:204});
    t.after(()=>gate.close());
    const gatePort=await listen(gate);
    const backend=http.createServer((req,res)=>{hits++;res.setHeader('Content-Type','text/html; charset=utf-8');res.end('GAME_OK');});
    t.after(()=>backend.close());
    const ws=new WebSocketServer({server:backend});ws.on('connection',socket=>socket.send('WELCOME'));
    const backendPort=await listen(backend), portProbe=net.createServer(),port=await listen(portProbe);await new Promise(r=>portProbe.close(r));
    let snippet=fs.readFileSync(new URL('../../scripts/hardening/sp-browser-gate.conf',import.meta.url),'utf8');
    // The gate snippet owns neither public preload manifest; a deployment without the shared cache
    // installs this server-level snippet instead. Using it here also proves the split works.
    snippet+='\n'+fs.readFileSync(new URL('../../scripts/hardening/sp-public-manifests.conf',import.meta.url),'utf8');
    const main=fs.readFileSync(new URL('../../scripts/nginx.conf.example',import.meta.url),'utf8');
    snippet+='\n'+main.match(/location = \/api\/ping \{[\s\S]*?\n        \}/)[0];
    snippet+='\n'+main.match(/location ~ \^\/api\/rooms[\s\S]*?\n        \}/)[0];
    snippet=snippet.replaceAll('127.0.0.1:3101',`127.0.0.1:${gatePort}`).replaceAll('127.0.0.1:3000',`127.0.0.1:${backendPort}`).replaceAll('X-Gate-IP $remote_addr','X-Gate-IP 114.114.114.114');
    const map=['sp-browser-gate-map.conf','sp-public-api-map.conf','sp-business-limit-map.conf']
      .map(name=>fs.readFileSync(new URL('../../scripts/hardening/'+name,import.meta.url),'utf8')).join('\n');
    fs.writeFileSync(path.join(dir,'nginx.conf'),`worker_processes 1;pid nginx.pid;error_log logs/error.log notice;
events {worker_connections 128;} http {map_hash_bucket_size 64;${map}
proxy_cache_path "${prefix}cache" keys_zone=gate_cache:1m;
server {listen 127.0.0.1:${port}; server_name localhost;auth_request /_sp/gate-check;
set_real_ip_from 127.0.0.1;real_ip_header X-Test-IP;limit_req_status 444;
error_page 403 = @banned;location @banned {auth_request off;return 444;}
${snippet}
location = /icon.svg {root "${prefix}";}
location = /healthz {proxy_pass http://127.0.0.1:${backendPort};proxy_cache gate_cache;proxy_cache_valid 200 5s;add_header X-Cache $upstream_cache_status;add_header Set-Cookie $sp_gate_renew always;}
location / {proxy_pass http://127.0.0.1:${backendPort};proxy_http_version 1.1;proxy_set_header Upgrade $http_upgrade;proxy_set_header Connection upgrade;}
}}`);
    const checked=spawnSync(process.env.NGINX_PATH,['-p',prefix,'-c','nginx.conf','-t'],{encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr);
    const child=spawn(process.env.NGINX_PATH,['-p',prefix,'-c','nginx.conf','-g','daemon off;'],{stdio:'ignore'});
    t.after(async()=>{spawnSync(process.env.NGINX_PATH,['-p',prefix,'-c','nginx.conf','-s','quit']);child.kill();gate.close();ws.clients.forEach(s=>s.terminate());ws.close();backend.close();await delay(200);fs.rmSync(dir,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${port}`;
    for(let i=0;i<50;i++){try{await fetch(base+'/_gate/entry');break;}catch{await delay(50);}}
    async function raw(uri,extra='',method='GET'){
      return await new Promise((resolve,reject)=>{let output='';const socket=net.connect(port,'127.0.0.1',()=>socket.write(`${method} ${uri} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extra}\r\n`));socket.on('data',chunk=>output+=chunk);socket.on('end',()=>resolve(output));socket.on('error',reject);socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('socket timeout'));});});
    }
    for(const uri of ['/healthz','/icon.svg','/api/nickname/validate','/ws'])assert.equal(await raw(uri), '',uri);
    const required=await fetch(base+'/_gate/status');
    assert.equal(required.status,200);assert.equal(required.headers.get('x-gate-required'),'1');
    assert.equal(required.headers.get('set-cookie'),null);
    assert.equal(await raw('/_gate/status','','POST'),'');
    for(const uri of ['/resource-sw.js?v=test','/manifest.json','/js/resources/common.js','/js/resources/workerManifest.js','/js/resources/readThrough.js','/shared/i18n.js','/shared/i18nPacks.js','/shared/resourcePaths.js','/data/resource-manifest.json?v=test'])
      assert.match(await raw(uri),/^HTTP\/1\.1 200/,`${uri} is public bootstrap data`);
    assert.match(await raw('/_sp/gate-check'),/^HTTP\/1.1 404/);
    assert.equal(await raw('/healthz','X-Gate-IP: 127.0.0.1\r\nX-Gate-Entry: 1\r\n'),'');
    assert.equal(hits,9,'public bootstrap requests alone reached the backend');hits=0;
    const page=await fetch(base+'/?room=abc',{headers:{Accept:'text/html'}});assert.match(await page.text(),/进入游戏前验证/);assert.equal(hits,0);
    // An in-app WebView sends `Accept: */*` for a top-level navigation and only Sec-Fetch-Mode
    // identifies it; without that the request used to be dropped with 444 and looked like a hang.
    // Raw sockets, because fetch() overwrites Sec-Fetch-Mode with "cors" for script requests.
    assert.match(await raw('/?room=wv','Accept: */*\r\nSec-Fetch-Mode: navigate\r\n'),/^HTTP\/1\.1 200/,'a WebView navigation gets the page');
    assert.equal(hits,0);
    assert.equal(await raw('/?room=wv','Accept: */*\r\n'),'','a script GET with a wide Accept is still dropped');
    for(const uri of ['/resource-sw.js?v=test','/manifest.json','/js/resources/common.js','/js/resources/workerManifest.js','/js/resources/readThrough.js','/shared/i18n.js','/shared/i18nPacks.js','/shared/resourcePaths.js','/data/resource-manifest.json?v=test']){
      const response=await fetch(base+uri);assert.equal(response.status,200,uri);assert.equal(await response.text(),'GAME_OK');
    }
    assert.equal(hits,9,'only explicit public bootstrap paths bypass the gate; the manifest is uncached here');
    assert.match(await raw('/api/ping'),/^HTTP\/1\.1 200/,'portal ping needs no browser cookie');
    assert.match(await raw('/api/ping','','HEAD'),/^HTTP\/1\.1 200/);
    assert.equal(await raw('/api/ping','','POST'),'');
    assert.equal(await raw('/api/rooms/AAAA/status'),'','room lookup still needs the browser gate');
    const portalIp='X-Test-IP: 203.0.113.55\r\n';
    for(let i=0;i<16;i++)assert.match(await raw('/api/ping',portalIp),/^HTTP\/1\.1 200/);
    assert.equal(await raw('/api/ping',portalIp),'','a public ping flood exhausts its own burst');
    const headers={'User-Agent':'GateTest'};
    const proof=await(await fetch(base+'/_gate/challenge',{headers})).json();
    let counter=0;while(createHash('sha256').update(proof.token+'.'+counter).digest().readUInt32BE(0)>=65536)counter++;
    const verify=await fetch(base+'/_gate/verify',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token:proof.token,counter})});
    assert.equal(verify.status,204);headers.Cookie=verify.headers.get('set-cookie').split(';')[0];
    assert.equal(await(await fetch(base+'/icon.svg',{headers})).text(),'<svg/>');
    assert.equal((await fetch(base+'/healthz',{headers})).headers.get('x-cache'),'MISS');
    assert.equal((await fetch(base+'/healthz',{headers})).headers.get('x-cache'),'HIT');
    assert.equal((await fetch(base+'/_gate/status',{headers})).status,204);
    clock+=11000000;
    for(const uri of ['/','/healthz']){
      const renewed=await fetch(base+uri,{headers});
      assert.match(renewed.headers.get('set-cookie'),/sp_browser_gate=/,uri);
    }
    const renewedProbe=await fetch(base+'/_gate/status',{headers});
    assert.match(renewedProbe.headers.get('set-cookie'),/sp_browser_gate=/);
    assert.equal(renewedProbe.headers.get('x-gate-renew'),null);
    assert.equal(await raw('/healthz'),'');
    assert.equal(await(await fetch(base+'/api/nickname/validate',{method:'POST',headers,body:'{}'})).text(),'GAME_OK');
    const client=new WebSocket(base.replace('http:','ws:')+'/ws',{headers});
    let upgraded;
    client.once('upgrade',response=>{upgraded=response.headers;});
    assert.equal(await new Promise((resolve,reject)=>{client.once('message',d=>resolve(d.toString()));client.once('error',reject);}),'WELCOME');client.terminate();
    assert.ok(upgraded['set-cookie']?.some(cookie=>cookie.includes('sp_browser_gate=')));
    banned=true;assert.equal(await raw('/healthz',`Cookie: ${headers.Cookie}\r\nUser-Agent: GateTest\r\n`),'');banned=false;
    if(process.env.CHROME_PATH){
      const {default:puppeteer}=await import('puppeteer-core');
      const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});
      try{
        const page=await browser.newPage(),errors=[];
        page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});page.on('pageerror',error=>errors.push(error.message));
        await page.goto(base+'/?room=browser#test');
        try{await page.waitForFunction(()=>document.body.textContent==='GAME_OK',{timeout:15000});}
        catch(error){throw new Error(`${error.message}; body=${await page.evaluate(()=>document.body.textContent)}; errors=${errors.join('; ')}`);}
        assert.match(page.url(),/room=browser#test/);assert.ok((await page.cookies()).some(c=>c.name==='sp_browser_gate'&&c.httpOnly));
      }finally{await browser.close();}
    }
    await new Promise(r=>gate.close(r));assert.match(await raw('/healthz'),/^HTTP\/1.1 500/);
  });
