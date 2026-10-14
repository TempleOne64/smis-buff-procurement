import http from 'node:http';
import assert from 'node:assert/strict';
import {BuffBrowser,loadPlaywright} from '../buff-browser.mjs';

const steamId='76561198000000000';
let buyCount=0,login=true,free=true,price=0.1,paymentState='TO_DELIVER',freshReceipt=false,mixed=false;
const html=id=>`<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.g={user:${login?`{id:'fixture',steamid:'${steamId}'}`:'null'},currency:{code:'CNY'}};
window.MultiSteamId=()=>({get_steamid:()=>${login?`'${steamId}'`:'null'}});
</script><button id="batch-buy-btn">批量购买</button>
<div id="j_popup_batchbuy" style="display:none"><input id="batch-buy-max-price" value="0.10"><input id="batch-buy-num" value="1"><span class="total_amount">0.10</span><button class="i_Btn_main">购买预览</button></div>
<div id="j_popup_epay" style="display:none"><div class="pay-item" data-value="43" data-free_password="${free}">BUFF可用资金</div><span class="total_price">0.10</span><button class="pay-btn">确认付款</button></div>
<script>
const goods='${id}',dlg=document.querySelector('#j_popup_batchbuy'),cash=document.querySelector('#j_popup_epay');let orders=[];
function total(){const n=Number(document.querySelector('#batch-buy-num').value);const amount=orders.slice(0,n).reduce((v,o)=>v+Number(o.price),0).toFixed(2);document.querySelector('.total_amount').textContent=amount;document.querySelector('.total_price').textContent=amount;}
async function fetchOrders(){const max=document.querySelector('#batch-buy-max-price').value;const j=await(await fetch('/api/market/goods/sell_order?goods_id='+goods+'&max_price='+max)).json();orders=j.data.items;total();}
document.querySelector('#batch-buy-btn').onclick=async()=>{dlg.style.display='block';await fetchOrders();};
document.querySelector('#batch-buy-max-price').onchange=fetchOrders;
document.querySelector('#batch-buy-num').onchange=total;
dlg.querySelector('.i_Btn_main').onclick=async()=>{await fetch('/api/market/goods/batch_buy/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goods_id:goods})});cash.style.display='block';};
cash.querySelector('.pay-btn').onclick=async()=>{for(const o of orders.slice(0,Number(document.querySelector('#batch-buy-num').value))){await fetch('/api/market/goods/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goods_id:goods,sell_order_id:o.id,price:o.price,pay_method:43,steamid:'${steamId}'})});}};
</script></body></html>`;
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1');res.setHeader('Content-Type','application/json');
 if(u.pathname.startsWith('/goods/')){res.setHeader('Content-Type','text/html');return res.end(html(u.pathname.split('/').at(-1)));}
 if(u.pathname==='/market/buy_order/history'){res.setHeader('Content-Type','text/html');return res.end(html('1')+(freshReceipt?`<script>fetch('/api/market/bill_order/batch/info?bill_orders=${u.searchParams.get('search')}')</script>`:''));}
 if(u.pathname==='/api/market/bill_order/batch/info')return res.end(JSON.stringify({code:'OK',data:{items:[{id:u.searchParams.get('bill_orders'),state:'SUCCESS',price:'0.10'}]}}));
 if(u.pathname.endsWith('/sell_order'))return res.end(JSON.stringify({code:'OK',data:{items:[1,2,3].map(n=>({id:'SELL-'+n,goods_id:u.searchParams.get('goods_id'),mode:2,price:(price+(mixed?(n-1)*.01:0)).toFixed(2)})).filter(o=>Number(o.price)<=Number(u.searchParams.get('max_price')))}}));
 if(u.pathname.endsWith('/preview'))return res.end(JSON.stringify({code:'OK',data:{price:'0.10'}}));
 if(u.pathname.endsWith('/goods/buy')){let body='';for await(const c of req)body+=c;const data=JSON.parse(body);buyCount++;return res.end(JSON.stringify({code:'OK',data:{id:'ORDER-'+buyCount,state:paymentState,price:data.price}}));}
 return res.end('{}');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseURL='http://127.0.0.1:'+server.address().port;
