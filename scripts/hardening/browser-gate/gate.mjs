// Standalone loopback admission service. Never exposes the game port or its signing key.
import http from 'node:http';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const SIX_HOURS=21600000, CHALLENGE_MS=120000;
const cookieName=req=>req.headers['x-gate-scheme']==='https'?'__Host-sp_browser_gate':'sp_browser_gate';
const escapeHtml=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function createGate({key,bits=18,now=Date.now,banCheck=async()=>204,maxSpent=10000}={}){
  if(!Buffer.isBuffer(key)||key.length<32)throw new Error('Gate signing key must be at least 32 bytes');
  if(!Number.isInteger(bits)||bits<8||bits>22)throw new Error('Invalid proof difficulty');
  const spent=new Map();
  const hmac=s=>createHmac('sha256',key).update(s).digest('base64url');
  const bind=req=>hmac(JSON.stringify([req.headers['x-gate-ip'],req.headers['x-gate-host'],req.headers['x-gate-scheme'],req.headers['user-agent']||'']));
  const seal=value=>{const text=Buffer.from(JSON.stringify(value)).toString('base64url');return text+'.'+hmac(text);};
  function open(token,type,req){
    if(typeof token!=='string'||token.length>2048)return null;
    const [text,mac,...rest]=token.split('.');
    if(!text||!mac||rest.length)return null;
    const expected=Buffer.from(hmac(text)), actual=Buffer.from(mac);
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return null;
    try{const value=JSON.parse(Buffer.from(text,'base64url').toString());
      if(value.v!==1||value.type!==type||value.binding!==bind(req)||!Number.isFinite(value.exp)||value.exp<=now())return null;
      if(value.exp>now()+(type==='proof'?CHALLENGE_MS:SIX_HOURS)+1000)return null;
      return value;
    }catch{return null;}
  }
  const issue=(req)=>seal({v:1,type:'grant',binding:bind(req),exp:now()+SIX_HOURS});
  const cookie=(req)=>`${cookieName(req)}=${issue(req)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=21600${req.headers['x-gate-scheme']==='https'?'; Secure':''}`;
  const reply=(res,status,body='',type='text/plain; charset=utf-8')=>{
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(body);
  };
  async function handler(req,res){
    const ip=req.headers['x-gate-ip'],host=req.headers['x-gate-host'];
    if(!ip||!host||host.length>255||!['http','https'].includes(req.headers['x-gate-scheme']))return reply(res,403);
    const pathname=(req.url||'').split('?')[0];
    if(pathname==='/check'||pathname==='/_gate/status'){
      if(req.method!=='GET')return reply(res,403);
      const original=req.headers['x-gate-original-uri']||'';
      const localHealth=pathname==='/check'&&['127.0.0.1','::1'].includes(ip)&&original.split('?')[0]==='/healthz';
      const name=cookieName(req);
      const tokens=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
      const grant=tokens.length===1?open(tokens[0].slice(name.length+1),'grant',req):null;
      if(!localHealth&&!grant){
        // A dedicated fetch endpoint makes gate failures readable without accepting a WS first.
        // Keep 200 here: inherited nginx error_page handlers would hide a 401 again.
        if(pathname==='/_gate/status'){res.setHeader('X-Gate-Required','1');return reply(res,200);}
        return reply(res,401);
      }
      const status=await banCheck(ip);
      if(status!==204&&status!==200)return reply(res,status===403?403:503);
      // auth_request passes this through on protected HTML, API, health and WS responses.
      if(grant&&grant.exp-now()<SIX_HOURS/2){
        const renewed=cookie(req);
        res.setHeader(pathname==='/_gate/status'?'Set-Cookie':'X-Gate-Renew',renewed);
      }
      return reply(res,204);
    }
    if(req.headers['x-gate-entry']==='1'||pathname==='/_gate/entry'){
      if(req.method!=='GET'&&req.method!=='HEAD')return reply(res,405);
      let target=req.headers['x-gate-original-uri']||'/';
      if(pathname==='/_gate/entry'||!target.startsWith('/')||target.startsWith('//')||target.startsWith('/_gate/')||target.length>2048||/[\x00-\x1f\\]/.test(target))target='/';
      return reply(res,200,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>浏览器验证</title><style>body{background:#10151b;color:#e6edf3;font:18px system-ui;padding:12vh 8vw}button{font:inherit;padding:12px}p{line-height:1.7}</style><body data-next="${escapeHtml(target)}"><h1>进入游戏前验证</h1><p id="status" role="status">正在验证浏览器，请稍候…</p><button id="retry" hidden>重新验证</button><noscript>请启用 JavaScript 后重新打开页面。</noscript><script src="/_gate/assets/entry.js" defer></script></body></html>`,'text/html; charset=utf-8');
    }
    if(pathname==='/_gate/challenge'&&req.method==='GET'){
      return reply(res,200,JSON.stringify({bits,token:seal({v:1,type:'proof',binding:bind(req),
        exp:now()+CHALLENGE_MS,id:randomBytes(16).toString('base64url'),bits})}),'application/json');
    }
    if(pathname==='/_gate/verify'&&req.method==='POST'){
      const origin=req.headers.origin;
      if(origin!==`${req.headers['x-gate-scheme']}://${host}`||req.headers['sec-fetch-site']==='cross-site')return reply(res,403);
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return reply(res,415);
      let length=0,raw='';
      for await(const chunk of req){length+=chunk.length;if(length>4096){reply(res,413);req.destroy();return;}raw+=chunk.toString();}
      let value;try{value=JSON.parse(raw);}catch{return reply(res,400);}
      const proof=open(value?.token,'proof',req),counter=value?.counter;
      if(!proof||proof.bits!==bits||typeof proof.id!=='string'||!Number.isInteger(counter)||counter<0||counter>0xffffffff)return reply(res,403);
      const digest=createHash('sha256').update(value.token+'.'+counter).digest();
      let zero=0;for(const byte of digest){if(byte===0)zero+=8;else{zero+=Math.clz32(byte)-24;break;}}
      if(zero<bits)return reply(res,403);
      for(const [id,exp] of spent){if(exp<=now())spent.delete(id);else break;}
      if(spent.has(proof.id))return reply(res,403);
      if(spent.size>=maxSpent)return reply(res,503);
      // Check persistent bans before issuing admission credentials too.
      const status=await banCheck(ip);
      if(status!==204&&status!==200)return reply(res,status===403?403:503);
      if(spent.has(proof.id))return reply(res,403); // concurrent submissions across the await
      if(spent.size>=maxSpent)return reply(res,503);
      spent.set(proof.id,proof.exp);res.setHeader('Set-Cookie',cookie(req));return reply(res,204);
    }
    const files={'/_gate/assets/entry.js':'entry.js','/_gate/assets/worker.js':'worker.js','/_gate/assets/sha256.js':'sha256.js'};
    if(files[pathname]&&(req.method==='GET'||req.method==='HEAD'))return reply(res,200,readFileSync(new URL(files[pathname],import.meta.url)),'text/javascript; charset=utf-8');
    return reply(res,404);
  }
  const server=http.createServer((req,res)=>{handler(req,res).catch(()=>{if(!res.headersSent)reply(res,503);else res.destroy();});});
  server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=5000;server.maxConnections=256;
  return server;
}
export function backendBanCheck(port=3100){
  return ip=>new Promise(resolve=>{
    const req=http.get({host:'127.0.0.1',port,path:'/_sp/ip-check',headers:{'X-Real-IP':ip,'CF-Connecting-IP':ip,'X-Forwarded-For':ip}},res=>{res.resume();resolve(res.statusCode);});
    req.setTimeout(1500,()=>{req.destroy();resolve(503);});req.on('error',()=>resolve(503));
  });
}

// Cookie signatures/bindings are always checked per request. Only the backend's IP-ban lookup is cached.
// Anchor expiry to lookup START so backend latency cannot extend the allowed staleness.
export function createCachedBanCheck(check,{ttlMs=2000,maxEntries=4096,now=()=>performance.now()}={}){
  if(typeof check!=='function')throw new TypeError('Ban checker is required');
  if(!Number.isInteger(ttlMs)||ttlMs<0||ttlMs>5000)throw new RangeError('Ban cache TTL must be 0..5000 ms');
  if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>100000)throw new RangeError('Invalid ban cache capacity');
  const entries=new Map();
  return async ip=>{
    if(ttlMs===0){try{return await check(ip);}catch{return 503;}}
    const at=now(),previous=entries.get(ip);
    if(previous?.pending)return previous.pending;
    if(previous&&previous.expires>at)return previous.status;
    if(previous)entries.delete(ip);
    if(entries.size>=maxEntries){
      // Never evict pending work: otherwise repeated new sources could defeat coalescing and its bound.
      let victim;
      for(const [key,entry] of entries)if(!entry.pending){victim=key;break;}
      if(victim===undefined)return 503;
      entries.delete(victim);
    }
    const entry={expires:at+ttlMs,status:503,pending:null};
    entries.set(ip,entry);
    entry.pending=Promise.resolve().then(()=>check(ip)).catch(()=>503).then(status=>{
      entry.pending=null;entry.status=status;
      // No stale success on backend failure, and no persistent cached failure that prevents recovery.
      if(![200,204,403].includes(status)||entry.expires<=now())entries.delete(ip);
      return status;
    });
    return entry.pending;
  };
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const key=Buffer.from(process.env.SP_GATE_KEY||'','base64');
  const banCheck=createCachedBanCheck(backendBanCheck(Number(process.env.SP_GATE_GAME_PORT||3100)),
    {ttlMs:Number(process.env.SP_GATE_BAN_CACHE_MS??2000)});
  createGate({key,bits:Number(process.env.SP_GATE_BITS||18),banCheck})
    .listen(Number(process.env.SP_GATE_PORT||3101),'127.0.0.1',()=>process.stdout.write('Browser gate listening on loopback\n'));
}
