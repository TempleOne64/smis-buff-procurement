import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {BuffBrowser,loadPlaywright} from '../buff-browser.mjs';
import {createApp} from '../server.mjs';

// Local fictional vendor only. Money in application plans/state is integer cents;
// vendor JSON/DOM use yuan strings. BUFF state SUCCESS proves received and
// TO_DELIVER proves paid; no numeric payment state is invented here.
// QUOTE_CHANGED is retryable only when no /goods/buy request reached the vendor.
const steamId='76561198000000000';
let mode='stable',goodsPages=0,buyRequests=[],sellRequests=0,sequence=0,app=null,signalSubmit=null;
const vendorOrders=new Map();
function reset(next){mode=next;goodsPages=0;sellRequests=0;buyRequests=[];sequence=0;vendorOrders.clear();}
const html=revision=>`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.g={user:{id:'fixture',steamid:'${steamId}'},currency:{code:'CNY'}};
window.MultiSteamId=()=>({get_steamid:()=>'${steamId}'});
</script><button id="batch-buy-btn">批量购买</button>
<div id="j_popup_batchbuy" style="display:none">
<input id="batch-buy-max-price" value="9.99"><input id="batch-buy-num" value="1">
<span class="total_amount">0.00</span><button class="i_Btn_main">购买预览</button></div>
<div id="j_popup_epay" style="display:none">
<div class="pay-item" data-value="43" data-free_password="true">BUFF可用资金</div>
<span class="total_price">0.00</span><button class="pay-btn">确认付款</button></div>
<script>
const dlg=document.querySelector('#j_popup_batchbuy'),cash=document.querySelector('#j_popup_epay');
const mode=${JSON.stringify(mode)},revision=${revision};let orders=[];
function render(){
 const qty=Number(document.querySelector('#batch-buy-num').value);
 const amount=orders.slice(0,qty).reduce((n,o)=>n+Number(o.price),0);
 document.querySelector('.total_amount').textContent=(amount+(mode==='wrong-total'?.01:0)).toFixed(2);
 document.querySelector('.total_price').textContent=(amount+(mode==='wrong-cashier'?.01:0)).toFixed(2);
}
function updateTotal(){if(mode==='delayed')setTimeout(render,450);else render();}
async function fetchOrders(){
 const max=document.querySelector('#batch-buy-max-price').value;
 const response=await fetch('/api/market/goods/sell_order?goods_id=1&max_price='+max+'&revision='+revision);
 const json=await response.json();orders=json.data.items;updateTotal();
}
document.querySelector('#batch-buy-btn').onclick=async()=>{dlg.style.display='block';await fetchOrders();};
document.querySelector('#batch-buy-max-price').onchange=fetchOrders;
document.querySelector('#batch-buy-num').onchange=updateTotal;
dlg.querySelector('.i_Btn_main').onclick=async()=>{
 await fetch('/api/market/goods/batch_buy/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 cash.style.display='block';
};
cash.querySelector('.pay-btn').onclick=async()=>{
 for(const order of orders.slice(0,Number(document.querySelector('#batch-buy-num').value))){
  const response=await fetch('/api/market/goods/buy',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({goods_id:'1',sell_order_id:order.id,price:mode==='guard-reprice'?'2.01':order.price,pay_method:43,steamid:'${steamId}'})});
  await response.json();
 }
};
</script></body></html>`;
const vendor=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Content-Type','application/json');
 if(url.pathname.startsWith('/goods/')){
  if(url.pathname==='/goods/1')goodsPages++;
  res.setHeader('Content-Type','text/html');return res.end(html(goodsPages));
 }
 if(url.pathname.endsWith('/sell_order')){
  sellRequests++;
  if(mode==='delayed')await new Promise(resolve=>setTimeout(resolve,550));
  const revision=Number(url.searchParams.get('revision'));
  const cents=mode==='repriced'&&revision>=2?201:mode==='below-minimum'?199:mode==='ratio-boundary'?210:200;
  const items=[1,2,3].map(n=>({id:'SELL-'+n,goods_id:'1',mode:2,price:(cents/100).toFixed(2)}))
   .filter(order=>Number(order.price)<=Number(url.searchParams.get('max_price'))&&!buyRequests.some(b=>b.sell_order_id===order.id));
  return res.end(JSON.stringify({code:'OK',data:{items}}));
 }
 if(url.pathname.endsWith('/preview'))return res.end(JSON.stringify({code:'OK',data:{price:'2.00'}}));
 if(url.pathname.endsWith('/goods/buy')){
  let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);buyRequests.push(data);
  const id='ORDER-'+(++sequence),order={id,state:'SUCCESS',price:data.price};vendorOrders.set(id,order);
  // Keep the response pending until the final scenario closes Chromium. The
  // route has already allowed this request, so losing the shared permit on
  // context.close cannot make this payment safe to retry.
  if(mode==='close-after-submit'){signalSubmit?.();return;}
  // The vendor accepted the request, but the result is unreadable. Parsing it
  // stops the page loop; neither the browser adapter nor runner may retry it.
  if(mode==='lost-response')return res.end('lost payment result');
  if(mode==='partial'&&sequence===2)return res.end(JSON.stringify({code:'Sell Order Not Found'}));
  return res.end(JSON.stringify({code:'OK',data:order}));
 }
 return res.end('{}');
});
await new Promise(resolve=>vendor.listen(0,'127.0.0.1',resolve));
let context;
try{
 const {chromium}=await loadPlaywright(),launch={headless:true};
 if(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE)launch.executablePath=process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
 context=await chromium.launchPersistentContext('',launch);
}catch(error){await new Promise(resolve=>vendor.close(resolve));throw error;}
const browser=new BuffBrowser({context,baseURL:'http://127.0.0.1:'+vendor.address().port,timeoutMs:2500,
 canSubmit:plan=>!app||(app.store.read().settings.autoBuy&&!app.store.read().paused&&app.store.read().jobs.some(job=>job.id===plan.jobId&&job.status==='running'))});
