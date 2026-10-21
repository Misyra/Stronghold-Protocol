/* global importScripts, self, Date */
importScripts('/_gate/assets/sha256.js');
// Progress is reported against the expected work for this difficulty (2^bits hashes on
// average) and is capped at 99 so it never claims completion. The cap below stays under the
// server's 120s proof lifetime: a proof that outlives the window is rejected anyway.
const LIMIT_MS=100000;
self.onmessage=({data})=>{
  const start=Date.now(), {token,bits}=data, target=2**bits;
  let shown=0;
  for(let counter=0;counter<=0xffffffff;counter++){
    const digest=self.spSha256(token+'.'+counter);
    let zero=0;
    for(const byte of digest){if(byte===0)zero+=8;else{zero+=Math.clz32(byte)-24;break;}}
    if(zero>=bits){self.postMessage({counter});return;}
    if(counter%4096===0){
      const percent=Math.min(99,Math.floor(counter/target*100));
      if(percent>shown){shown=percent;self.postMessage({progress:percent});}
      if(Date.now()-start>LIMIT_MS){self.postMessage({error:'验证超时，请重试'});return;}
    }
  }
  self.postMessage({error:'验证未完成，请重试'});
};
