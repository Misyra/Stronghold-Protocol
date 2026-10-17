/* global document, Worker, location */
const status=document.getElementById('status'), button=document.getElementById('retry');
let running=false;
async function verify(){
  if(running)return;running=true;button.hidden=true;status.textContent='正在验证浏览器，请稍候…';
  let worker;
  try{
    const challenge=await fetch('/_gate/challenge',{cache:'no-store',credentials:'same-origin'});
    if(!challenge.ok)throw new Error('验证入口繁忙，请稍后重试');
    const proof=await challenge.json();worker=new Worker('/_gate/assets/worker.js');
    const counter=await new Promise((resolve,reject)=>{
      worker.onmessage=({data})=>data.error?reject(new Error(data.error)):resolve(data.counter);
      worker.onerror=()=>reject(new Error('浏览器无法运行验证，请更新浏览器后重试'));
      worker.postMessage(proof);
    });
    const response=await fetch('/_gate/verify',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({token:proof.token,counter})});
    if(!response.ok)throw new Error('验证失效或过于频繁，请稍后重试');
    status.textContent='验证通过，正在进入游戏…';
    const target=document.body.dataset.next||'/';
    const next=target+(target.includes('#')?'':location.hash);
    if(new URL(next,location.href).href===location.href)location.reload();
    else location.replace(next);
  }catch(error){status.textContent=error.message||'验证失败，请重试';button.hidden=false;}
  finally{worker?.terminate();running=false;}
}
button.addEventListener('click',verify);verify();