// Multiple isolated app databases share this one local browser. An app closing
// must not close it before the next scenario; the outer finally owns cleanup.
const sharedBrowser={status:()=>browser.status(),open:()=>browser.open(),check:s=>browser.check(s),
 inspect:(candidate,s)=>browser.inspect(candidate,s),buy:(purchase,s)=>browser.buy(purchase,s),
 reconcile:(purchase,s)=>browser.reconcile(purchase,s),close:async()=>{}};
const settings={ratio:.7,autoBuy:true,expectedSteamId:steamId,minUnitPrice:200};
const plan={buffId:'1',bidNet:1000,quantity:2,unitCost:200,maxPrice:200,minUnitPrice:200,totalCost:400,steamId};
async function checkRetry(result,label){
 assert.equal(result.status,'cancelled',label);assert.equal(result.final,true,label);
 assert.equal(result.retryable,true,label);assert.equal(result.retryCode,'QUOTE_CHANGED',label);
 assert.equal(buyRequests.length,0,label+' must never pay');
}
async function closeApp(){if(app){await new Promise(resolve=>app.server.close(resolve));app=null;}}
async function workflow(next){
 reset(next);await mkdir('.diagnostics',{recursive:true});
 app=await createApp({dir:path.resolve('.diagnostics/quote-retry-'+next+'-'+Date.now()),browser:sharedBrowser,
  fetcher:async()=>({fetchedAt:new Date().toISOString(),scope:'仅本地虚构行情',rows:[{buffId:1,appid:730,cnName:'报价重核测试',hashName:'Quote retry fixture',buffSellPrice:2,steamBuyPrice:10,steamSellPrice:11,steamTransactionQuantity:100,updateTime:new Date().toISOString()}]})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 async function api(url,payload){const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();assert.equal(response.ok,true,result.error);return result;}
 async function command(type,payload){return api('/api/command',{key:randomUUID(),type,payload});}
 await command('settings',{autoRefresh:false,autoBuy:true,expectedSteamId:steamId,minUnitPrice:200,maxBatchSpend:400,maxUnits:100});
 await api('/api/refresh',{wait:true});await command('job-create',{name:'真实浏览器安全重核',budget:400});
 const id=app.view().activeJob.id;await api('/api/jobs/run',{id,wait:true});return {view:app.view(),id};
}
try{
 await browser.open();
 reset('delayed');const delayed=await browser.buy(plan,settings);
 assert.equal(delayed.status,'received',delayed.error);assert.equal(delayed.totalCost,400);assert.equal(buyRequests.length,2);
 assert.ok(sellRequests>=2,'must refresh sell orders, not sleep and reuse the old response');

 reset('repriced');const initial=await browser.inspect({buffId:'1',bidNet:1000},settings);assert.equal(initial.depth[0].unitCost,200);
 await checkRetry(await browser.buy(plan,settings),'rising price beyond reservation');
 reset('wrong-total');await checkRetry(await browser.buy(plan,settings),'persistent batch total mismatch');
 reset('wrong-cashier');await checkRetry(await browser.buy(plan,settings),'persistent cashier total mismatch');
 reset('guard-reprice');await checkRetry(await browser.buy(plan,settings),'first payment request blocked before dispatch after repricing');

 reset('below-minimum');const below=await browser.buy(plan,settings);assert.equal(below.status,'cancelled');assert.equal(buyRequests.length,0,'minimum price must not be relaxed during retry');
 reset('ratio-boundary');const ratio=await browser.buy({...plan,bidNet:300,maxPrice:210,unitCost:210,totalCost:420},settings);
 assert.equal(ratio.status,'cancelled');assert.equal(buyRequests.length,0,'strict ratio boundary must not be relaxed');

 reset('lost-response');const lost=await browser.buy(plan,settings);
 assert.equal(lost.status,'unknown');assert.equal(lost.final,false);assert.notEqual(lost.retryable,true);assert.equal(buyRequests.length,1);
 reset('partial');const partial=await browser.buy(plan,settings);
 assert.equal(partial.status,'unknown');assert.equal(partial.final,false);assert.notEqual(partial.retryable,true);
 assert.equal(partial.orders.length,1,'partial paid order evidence must be retained');assert.equal(buyRequests.length,2);

 const repriced=await workflow('repriced'),job=repriced.view.jobs.find(j=>j.id===repriced.id);
 assert.equal(job.status,'completed',job.reason);assert.equal(job.spent,201);assert.equal(job.reserved,0);assert.equal(job.remaining,199);
 assert.equal(buyRequests.length,1);assert.equal(buyRequests[0].price,'2.01');
 assert.equal(repriced.view.purchases.filter(p=>p.status==='cancelled').length,1,'failed reservation released before new plan');
 assert.equal(repriced.view.purchases.find(p=>p.status==='received').quantity,1,'new depth and budget require fewer units');
 await closeApp();

 const mismatch=await workflow('wrong-total'),unstable=mismatch.view.jobs.find(j=>j.id===mismatch.id);
 assert.equal(unstable.status,'paused','persistent unstable quotes pause after bounded retries');
 assert.equal(unstable.spent,0);assert.equal(unstable.reserved,0);assert.equal(buyRequests.length,0);
 assert.equal(mismatch.view.purchases.length,3,'unstable candidate is bounded to three cancellations');await closeApp();

 const unknown=await workflow('lost-response'),frozen=unknown.view.jobs.find(j=>j.id===unknown.id);
 assert.equal(frozen.status,'needs_action');assert.equal(frozen.reserved,400);assert.equal(unknown.view.purchases.length,1);
 assert.equal(unknown.view.purchases[0].status,'unknown');assert.equal(buyRequests.length,1,'runner must not retry submitted ambiguous payment');
 await closeApp();

 reset('close-after-submit');let submissionTimeout;
 const reachedVendor=new Promise((resolve,reject)=>{
  signalSubmit=()=>{clearTimeout(submissionTimeout);resolve();};
  submissionTimeout=setTimeout(()=>reject(Error('final fixture payment never reached vendor')),5000);
 });
 const interruptedPayment=browser.buy(plan,settings);await reachedVendor;await context.close();
 const interrupted=await interruptedPayment;
 assert.equal(interrupted.status,'unknown','closing the context must retain dispatched payment evidence');
 assert.equal(interrupted.final,false);assert.notEqual(interrupted.retryable,true);
 assert.equal(buyRequests.length,1);assert.equal(browser.permit,null,'context close cleared shared permit but cannot erase submission evidence');
 console.log('PASS: delayed matching response/DOM totals converge; repricing and permanent mismatches never blindly pay; minimum and strict ratio retained; lost/partial payments stay unknown; real browser + app replan 2×200 to 1×201 within 400 cents, bounded instability pauses, ambiguous payment freezes; context closure after dispatch remains unknown and non-retryable. Only local fictional orders.');
}finally{
 await closeApp();await browser.close();await new Promise(resolve=>vendor.close(resolve));
}
