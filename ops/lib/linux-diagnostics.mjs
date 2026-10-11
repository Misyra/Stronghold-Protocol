import fs from 'node:fs';
export const LINUX_DIAGNOSTICS = ['gameMainThreadCpuPct','gameWorkerCpuPct','gameNvcsw','gameNvcswPerSec','tcpRetransPct','tcpSynRetrans','tcpFastRetransPct','netErrRxPct','netDropRxPct'];
export function procStat(text) {
  const end = text.lastIndexOf(')'); if (end < 0) return null;
  const f = text.slice(end + 1).trim().split(/\s+/);
  const ticks = Number(f[11]) + Number(f[12]), start = Number(f[19]);
  return Number.isFinite(ticks) && Number.isFinite(start) ? {ticks,start} : null;
}
export function procCounters(text) {
  const out = {}; const lines = text.trim().split(/\r?\n/);
  for (let i=0; i+1<lines.length; i+=2) {
    const keys=lines[i].trim().split(/\s+/), values=lines[i+1].trim().split(/\s+/);
    if (keys[0] !== values[0]) continue;
    keys.slice(1).forEach((key,n)=>{const value=Number(values[n+1]);if(Number.isFinite(value))out[keys[0].replace(':','')+key]=value;});
  }
  return out;
}
export class LinuxDiagnostics {
  constructor({read = p => fs.readFileSync(p,'utf8'), list = p => fs.readdirSync(p), ticksPerSec = null} = {}) {
    this.read=read; this.list=list; this.ticksPerSec=ticksPerSec; this.previous=null;
  }
  sample({pid, iface, now=Date.now()}) {
    const out=Object.fromEntries(LINUX_DIAGNOSTICS.map(k=>[k,null]));
    out.gameThreadsCpuTop=null;
    const safe=fn=>{try{return fn();}catch{return null;}};
    const threads=new Map();
    const main=pid ? safe(()=>procStat(this.read('/proc/'+pid+'/stat'))) : null;
    if(main) for(const tid of (safe(()=>this.list('/proc/'+pid+'/task')) || [])) {
      const stat=safe(()=>procStat(this.read('/proc/'+pid+'/task/'+tid+'/stat')));
      if(stat)threads.set(String(tid),stat);
    }
    const status=main ? safe(()=>this.read('/proc/'+pid+'/status')) : null;
    const match=status && /^nonvoluntary_ctxt_switches:\s+(\d+)/m.exec(status);
    const nvcsw=match ? Number(match[1]) : null;
    out.gameNvcsw=nvcsw;
    const snmp=safe(()=>procCounters(this.read('/proc/net/snmp')));
    const ext=safe(()=>procCounters(this.read('/proc/net/netstat')));
    const net={...snmp,...ext};
    const dev=safe(()=>this.read('/proc/net/dev'));
    const line=dev?.split('\n').find(l=>l.slice(0,l.indexOf(':')).trim()===iface);
    const f=line?.slice(line.indexOf(':')+1).trim().split(/\s+/).map(Number);
    const rx=f?.length>=4 ? {packets:f[1],errors:f[2],drops:f[3]} : null;
    const current={now,pid,start:main?.start,threads,nvcsw,net,rx};
    const old=this.previous;this.previous=current;
    const dt=old ? (now-old.now)/1000 : 0;
    if(dt<=0)return out;
    const delta=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&a>=b?a-b:null;
    if(main && old.pid===pid && old.start===main.start) {
      if(this.ticksPerSec>0) {
        let worker=0,workerCount=0;const top=[];
        for(const [tid,stat] of threads) {
          const prior=old.threads.get(tid);if(!prior || stat.start!==prior.start)continue;
          const ticks=delta(stat.ticks,prior.ticks);if(ticks==null)continue;
          const pct=ticks/this.ticksPerSec/dt*100;
          const name=safe(()=>this.read('/proc/'+pid+'/task/'+tid+'/comm').trim().replace(/[^a-zA-Z0-9 _.-]/g,'').slice(0,32)) || (tid===String(pid)?'main':'worker');
          top.push({name,cpuPct:pct});
          if(tid===String(pid))out.gameMainThreadCpuPct=pct;else {worker+=pct;workerCount++;}
        }
        out.gameThreadsCpuTop=top.length?top.sort((a,b)=>b.cpuPct-a.cpuPct).slice(0,3):null;
        out.gameWorkerCpuPct=workerCount || threads.size===1 ? worker : null;
      }
      const n=delta(nvcsw,old.nvcsw);out.gameNvcswPerSec=n==null?null:n/dt;
    }
    const sent=delta(net.TcpOutSegs,old.net.TcpOutSegs);
    for(const [key,counter] of [['tcpRetransPct','TcpRetransSegs'],['tcpFastRetransPct','TcpExtTCPFastRetrans']]) {
      const n=delta(net[counter],old.net[counter]);out[key]=sent>0&&n!=null?n/sent*100:null;
    }
    out.tcpSynRetrans=delta(net.TcpExtTCPSynRetrans,old.net.TcpExtTCPSynRetrans);
    const packets=delta(rx?.packets,old.rx?.packets);
    for(const [key,counter] of [['netErrRxPct','errors'],['netDropRxPct','drops']]) {
      const n=delta(rx?.[counter],old.rx?.[counter]);out[key]=packets>0&&n!=null?n/packets*100:null;
    }
    return out;
  }
}
