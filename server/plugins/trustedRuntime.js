import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/** Experimental activate(api) bridge. IPC carries copies, never live lobby/session objects. */
export async function createTrustedRuntime({registry,log}) {
  const plugins = registry.plugins('trusted').filter(p => p.status === 'loaded' && p.manifest.entry.server)
    .map(p => ({id:p.id,hash:p.script.lockHash,manifestSource:p.script.manifestSource,sources:p.script.sources}));
  if (!plugins.length) return null;
  const child = fork(fileURLToPath(new URL('./trustedEntry.js',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc'],execArgv:['--max-old-space-size=128']});
  const routes = new Set(), health = {}, pending = new Map(); let seq = 0;
  let readyResolve;
  const ready = new Promise(r => {readyResolve=r;});
  const timer = setTimeout(() => {log.warn('[plugins] trusted server activation timed out');child.kill();readyResolve(false);},5000);
  const send = m => { if (child.connected) child.send(m); };
  child.on('message',m => {
    if (m.type === 'route') routes.add(m.route);
    if (m.type === 'health') health[m.id]=m.value;
    if (m.type === 'ready') {clearTimeout(timer);readyResolve(true);}
    if (m.type === 'error') {log.warn('[plugins] trusted server: '+m.message); if (!m.id) {clearTimeout(timer);readyResolve(false);}}
    if (m.id && pending.has(m.id)) {pending.get(m.id)(m.type === 'error' ? {error:m.message} : m.value);pending.delete(m.id);}
  });
  child.on('error',e => {log.warn('[plugins] trusted server: '+e.message);readyResolve(false);});
  child.on('exit',() => {clearTimeout(timer);routes.clear();for (const r of pending.values()) r({error:'plugin stopped'});pending.clear();readyResolve(false);});
  send({type:'init',plugins});
  if (!await ready) {child.kill();return null;}
  return {
    health,
    event:(event,value) => send({type:'event',event,value:JSON.parse(JSON.stringify(value))}),
    async route(req,res) {
      const pathname = new URL(req.url,'http://localhost').pathname;
      if (!routes.has(pathname)) return false;
      const id = ++seq;
      const value = await new Promise(resolve => {
        const timer = setTimeout(() => {pending.delete(id);resolve({error:'plugin request timed out'});},5000);
        pending.set(id,v => {clearTimeout(timer);resolve(v);});
        send({type:'http',id,request:{method:req.method,path:pathname,url:req.url}});
      });
      res.writeHead(value?.error ? 502 : 200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify(value)); return true;
    },
    close() {child.kill();},
  };
}
