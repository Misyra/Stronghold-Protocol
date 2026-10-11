export const REQUEST_BATCH_FIELDS = ['httpRequests','httpAborts','httpErrors','httpRateLimited','httpTimeouts','httpRandomNoRoom','httpHealthErrors','httpTimingCount','httpP95Ms','httpP99Ms','httpMaxMs','httpCacheHits','httpCacheMisses','httpManifestP99Ms','httpRoomsP99Ms','httpUpstreamP99Ms','httpRandomJoined','httpRandomBusy','httpRandomUnavailable','httpRandomLimited','httpRandomTimedOut'];
export const REQUEST_MINUTE_FIELDS = [...REQUEST_BATCH_FIELDS.map(k => 'httpMinute' + k.slice(4)), 'httpMinuteStartedAt', 'httpMinuteEndedAt'];
export const REQUEST_DIAGNOSTICS = [...REQUEST_BATCH_FIELDS, ...REQUEST_MINUTE_FIELDS];
const limits=[1,2,5,10,20,50,100,200,300,500,750,1000,2000,5000,10000,30000,60000,Infinity];
const histogram=()=>({count:0,max:0,buckets:Array(limits.length).fill(0)});
const record=(h,value)=>{h.count++;h.max=Math.max(h.max,value);h.buckets[limits.findIndex(n=>value<=n)]++;};
const percentile=(h,p)=>{if(!h.count)return null;let n=0;for(let i=0;i<limits.length;i++){n+=h.buckets[i];if(n>=Math.ceil(h.count*p))return Math.min(limits[i],h.max);}return h.max;};
export function parseAccessLine(line) {
  // Keep compatibility with old combined prefixes. Optional metadata is parsed
  // only AFTER both quoted referer and UA, never from user-controlled headers.
  const m=/^(\S+) \S+ \S+ \[[^\]]+\] "([^"]*)" (\d{3}) (\d+|-)(.*)$/.exec(line);
  if(!m)return null;
  const route=(m[2].split(' ')[1]||'').split('?')[0];
  const suffix=/^ "(?:[^"\\]|\\.)*" "(?:[^"\\]|\\.)*"(.*)$/.exec(m[5]);
  const metadata=suffix?.[1]||'';
  const timing=/(?:^| )rt=(\d+(?:\.\d+)?)(?: |$)/.exec(metadata);
  const cache=/(?:^| )cache=(HIT|MISS|BYPASS|EXPIRED|STALE|UPDATING|REVALIDATED|-)(?: |$)/.exec(metadata);
  const upstream=/(?:^| )urt=([0-9.,: -]+?)(?= [a-z_]+=|$)/.exec(metadata);
  const upstreamMs=upstream?.[1].split(/[,:]/).map(v=>!v.trim() || v.trim()==='-'?null:Number(v.trim())*1000).filter(v=>Number.isFinite(v))||[];
  const reason=/(?:^| )reason=(NO_ROOM|ROOM_CHECK_BUSY|ROOM_CHECK_UNAVAILABLE|ROOM_CHECK_LIMIT|ROOM_CHECK_TIMEOUT)(?: |$)/.exec(metadata)?.[1] || null;
  return {reason, at: accessTime(line), ip:m[1],route,status:Number(m[3]),bytes:Number(m[4])||0,requestMs:timing?Number(timing[1])*1000:null,cache:cache?.[1]||null,upstreamMs};
}
export class RequestDiagnostics {
 constructor(){this.values=Object.fromEntries(REQUEST_BATCH_FIELDS.map(k=>[k,0]));this.all=histogram();this.manifest=histogram();this.rooms=histogram();this.upstream=histogram();}
 ingest(row){
  if(!row || /^\/(?:api\/(?:admin|panel)|monitor|internal)(?:\/|$)/.test(row.route))return;
  const s=this.values;s.httpRequests++;
  if(row.status===499)s.httpAborts++;if(row.status>=500)s.httpErrors++;
  if(row.status===429)s.httpRateLimited++;if(row.status===504)s.httpTimeouts++;
  if(row.route==='/api/rooms/random'){
   if(row.status===404)s.httpRandomNoRoom++;if(row.status===200)s.httpRandomJoined++;
   const key={ROOM_CHECK_BUSY:'httpRandomBusy',ROOM_CHECK_UNAVAILABLE:'httpRandomUnavailable',ROOM_CHECK_LIMIT:'httpRandomLimited',ROOM_CHECK_TIMEOUT:'httpRandomTimedOut'}[row.reason];if(key)s[key]++;
  }
  if(row.route==='/healthz'&&row.status>=400)s.httpHealthErrors++;
  if(row.cache==='HIT'||row.cache==='REVALIDATED')s.httpCacheHits++;
  if(row.cache==='MISS'||row.cache==='EXPIRED')s.httpCacheMisses++;
  // WebSockets report connection lifetime, not handshake/request latency.
  if(row.status===101 || /^\/ws(?:\/|$)/.test(row.route))return;
  for(const value of row.upstreamMs || []) if(value>=0)record(this.upstream,value);
  if(typeof row.requestMs==='number' && Number.isFinite(row.requestMs) && row.requestMs>=0){
   record(this.all,row.requestMs);
   if(row.route==='/data/resource-manifest.json')record(this.manifest,row.requestMs);
   if(row.route==='/api/rooms'||row.route==='/api/rooms/random')record(this.rooms,row.requestMs);
  }
 }
 snapshot(ok=true){
  if(!ok)return Object.fromEntries(REQUEST_BATCH_FIELDS.map(k=>[k,null]));
  return {...this.values,httpTimingCount:this.all.count,httpP95Ms:percentile(this.all,.95),httpP99Ms:percentile(this.all,.99),httpMaxMs:this.all.count?this.all.max:null,httpManifestP99Ms:percentile(this.manifest,.99),httpRoomsP99Ms:percentile(this.rooms,.99),httpUpstreamP99Ms:percentile(this.upstream,.99)};
 }
}

const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function accessTime(line) {
 const m=/\[(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)\]/.exec(line);
 if(!m)return null;const month=months.indexOf(m[2])+1;if(!month)return null;
 const at=Date.parse(m[3]+'-'+String(month).padStart(2,'0')+'-'+m[1]+'T'+m[4]+m[5]+':'+m[6]);
 return Number.isFinite(at)?at:null;
}
// Minute totals follow log event time, not the collector's processing time. The
// atomic DailyStats frame persists these buckets with the same consumed cursor.
export class RequestMinutes {
 constructor({now=Date.now,state=null,retainedMinutes=180,flushGraceMs=10000}={}) {
  Object.assign(this,{now,retainedMinutes,flushGraceMs});this.buckets=new Map();this.dirty=new Set();this.lastPublished=null;
  const at=now();this.coverageStart=Math.ceil(at/60000)*60000;
  if(state?.version===1 && Number.isSafeInteger(state.coverageStart) && state.coverageStart%60000===0 && state.coverageStart<=at) {
   this.coverageStart=state.coverageStart;
   let invalidState = !Array.isArray(state.buckets);
   for(const item of (Array.isArray(state.buckets)?state.buckets:[]).slice(-retainedMinutes)) {
    if(!Number.isSafeInteger(item?.t)||item.t%60000||item.t>at+10000){invalidState=true;continue;}
    if(item.t<at-retainedMinutes*60000)continue;
    const d=new RequestDiagnostics();let valid=true;
    for(const key of REQUEST_BATCH_FIELDS){if(!Number.isFinite(item.values?.[key])||item.values[key]<0){valid=false;break;}}
    for(const key of ['all','manifest','rooms','upstream']){
     const h=item[key];if(!h||!Number.isSafeInteger(h.count)||h.count<0||!Number.isFinite(h.max)||h.max<0||!Array.isArray(h.buckets)||h.buckets.length!==limits.length||h.buckets.some(n=>!Number.isSafeInteger(n)||n<0)||h.buckets.reduce((a,b)=>a+b,0)!==h.count){valid=false;break;}
     d[key]={count:h.count,max:h.max,buckets:[...h.buckets]};
    }
    if(valid){d.values=Object.fromEntries(REQUEST_BATCH_FIELDS.map(k=>[k,item.values[k]]));this.buckets.set(item.t,d);this.dirty.add(item.t);} else invalidState=true;
   }
   if(invalidState)this.invalidate(at);
  }
 }
 invalidate(at=this.now()) {this.coverageStart=Math.ceil(at/60000)*60000;this.buckets.clear();this.dirty.clear();this.lastPublished=null;}
 ingest(row) {
  const now=this.now();if(!Number.isFinite(row?.at)||row.at<this.coverageStart||row.at>now+10000||row.at<now-this.retainedMinutes*60000)return;
  const t=Math.floor(row.at/60000)*60000;
  if(!this.buckets.has(t))this.buckets.set(t,new RequestDiagnostics());
  this.buckets.get(t).ingest(row);this.dirty.add(t);this.prune(now);
 }
 prune(now=this.now()) {for(const t of this.buckets.keys())if(t<now-this.retainedMinutes*60000)this.buckets.delete(t);for(const t of this.dirty)if(t<now-this.retainedMinutes*60000)this.dirty.delete(t);}
 snapshot({ok=true,backlogBytes=0,now=this.now()}={}) {
  const empty=Object.fromEntries(REQUEST_MINUTE_FIELDS.map(k=>[k,null]));
  const start=Math.floor((now-this.flushGraceMs)/60000)*60000-60000;
  if(!ok||backlogBytes!==0||start<this.coverageStart)return empty;
  const values=(this.buckets.get(start)||new RequestDiagnostics()).snapshot();
  return {...Object.fromEntries(Object.entries(values).map(([k,v])=>['httpMinute'+k.slice(4),v])),httpMinuteStartedAt:start,httpMinuteEndedAt:start+60000};
 }
 updates(options={}) {
  const latest=this.snapshot(options);if(latest.httpMinuteStartedAt===null)return [];
  const now=options.now??this.now(), target=latest.httpMinuteStartedAt;
  const first=Math.max(this.coverageStart,Math.ceil((now-this.retainedMinutes*60000)/60000)*60000,(this.lastPublished??this.coverageStart-60000)+60000);
  for(let t=first;t<=target;t+=60000)this.dirty.add(t);
  const out=[...this.dirty].filter(t=>t>=this.coverageStart&&t<=target).sort((a,b)=>a-b).slice(-this.retainedMinutes).map(t=>{
   const values=(this.buckets.get(t)||new RequestDiagnostics()).snapshot();this.dirty.delete(t);
   return {...Object.fromEntries(Object.entries(values).map(([k,v])=>['httpMinute'+k.slice(4),v])),httpMinuteStartedAt:t,httpMinuteEndedAt:t+60000};
  });this.lastPublished=target;return out;
 }
 serialize() {
  this.prune();return {version:1,coverageStart:this.coverageStart,buckets:[...this.buckets].sort(([a],[b])=>a-b).slice(-this.retainedMinutes).map(([t,d])=>({t,values:{...d.values},...Object.fromEntries(['all','manifest','rooms','upstream'].map(k=>[k,{...d[k],buckets:[...d[k].buckets]}]))}))};
 }
}