const {chromium}=await loadPlaywright();
const options={headless:true};if(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE)options.executablePath=process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
const context=await chromium.launchPersistentContext('',options);const browser=new BuffBrowser({context,baseURL,timeoutMs:1500});
const settings={ratio:.7,autoBuy:true,expectedSteamId:steamId};
try{
 await browser.open();assert.equal(browser.status().state,'ready');
 const quote=await browser.inspect({buffId:'1',bidNet:100},settings);assert.deepEqual(quote.depth,[{unitCost:10,quantity:3}]);assert.equal(buyCount,0,'inspect must never pay');
 const equalFloor=await browser.inspect({buffId:'1',bidNet:100},{...settings,minUnitPrice:10});assert.deepEqual(equalFloor.depth,quote.depth);
 mixed=true;const belowFloor=await browser.inspect({buffId:'1',bidNet:100},{...settings,minUnitPrice:11});assert.deepEqual(belowFloor.depth,[],'bulk UI must skip a good with low offers instead of selecting more expensive copies');mixed=false;
 const plan={buffId:'1',bidNet:100,quantity:2,unitCost:10,maxPrice:10,minUnitPrice:10,totalCost:20,steamId};
 const result=await browser.buy(plan,settings);assert.equal(result.status,'paid',result.error);assert.equal(result.totalCost,20);assert.equal(result.orders.length,2);assert.equal(result.final,true);
 const purchase={...plan,appid:730,orderRefs:result.orders.map(o=>o.id)};
 for(const id of purchase.orderRefs)browser.orderMap.set(id,{id,state:'SUCCESS',cost:10,source:'/api/market/bill_order/batch/info',observedAt:Date.now()-60000});
 const staleReceipt=await browser.reconcile(purchase,settings);assert.equal(staleReceipt.final,false,'old SUCCESS cache must not prove receipt');
 freshReceipt=true;const receipt=await browser.reconcile(purchase,settings);assert.equal(receipt.status,'received');assert.equal(receipt.final,true);assert.equal(receipt.steamId,steamId);
 paymentState='PAYING';const pending=await browser.buy(plan,settings);assert.equal(pending.status,'unknown');assert.equal(pending.orders.length,2,'PAYING orders must retain their IDs');assert.equal(pending.final,false);paymentState='TO_DELIVER';
 const knownCount=buyCount;
 const newFloor=await browser.buy(plan,{...settings,minUnitPrice:11});assert.equal(newFloor.status,'cancelled');assert.equal(buyCount,knownCount,'higher minimum prevents payment');
 const repriced=await browser.buy({...plan,minUnitPrice:11},settings);assert.equal(repriced.status,'cancelled');assert.equal(buyCount,knownCount,'price dropping below the reserved minimum prevents payment');
 const disabled=await browser.buy(plan,{...settings,autoBuy:false});assert.equal(disabled.status,'cancelled');assert.equal(buyCount,knownCount);
 free=false;const noFree=await browser.buy(plan,settings);assert.equal(noFree.status,'cancelled');assert.equal(buyCount,knownCount);
 free=true;const wrong=await browser.buy(plan,{...settings,expectedSteamId:'76561198000000001'});assert.equal(wrong.status,'cancelled');assert.equal(buyCount,knownCount);
 price=.2;const changed=await browser.buy(plan,settings);assert.equal(changed.status,'cancelled');assert.equal(buyCount,knownCount);
 login=false;await browser.check(settings);assert.equal(browser.status().state,'login_required');
 console.log('PASS: read-only quote, minimum-price equality, low mixed offers skipped, minimum rechecked before payment, bounded balance payment, fresh receipt evidence, stale cache rejection, PAYING IDs retained, disabled automation, password requirement, wrong account, price drift, expired login. Only local fictional orders were submitted.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
