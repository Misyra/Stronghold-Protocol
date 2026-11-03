import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validHostMessage,HOST_IPC_LIMITS,boundedJson,isEncodedFrame,encodedFrameMessage} from '../../server/match/host/ipc.js';
import {MatchProxy} from '../../server/match/host/proxy.js';
import {createMatchHosts} from '../../server/match/host/index.js';
import {scriptSet} from '../helpers/simHostFixture.js';
import {fileURLToPath} from 'node:url';

test('IPC limits and shape: logs, errors, match-only frames, replies and non-JSON payloads',()=>{
  const id='TEST-0-1',base={matchId:id};
  assert.ok(validHostMessage({type:'log',level:'info',text:'x'.repeat(HOST_IPC_LIMITS.log)}));
  for(const m of [
    {type:'log',level:'constructor',text:'bad'}, {type:'log',level:'info',text:{}},
    {type:'log',level:'info',text:'界'.repeat(1400)}, {type:'boot-error',error:'x'.repeat(301)},
    {...base,type:'send',playerId:{},msg:{t:'m.public'}}, {...base,type:'broadcast',msg:{t:'room.closed'}},
    {...base,type:'send',playerId:'p',msg:[]}, {...base,type:'reply',id:'1',result:{ok:true}},
    {...base,type:'reply',id:1,result:{error:[]}},{...base,type:'reply',id:1,result:{ok:'yes'}},
    {...base,type:'reply',id:1,result:{text:'x'.repeat(HOST_IPC_LIMITS.reply)}},
    {...base,type:'broadcast',msg:{t:'b.ev',text:'x'.repeat(HOST_IPC_LIMITS.message)}}])assert.equal(validHostMessage(m),false);
  const cycle={};cycle.self=cycle;assert.equal(boundedJson(cycle,1024),false);
  assert.equal(boundedJson({get evil(){throw Error('must not read');}},1024),false);
  assert.equal(boundedJson({fn(){}},1024),false);
  assert.equal(boundedJson({x:Infinity},1024),false);
  assert.ok(validHostMessage({...base,type:'broadcast',msg:{t:'b.ev',ev:[[1,2,3]]}}));
});

test('pre-encoded state lanes: the string alone passes the gate at object strength, the parse yields the frame',()=>{
  const id='TEST-0-2',base={matchId:id};
  const bytes=JSON.stringify({t:'m.public',phase:'BUILD',round:1,players:[]});
  assert.ok(isEncodedFrame({...base,type:'broadcast',encoded:bytes}));
  assert.ok(validHostMessage({...base,type:'broadcast',encoded:bytes}));
  assert.ok(validHostMessage({...base,type:'send',playerId:'p',encoded:bytes}));
  // the view object rides beside nothing: a msg beside the string, a non-string, a missing matchId are refused
  for(const m of [
    {...base,type:'broadcast',encoded:bytes,msg:{t:'m.public'}},
    {...base,type:'broadcast',encoded:123},
    {...base,type:'broadcast',encoded:null},
    {...base,type:'broadcast',encoded:{}},
    {type:'broadcast',encoded:bytes},
    {...base,type:'send',playerId:'p',encoded:bytes,msg:null}])assert.equal(validHostMessage(m),false,JSON.stringify(m).slice(0,80));
  assert.equal(validHostMessage({...base,type:'broadcast',encoded:'x'.repeat(HOST_IPC_LIMITS.message+1)}),false);
  // the consumer's parse: a plain object with a match frame type, anything else null (same gate the object's t had)
  assert.deepEqual(encodedFrameMessage(bytes),{t:'m.public',phase:'BUILD',round:1,players:[]});
  for(const bad of ['{"t":"room.closed"}','{"t":"m.public"','123','"str"','[{"t":"m.public"}]','null','{}','{"t":123}']) {
    assert.equal(encodedFrameMessage(bad),null,`encodedFrameMessage(${bad})`);
  }
});

