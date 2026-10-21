/* global document, Worker, location, performance, setInterval, clearInterval, fetch */
const status=document.getElementById('status'), button=document.getElementById('retry');
let running=false, timer=0;

// nginx may refuse with 429 (rate limit) or drop the connection outright. Neither reaches the
// player as a readable message unless this file says it: fetch() only reports "Failed to fetch".
const offline=()=>new Error('连接被中断（可能被限流），请稍候重试');
const limited=code=>code===429?'验证请求过于频繁，请等候一分钟再试':'验证入口繁忙，请稍后重试';

async function verify(){
  if(running)return;
  running=true;button.hidden=true;status.textContent='正在验证浏览器，请稍候…';
  let worker;
  try{
    const challenge=await fetch('/_gate/challenge',{cache:'no-store',credentials:'same-origin'}).catch(()=>{throw offline();});
    if(!challenge.ok)throw Object.assign(new Error(), {status: challenge.status});
    const proof=await challenge.json();

    // The proof token expires 120s after issue, so the elapsed clock is the honest status:
    // a slow device that will time out can be told so before it wastes the whole window.
    const started=performance.now();
    timer=setInterval(()=>{
      status.textContent=`正在验证浏览器… ${Math.round((performance.now()-started)/1000)}s`;
    },500);

    worker=new Worker('/_gate/assets/worker.js');
    const counter=await new Promise((resolve,reject)=>{
      worker.onmessage=({data})=>{
        if(data.error)return reject(new Error(data.error));
        if(typeof data.progress==='number'){status.textContent=`正在验证浏览器… ${data.progress}%`;return;}
        resolve(data.counter);
      };
      worker.onerror=()=>reject(new Error('浏览器无法运行验证，请更新浏览器后重试'));
      worker.postMessage(proof);
    });
    clearInterval(timer);timer=0;

    const response=await fetch('/_gate/verify',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({token:proof.token,counter})}).catch(()=>{throw offline();});
    if(!response.ok)throw Object.assign(new Error(), {status: response.status});

    // The grant cookie is HttpOnly, so document.cookie cannot see it. Ask the gate instead:
    // a browser that stored nothing answers X-Gate-Required and would otherwise loop forever
    // between this page and the 401 it is supposed to resolve.
    const probe=await fetch('/_gate/status',{cache:'no-store',credentials:'same-origin'}).catch(()=>null);
    if(probe&&probe.headers.get('x-gate-required'))
      throw new Error('浏览器没有保存验证凭据（Cookie 被拦截）。请允许本站 Cookie，或换用系统浏览器打开。');

    status.textContent='验证通过，正在进入游戏…';
    const target=document.body.dataset.next||'/';
    const next=target+(target.includes('#')?'':location.hash);
    if(new URL(next,location.href).href===location.href)location.reload();
    else location.replace(next);
  }catch(error){
    if(timer)clearInterval(timer);
    timer=0;
    status.textContent=error.status?limited(error.status):(error.message||'验证失败，请重试');
    button.hidden=false;
  }finally{worker?.terminate();running=false;}
}
button.addEventListener('click',verify);verify();
