/* global importScripts, self */
importScripts('/_gate/assets/sha256.js');
self.onmessage = ({data}) => {
  const start=Date.now(), {token,bits}=data;
  for(let counter=0;counter<=0xffffffff;counter++){
    const digest=self.spSha256(token+'.'+counter);
    let zero=0;
    for(const byte of digest){if(byte===0)zero+=8;else{zero+=Math.clz32(byte)-24;break;}}
    if(zero>=bits){self.postMessage({counter});return;}
    if(counter%8192===0 && Date.now()-start>100000){self.postMessage({error:'验证超时，请重试'});return;}
  }
  self.postMessage({error:'验证未完成，请重试'});
};
