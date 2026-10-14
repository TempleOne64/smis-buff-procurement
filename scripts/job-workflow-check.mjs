import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
import {BuffBrowser,loadPlaywright} from '../buff-browser.mjs';

// This vendor fixture is entirely local. No external orders or payment requests are made.
const steamId='76561198000000000',stock=Array.from({length:20},(_,n)=>({id:'SELL-'+n,goods_id:'1',price:'0.10'}));
const vendorOrders=new Map();let sequence=0,app;
const html=`<!doctype html><html><body>
<script>window.g={user:{id:'fixture',steamid:'${steamId}'},currency:{code:'CNY'}};window.MultiSteamId=()=>({get_steamid:()=>'${steamId}'});</script>
<button id="batch-buy-btn">批量购买</button><div id="j_popup_batchbuy" style="display:none"><input id="batch-buy-max-price" value="0.10"><input id="batch-buy-num" value="1"><span class="total_amount">0.10</span><button class="i_Btn_main">购买预览</button></div>
<div id="j_popup_epay" style="display:none"><div class="pay-item" data-value="1" data-free_password="true">网易余额</div><span class="total_price">0.10</span><button class="pay-btn">确认付款</button></div>
<script>
const dlg=document.querySelector('#j_popup_batchbuy'),cash=document.querySelector('#j_popup_epay');let orders=[];
function total(){const qty=Number(document.querySelector('#batch-buy-num').value);const amount=orders.slice(0,qty).reduce((n,o)=>n+Number(o.price),0).toFixed(2);document.querySelector('.total_amount').textContent=amount;document.querySelector('.total_price').textContent=amount;}
async function fetchOrders(){const max=document.querySelector('#batch-buy-max-price').value;const j=await(await fetch('/api/market/goods/sell_order?goods_id=1&max_price='+max)).json();orders=j.data.items;total();}
document.querySelector('#batch-buy-btn').onclick=async()=>{dlg.style.display='block';await fetchOrders();};document.querySelector('#batch-buy-max-price').onchange=fetchOrders;document.querySelector('#batch-buy-num').onchange=total;
dlg.querySelector('.i_Btn_main').onclick=async()=>{await fetch('/api/market/goods/batch_buy/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});cash.style.display='block';};
cash.querySelector('.pay-btn').onclick=async()=>{for(const order of orders.slice(0,Number(document.querySelector('#batch-buy-num').value)))await fetch('/api/market/goods/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goods_id:'1',sell_order_id:order.id,price:order.price,pay_method:1,steamid:'${steamId}'})});};
</script></body></html>`;
const vendor=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Content-Type','application/json');
 if(url.pathname.startsWith('/goods/')){res.setHeader('Content-Type','text/html');return res.end(html);}
 if(url.pathname.endsWith('/sell_order'))return res.end(JSON.stringify({code:'OK',data:{items:stock.filter(order=>Number(order.price)<=Number(url.searchParams.get('max_price'))).slice(0,3)}}));
 if(url.pathname.endsWith('/preview'))return res.end(JSON.stringify({code:'OK',data:{price:'0.10'}}));
 if(url.pathname.endsWith('/goods/buy')){
  let body='';for await(const c of req)body+=c;const data=JSON.parse(body),index=stock.findIndex(order=>order.id===data.sell_order_id);
  if(index<0){res.statusCode=409;return res.end(JSON.stringify({code:'Sell Order Not Found'}));}
  const order=stock.splice(index,1)[0],id='ORDER-'+(++sequence);vendorOrders.set(id,{id,state:'SUCCESS',price:order.price});return res.end(JSON.stringify({code:'OK',data:vendorOrders.get(id)}));
 }
 return res.end('{}');
});
await new Promise(r=>vendor.listen(0,'127.0.0.1',r));
const {chromium}=await loadPlaywright(),launch={headless:true};if(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE)launch.executablePath=process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
const context=await chromium.launchPersistentContext('',launch);
const browser=new BuffBrowser({context,baseURL:'http://127.0.0.1:'+vendor.address().port,timeoutMs:3000,canSubmit:plan=>{
 if(!app||!plan?.jobId)return false;const state=app.store.read();return state.settings.autoBuy&&!state.paused&&state.jobs.some(job=>job.id===plan.jobId&&job.status==='running');
}});
await mkdir('.diagnostics',{recursive:true});app=await createApp({dir:path.resolve('.diagnostics/workflow-'+Date.now()),browser,fetcher:async()=>({fetchedAt:new Date().toISOString(),scope:'本地虚构行情',rows:[{buffId:1,appid:730,cnName:'工作流测试饰品',hashName:'Fixture item',buffSellPrice:.1,steamBuyPrice:1.2,steamSellPrice:1.4,steamTransactionQuantity:100,updateTime:new Date().toISOString()}]})});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
async function api(url,payload={}){const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const json=await response.json();if(!response.ok)throw Error(json.error||'API failed');return json;}
async function command(type,payload){return api('/api/command',{key:randomUUID(),type,payload});}
try{
 await browser.open();await command('settings',{autoRefresh:false,autoBuy:true,expectedSteamId:steamId,maxBatchSpend:30,maxUnits:100});await api('/api/refresh',{wait:true});
 await command('job-create',{name:'75分预算测试',budget:75});const id=app.view().activeJob.id;
 await api('/api/jobs/run',{id,wait:true});let view=app.view(),job=view.jobs.find(row=>row.id===id);
 assert.equal(job.status,'completed');assert.equal(job.spent,70);assert.equal(job.remaining,5);assert.equal(sequence,7);assert.equal(view.purchases.length,3);assert.equal(view.purchases.reduce((n,p)=>n+p.totalCost,0),70);
 const first=view.purchases.find(p=>p.quantity===3);await command('sale-add',{purchaseId:first.id,quantity:1,gross:40,fee:4,net:36,occurredAt:new Date().toISOString(),reference:'SALE-1',note:'虚构部分出售'});
 await command('sale-add',{purchaseId:first.id,quantity:2,gross:80,fee:8,net:72,occurredAt:new Date().toISOString(),reference:'SALE-2',note:'虚构剩余出售'});
 view=app.view();assert.equal(view.ledger.soldQuantity,3);assert.equal(view.ledger.salesNet,108);assert.equal(view.ledger.soldCost,30);assert.equal(view.ledger.unsoldQuantity,4);assert.equal(view.jobs.find(row=>row.id===id).remaining,5,'Steam sales must not refill procurement budget');
 await assert.rejects(command('sale-add',{purchaseId:first.id,quantity:1,gross:40,fee:4,net:36,occurredAt:new Date().toISOString(),reference:'SALE-3'}),/数量|库存|已售|剩余|售出/);
 const sale1=view.sales.find(s=>s.reference==='SALE-1');await command('sale-delete',{id:sale1.id,note:'撤销测试记录'});view=app.view();assert.equal(view.ledger.soldQuantity,2);assert.equal(view.ledger.soldCost,20);assert.equal(view.ledger.unsoldQuantity,5);
 await command('job-create',{name:'第二次独立预算',budget:20});const next=app.view().activeJob.id;await api('/api/jobs/run',{id:next,wait:true});job=app.view().jobs.find(j=>j.id===next);assert.equal(job.spent,20);assert.equal(sequence,9);assert.equal(job.remaining,0);
 console.log('PASS: genuine browser UI on a local vendor fixture; 75-cent job buys 7 items in 3 batches, leaves 5 cents; partial Steam sale ledger/oversell protection/reversal; second job has independent budget. No real payment.');
}finally{await new Promise(r=>app.server.close(r));await browser.close();await new Promise(r=>vendor.close(r));}
