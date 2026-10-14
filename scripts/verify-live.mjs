import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
import {BuffBrowser,loadPlaywright} from '../buff-browser.mjs';

await mkdir('.diagnostics',{recursive:true});await mkdir('artifacts',{recursive:true});
const dir=path.resolve('.diagnostics/live-verification-'+Date.now());
const app=await createApp({dir});app.store.command(randomUUID(),'settings',{autoRefresh:false});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+app.server.address().port;
const {chromium}=await loadPlaywright();const launch={headless:true};if(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE)launch.executablePath=process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
const browser=await chromium.launch(launch);const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
let guest;
try{
 await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection')?.classList.contains('connected'));
 await page.locator('#refresh').click();
 await page.waitForFunction(()=>document.querySelector('#rawCount')?.textContent!=='—'&&!document.querySelector('#refresh').disabled,{},{timeout:100000});
 const state=app.view();assert.ok(state.snapshot.rows.length>0,'must fetch real item rows');assert.equal(state.settings.autoBuy,false);assert.equal(state.purchases.length,0);
 await page.locator('#jobForm [name=name]').fill('真实行情验证任务（不付款）');
 await page.locator('#jobForm [name=budget]').fill('200.00');await page.locator('#jobForm button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#activeJobBox')?.hidden===false);
 assert.equal(app.view().activeJob.budget,20000);assert.equal(app.view().activeJob.status,'draft');
 await page.screenshot({path:'artifacts/procurement-live.png',fullPage:false});await page.screenshot({path:'artifacts/procurement-overview.png',fullPage:true});
 await page.locator('#ledgerTab').click();await page.waitForFunction(()=>document.querySelector('#ledgerPage')?.hidden===false);
 await page.screenshot({path:'artifacts/ledger-live.png',fullPage:false});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/ledger-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('#dashboardTab').click();await page.screenshot({path:'artifacts/procurement-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 guest=new BuffBrowser({profileDir:path.join(dir,'buff-guest-profile'),launchOptions:launch});await guest.open();assert.equal(guest.status().state,'login_required');
 await assert.rejects(guest.inspect({buffId:'42346',bidNet:100},{ratio:.7,expectedSteamId:'76561198000000000'}),/登录/);
 const result={version:'0.4.0',checkedAt:new Date().toISOString(),network:'SMIS default Node fetch through app HTTP refresh and real browser button',rawRows:state.snapshot.diagnostics?.rawCount,uniqueRows:state.snapshot.rows.length,candidates:app.view().candidates.length,latestQuote:state.snapshot.rows.map(row=>row.updateTime).sort().at(-1),diagnostics:state.snapshot.diagnostics,jobBudget:app.view().activeJob.budget,jobStatus:app.view().activeJob.status,buffGuest:guest.status().state,actualPurchases:0,browserErrors:errors,mobileOverflow:false};
 await writeFile('artifacts/verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{if(guest)await guest.close();await browser.close();await new Promise(resolve=>app.server.close(resolve));}
