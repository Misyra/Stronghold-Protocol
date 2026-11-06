// SP_E2E=1 CHROME_PATH=... node --test test/ui/n18-difficulty.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, OUT, hasChrome } from '../e2e/client.mjs';
const enabled = process.env.SP_E2E === '1' && hasChrome();

test('N18 fixed presets, integer quantity, independent random caps and guest read-only settings', {skip:!enabled,timeout:180000}, async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'n18-e2e-'));
  fs.cpSync(new URL('../../docs/examples/n18-duel/',import.meta.url),path.join(tmp,'n18-duel'),{recursive:true});
  const {startServer}=await import('../../server/index.js');
  const srv=await startServer({port:0,host:'127.0.0.1',quiet:true,pluginsDir:tmp,assetIndex:false,matchHost:{matchOptions:{timerScale:0.2,botRehearsal:0}}});
  const P=(await import('puppeteer-core')).default;
  const host=new Client(P,srv.url,'host',{prefix:'n18',w:1600,h:1000});
  const guest=new Client(P,srv.url,'guest',{prefix:'n18',w:1280,h:720});
  const base='[data-plugin="n18-duel"]';
  const sel=k=>`${base} [data-setting="${k}"]`;
  const open = async c => {
    await c.open();
    await c.page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await c.page.reload({waitUntil:'domcontentloaded'});
  };
  try {
    await open(host);await host.enter('凯尔希');const {code}=await host.createCoop();
    await open(guest);await guest.enter('阿米娅');await guest.click('.mode-card','同盟模拟');await guest.click('.join-row input');await guest.page.keyboard.type(code);await guest.click('.join-row button','加入同盟');
    await host.click('[data-testid="plugin-tag"]');
    await host.page.waitForSelector(`${base} [role="switch"]`);
    await host.page.click(`${base} [role="switch"]`);
    await host.page.waitForSelector(sel('n18Preset'));
    assert.equal(await host.page.$eval(sel('fixed_count'),e=>e.step),'1');
    await host.page.select(sel('n18Preset'),'3');
    assert.equal(await host.page.$eval(sel('fixed_hp'),e=>e.value),'3');
    await host.page.click(sel('fixed_count'),{count:3});await host.page.type(sel('fixed_count'),'3');
    assert.equal(await host.page.$eval(sel('n18Preset'),e=>e.value),'-1');
    await host.page.select(sel('n18Mode'),'1');
    await host.page.waitForSelector(sel('limit_count'));
    assert.equal(await host.page.$eval(sel('limit_count'),e=>e.value),'1');
    await host.page.click(sel('limit_count'),{count:3});await host.page.type(sel('limit_count'),'3');
    await host.page.click(sel('n18MaxTerms'),{count:3});await host.page.type(sel('n18MaxTerms'),'2');
    await host.page.select(sel('n18Mode'),'0');
    await host.page.waitForSelector(sel('fixed_count'));
    assert.equal(await host.page.$eval(sel('fixed_count'),e=>e.value),'3');
    await host.page.select(sel('n18Mode'),'1');
    await host.page.waitForSelector(sel('limit_count'));
    await host.page.locator(`${base} button[type="submit"]`).click();
    await Promise.all([host,guest].map(c=>c.page.waitForFunction(()=>globalThis.__SP__?.data.get('config')?.modes.mode_multi_normal.enemyDifficulty?.mode==='random' && globalThis.__SP__.data.get('config').modes.mode_multi_normal.enemyDifficulty.maxTerms===2)));
    await guest.click('[data-testid="plugin-tag"]');await guest.page.waitForSelector(sel('limit_count'));
    assert.equal(await guest.page.$eval(sel('limit_count'),e=>e.disabled),true);
    fs.mkdirSync(OUT,{recursive:true});
    await host.page.screenshot({path:path.join(OUT,'n18-settings-host.png'),fullPage:true});
    await guest.page.screenshot({path:path.join(OUT,'n18-settings-guest.png'),fullPage:true});
    await guest.click('.modal__actions button','完成');
    await host.click('.modal__actions button','完成');
    await guest.click('.room-bar__right button','准备就绪');
    await host.click('.room-bar__right button','开始模拟');
    await host.waitFor(s=>s.phase==='PREP','random challenge prep',90000);
    await Promise.all([host,guest].map(c=>c.page.waitForSelector('.pboot',{hidden:true,timeout:30000})));
    await host.page.waitForSelector('[data-testid="enemy-difficulty"]');
    await host.click('[data-testid="enemy-difficulty"] summary',null,{timeout:60000});
    const plan=await host.page.evaluate(()=>globalThis.__SP__.store.get().match.public.enemyDifficulty);
    assert.equal(plan.mode,'random');
    assert.ok(Object.values(plan.values).filter(v=>v>1).length<=2);
    await guest.page.waitForFunction(p=>JSON.stringify(globalThis.__SP__.store.get().match.public?.enemyDifficulty)===JSON.stringify(p),{},plan);
    await host.page.screenshot({path:path.join(OUT,'n18-prep-host.png'),fullPage:true});
    await guest.page.screenshot({path:path.join(OUT,'n18-prep-guest.png'),fullPage:true});
    assert.deepEqual(host.problems.filter(p=>p.startsWith('pageerror:')),[]);
    assert.deepEqual(guest.problems.filter(p=>p.startsWith('pageerror:')),[]);
  } catch (e) {
    if (host.page) {
      await host.page.screenshot({path:path.join(OUT,'n18-failure.png'),fullPage:true});
      console.error(await host.page.evaluate(()=>document.body.innerText.slice(-4000)));
      console.error(host.problems);
      console.error(await host.page.evaluate(()=>({fields:[...document.querySelectorAll('[data-setting]')].map(e=>[e.dataset.setting,e.value]),cfg:globalThis.__SP__?.data.get('config')?.modes.mode_multi_normal.enemyDifficulty})));
    }
    throw e;
  } finally {await host.close();await guest.close();await srv.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