test('MatchProxy delivers a pre-encoded frame as (parsed msg, original bytes); corrupt or foreign frames are dropped',()=>{
  const frames=[];
  const p=new MatchProxy({matchId:'one',host:{post:()=>{}},opts:{send:(id,m,e)=>frames.push(['send',id,m,e]),broadcast:(m,e)=>frames.push(['b',m,e]),onEnd(){}},requestTimeoutMs:1000});
  const bytes=JSON.stringify({t:'m.public',phase:'BUILD',round:1});
  p.deliver({type:'broadcast',matchId:'one',encoded:bytes});
  assert.deepEqual(frames[0],['b',{t:'m.public',phase:'BUILD',round:1},bytes]);
  p.deliver({type:'send',matchId:'one',playerId:'p_1',encoded:'{"t":"m.private","funds":1}'});
  assert.deepEqual(frames[1],['send','p_1',{t:'m.private',funds:1},'{\"t\":\"m.private\",\"funds\":1}']);
  p.deliver({type:'broadcast',matchId:'one',encoded:'{"t":"m.public"'}); // truncated JSON: past the caps, dropped at the parse
  p.deliver({type:'broadcast',matchId:'one',encoded:'{"t":"room.closed"}'}); // not a match frame
  p.deliver({type:'broadcast',matchId:'one',encoded:'[{"t":"m.public"}]'}); // not an object
  p.deliver({type:'broadcast',matchId:'two',encoded:bytes}); // another match's frame
  assert.equal(frames.length,2);
});

test('MatchProxy independently rejects bad payloads; malformed replies cannot settle another request',async t=>{
  const frames=[],sent=[];
  const p=new MatchProxy({matchId:'one',host:{post:m=>sent.push(m)},opts:{send:(_id,m)=>frames.push(m),broadcast:m=>frames.push(m),onEnd(){}},requestTimeoutMs:1000});
  t.after(()=>p.halt());
  const answer=p.handle('p',{t:'g.ready'}),id=sent[0].id;
  p.deliver({type:'reply',matchId:'two',id,result:{ok:true}});
  p.deliver({type:'reply',matchId:'one',id,result:{ok:'invalid'}});
  assert.equal(p.pending.size,1);
  p.deliver({type:'broadcast',matchId:'one',msg:{t:'room.closed'}});assert.equal(frames.length,0);
  p.deliver({type:'send',matchId:'one',playerId:'p',msg:{t:'m.toast',text:'ok'}});assert.equal(frames.length,1);
  p.deliver({type:'reply',matchId:'one',id,result:{ok:true}});assert.deepEqual(await answer,{ok:true});
});

test('parent receiver rejects forged log/boot-error/send/reply IPC before logger and proxy',async t=>{
  const set=scriptSet('export default () => {};','trusted',{bonds:{}});
  const files={bonds:Buffer.from(JSON.stringify(set.data.bonds))},lines=[],frames=[];
  const hosts=createMatchHosts({contents:{get:()=>set,dataBytes:()=>files},log:{info:x=>lines.push(x),warn:x=>lines.push(x),error:x=>lines.push(x)},
    options:{matchModule:fileURLToPath(new URL('../../server/match/StubMatch.js',import.meta.url))}});t.after(()=>hosts.close());
  const p=hosts.create(set.cs,{roomCode:'TEST',seats:[],send:(_id,m)=>frames.push(m),broadcast:m=>frames.push(m),onEnd(){}});
  const host=hosts._host(set.cs),before=lines.length;
  host.onMessage({type:'log',level:'info',text:'x'.repeat(4001)});
  host.onMessage({type:'boot-error',error:'x'.repeat(301)});
  host.onMessage({type:'send',matchId:p.matchId,playerId:'p',msg:{t:'room.closed'}});
  const answer=p.handle('p',{t:'g.ready'});
  host.onMessage({type:'reply',matchId:p.matchId,id:1,result:[]});
  assert.equal(lines.length,before);assert.equal(host.dead,null);assert.equal(frames.length,0);assert.equal(p.pending.size,1);
  host.onMessage({type:'reply',matchId:p.matchId,id:1,result:{ok:true}});assert.deepEqual(await answer,{ok:true});
  host.onMessage({type:'log',level:'info',text:'accepted'});assert.match(lines.at(-1),/accepted$/);
});
