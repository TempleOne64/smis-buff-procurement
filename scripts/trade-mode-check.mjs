import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
import {BuffBrowser,loadPlaywright} from '../buff-browser.mjs';

// All accounts, stock, orders and money in this fixture are fictional and local.
// The browser never connects to BUFF or another payment service.
const steamId='76561198000000000';
const funds=(value=43,extra={})=>({value,name:'BUFF可用资金',selectable:true,...extra});
let scenario={},sequence=0,app=null;
const purchases=[],receiptRequests=[],vendorOrders=new Map();
const configured=goodsId=>({...scenario,...scenario.goods?.[goodsId]});
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');

function page(goodsId,historyRef=null){
 const config=configured(goodsId),methods=config.methods??[funds()];
 const choice=methods.map(method=>`<li class="${method.selectable===false?'unselectable-pay-item':'pay-item'}${method.disabled?' disabled':''}" data-value="${method.value}" data-method="${escape(JSON.stringify({...method,btn_clickable:method.selectable!==false}))}"${method.free===undefined?'':` data-free_password="${method.free}"`}><div class="epay-info"><h5>${escape(method.name)}</h5></div></li>`).join('');
 const template=config.template===false?'':`<script type="text/html" id="manual_plus_pay_success_pat"><div class="popup" id="j_popup_payed"><div class="popup-cont"><h3>请选择发起报价方式</h3><a href="javascript:;" class="i_Btn" id="ask_seller">请卖家发报价</a></div></div></script>`;
 return `<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body>
 <script>window.g={user:{id:'fixture',steamid:'${steamId}'},currency:{code:'CNY'}};window.MultiSteamId=()=>({get_steamid:()=>'${steamId}'});</script>
 <button id="batch-buy-btn">批量购买</button>
 <div class="popup" id="j_popup_batchbuy" style="display:none"><input id="batch-buy-max-price" value="0.10"><input id="batch-buy-num" value="1"><span class="total_amount">0.10</span><button class="i_Btn_main">购买预览</button></div>
 <div class="popup" id="j_popup_epay" style="display:none"><ul class="pay-method-list">${choice}</ul><span class="total_price">0.10</span><button class="pay-btn">确认付款</button></div>
 ${template}
 <script>
 const goods=${JSON.stringify(goodsId)},config=${JSON.stringify(config)},dlg=document.querySelector('#j_popup_batchbuy'),cash=document.querySelector('#j_popup_epay');
 let orders=[],selectedMethod=null,paidRefs=[];
 function total(){const quantity=Number(document.querySelector('#batch-buy-num').value);const value=orders.slice(0,quantity).reduce((n,order)=>n+Number(order.price),0).toFixed(2);document.querySelector('.total_amount').textContent=value;document.querySelector('.total_price').textContent=value;}
 async function fetchOrders(){const max=document.querySelector('#batch-buy-max-price').value;const json=await(await fetch('/api/market/goods/sell_order?goods_id='+goods+'&max_price='+max)).json();orders=json.data.items;total();}
 document.querySelector('#batch-buy-btn').onclick=async()=>{dlg.style.display='block';await fetchOrders();};
 document.querySelector('#batch-buy-max-price').onchange=fetchOrders;
 document.querySelector('#batch-buy-num').onchange=total;
 for(const item of cash.querySelectorAll('.pay-item'))item.onclick=()=>{for(const node of cash.querySelectorAll('li'))node.classList.remove('on');item.classList.add('on');selectedMethod=Number(item.dataset.value);};
 dlg.querySelector('.i_Btn_main').onclick=async()=>{await fetch('/api/market/goods/batch_buy/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goods_id:goods,sell_orders:orders.slice(0,Number(document.querySelector('#batch-buy-num').value)).map(o=>o.id)})});dlg.style.display='none';cash.style.display='block';};
 cash.querySelector('.pay-btn').onclick=async()=>{
  paidRefs=[];
  for(const order of orders.slice(0,Number(document.querySelector('#batch-buy-num').value))){
   try{const json=await(await fetch('/api/market/goods/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goods_id:goods,sell_order_id:order.id,price:order.price,pay_method:config.forcePaymentMethod??selectedMethod,steamid:'${steamId}'})})).json();if(json.code==='OK')paidRefs.push(json.data.id);}catch{break;}
  }
  if(config.mode!==5||!paidRefs.length)return;
  cash.style.display='none';
  // The official batch result is confirmed before the seller-offer dialog exists.
  setTimeout(()=>{const modal=document.createElement('div');modal.className='popup';modal.id='fixture_results';modal.innerHTML='<h3>批量购买结果</h3><button class="i_Btn_main">确认</button>';document.body.append(modal);modal.querySelector('button').onclick=()=>{modal.remove();setTimeout(()=>{const template=document.querySelector('#manual_plus_pay_success_pat');if(!template)return;document.body.insertAdjacentHTML('beforeend',template.textContent);document.querySelector('#j_popup_payed #ask_seller').onclick=async()=>{await fetch('/api/market/bill_order/ask_seller_to_send_offer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bill_orders:paidRefs,game:'csgo',steamid:'${steamId}'})});};},75);};},75);
 };
 ${historyRef?`fetch('/api/market/bill_order/batch/info?bill_orders='+${JSON.stringify(historyRef)});`:''}
 </script></body></html>`;
}

async function readBody(request){let value='';for await(const chunk of request)value+=chunk;return value?JSON.parse(value):{};}
const vendor=http.createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://127.0.0.1');response.setHeader('Content-Type','application/json');
  if(url.pathname.startsWith('/goods/')){response.setHeader('Content-Type','text/html');return response.end(page(url.pathname.split('/').at(-1)));}
  if(url.pathname==='/market/buy_order/history'){response.setHeader('Content-Type','text/html');return response.end(page('2',url.searchParams.get('search')));}
  if(url.pathname.endsWith('/sell_order')){
   const goodsId=url.searchParams.get('goods_id'),config=configured(goodsId);
   return response.end(JSON.stringify({code:'OK',data:{items:Array.from({length:3},(_,n)=>({id:'SELL-'+goodsId+'-'+n,goods_id:goodsId,price:'0.10',mode:config.mode??2,...config.orderFlags})).filter(order=>Number(order.price)<=Number(url.searchParams.get('max_price')))}}));
  }
  if(url.pathname.endsWith('/batch_buy/preview')){
   const data=await readBody(request),config=configured(data.goods_id),methods=config.methods??[funds()];
   return response.end(JSON.stringify({code:'OK',data:{price:((data.sell_orders?.length??1)*.1).toFixed(2),pay_methods:methods.map(method=>({value:method.value,name:method.name,btn_clickable:method.selectable!==false,...(method.free===undefined?{}:{free_password:method.free})})),batch_id:'LOCAL-BATCH'}}));
  }
  if(url.pathname.endsWith('/goods/buy')){
   const data=await readBody(request),config=configured(data.goods_id),id='LOCAL-ORDER-'+(++sequence);
   purchases.push(data);const order={id,state:'TO_DELIVER',price:data.price,mode:config.resultMode??config.mode??2};vendorOrders.set(id,order);
   return response.end(JSON.stringify({code:'OK',data:order}));
  }
  if(url.pathname==='/api/market/bill_order/ask_seller_to_send_offer'){
   const data=await readBody(request);receiptRequests.push(data);
   const result=Object.fromEntries(data.bill_orders.map((id,index)=>[id,scenario.receiptFailure&&index===data.bill_orders.length-1?'Seller Offer Forbidden':'OK']));
   return response.end(JSON.stringify({code:'OK',data:result}));
  }
  if(url.pathname==='/api/market/bill_order/batch/info'){
   const id=url.searchParams.get('bill_orders'),order=vendorOrders.get(id);
   return response.end(JSON.stringify({code:'OK',data:{items:order?[{...order,state:'SUCCESS'}]:[]}}));
  }
  return response.end('{}');
 }catch(error){response.statusCode=500;response.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>vendor.listen(0,'127.0.0.1',resolve));
const {chromium}=await loadPlaywright(),options={headless:true};
if(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE)options.executablePath=process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
const context=await chromium.launchPersistentContext('',options);
const baseURL='http://127.0.0.1:'+vendor.address().port;
await context.route('**/*',route=>new URL(route.request().url()).origin===baseURL?route.continue():route.abort('blockedbyclient'));
const browser=new BuffBrowser({context,baseURL,timeoutMs:3000});
const settings={ratio:.7,autoBuy:true,expectedSteamId:steamId};
const plan={buffId:'1',bidNet:100,quantity:2,unitCost:10,maxPrice:10,totalCost:20,steamId};
let checks=0;
async function expectSkip(name,config){
 scenario=config;const before=purchases.length,result=await browser.buy(plan,settings);
 assert.equal(result.status,'cancelled',name);assert.equal(result.final,true,name);assert.equal(result.skip,true,name);assert.equal(result.skipCode,'UNSUPPORTED_TRADE_MODE',name);assert.equal(result.totalCost,0,name);assert.equal(purchases.length,before,name+' must not send a buy request');checks++;
}
try{
 await browser.open();
 scenario={mode:2};let result=await browser.buy(plan,settings);
 assert.equal(result.status,'paid',JSON.stringify(result));assert.equal(result.final,true);assert.equal(result.totalCost,20);assert.equal(receiptRequests.length,0,'mode 2 is already seller delivery');checks++;
 scenario={mode:2,methods:[funds(56,{free:undefined})]};result=await browser.buy(plan,settings);
 assert.equal(result.status,'paid','semantic available funds match must not depend on method 43');assert.equal(purchases.at(-1).pay_method,56);checks++;
 scenario={mode:2,methods:[funds(56,{ejzb_auth:{}})]};result=await browser.buy(plan,settings);assert.equal(result.status,'paid','empty auth metadata is the normal direct payment path');checks++;
 await expectSkip('extra authorization required',{mode:2,methods:[funds(56,{ejzb_auth:{required:true}})]});
 await expectSkip('NetEase balance alone',{mode:2,methods:[{value:1,name:'网易支付余额',selectable:true,free:true}]});
 await expectSkip('mixed external payment',{mode:2,methods:[funds(75,{name:'BUFF可用资金 + 银行卡',free:true})]});
 await expectSkip('unselectable funds',{mode:2,methods:[funds(43,{selectable:false,free:true})]});
 await expectSkip('disabled funds',{mode:2,methods:[funds(43,{disabled:true,free:true})]});
 await expectSkip('explicit password requirement',{mode:2,methods:[funds(43,{free:false})]});
 await expectSkip('unknown offer mode',{mode:99});
 await expectSkip('seller requires buyer offer',{mode:2,orderFlags:{force_buyer_send_offer:1}});
 await expectSkip('seller offer explicitly forbidden',{mode:5,orderFlags:{can_ask_seller_to_send_offer:false}});
 await expectSkip('missing native seller-offer template',{mode:5,template:false});
 scenario={mode:2,resultMode:99};result=await browser.buy(plan,settings);assert.equal(result.status,'paid');assert.ok(result.receiptError,'unexpected actual order mode must preserve payment and require receipt review');assert.notEqual(result.skip,true);checks++;
 scenario={mode:5};const beforeReceipt=receiptRequests.length;result=await browser.buy(plan,settings);
 assert.equal(result.status,'paid');assert.equal(result.receiptRequested,true);assert.equal(receiptRequests.length,beforeReceipt+1);assert.deepEqual(receiptRequests.at(-1).bill_orders,result.orders.map(order=>order.id));assert.equal(receiptRequests.at(-1).steamid,steamId);checks++;
 scenario={mode:5,receiptFailure:true};result=await browser.buy(plan,settings);
 assert.equal(result.status,'paid','a failed seller-offer request cannot erase confirmed payment');assert.equal(result.final,true);assert.equal(result.totalCost,20);assert.ok(result.receiptError,'each bill-order result must be validated');assert.notEqual(result.skip,true);assert.notEqual(result.receiptRequested,true);checks++;
 scenario={mode:2,forcePaymentMethod:1};const beforeGuard=purchases.length;result=await browser.buy(plan,settings);
 assert.equal(purchases.length,beforeGuard,'route must pin the chosen funds method and block payment-source drift');assert.equal(result.status,'cancelled');checks++;

 // Real HTTP runner plus real browser: unsupported first candidate is skipped,
 // and the following candidate completes the same task without any lost budget.
 scenario={mode:2,goods:{'1':{methods:[{value:1,name:'网易支付余额',selectable:true,free:true}]},'2':{methods:[funds(56,{free:true})]}}};
 await mkdir('.diagnostics',{recursive:true});
 app=await createApp({dir:path.resolve('.diagnostics/trade-mode-'+Date.now()),browser,fetcher:async()=>({fetchedAt:new Date().toISOString(),scope:'本地虚构行情',rows:[1,2].map(id=>({buffId:id,appid:730,cnName:'付款方式测试饰品'+id,hashName:'Local trade-mode item '+id,buffSellPrice:.1,steamBuyPrice:id===1?1.2:1,steamSellPrice:1.4,steamTransactionQuantity:100,updateTime:new Date().toISOString()}))})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const appBase='http://127.0.0.1:'+app.server.address().port;
 async function api(url,payload={}){const response=await fetch(appBase+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const json=await response.json();assert.ok(response.ok,json.error||url+' failed');return json;}
 async function command(type,payload){return api('/api/command',{key:randomUUID(),type,payload});}
 await command('settings',{autoRefresh:false,autoBuy:true,expectedSteamId:steamId,maxBatchSpend:30,maxUnits:2});await api('/api/refresh',{wait:true});await command('job-create',{name:'跳过不支持饰品后继续',budget:20});
 const id=app.view().activeJob.id,beforeJob=purchases.length;await api('/api/jobs/run',{id,wait:true});
 const view=app.view(),job=view.jobs.find(job=>job.id===id);
 assert.equal(job.status,'completed');assert.equal(job.spent,20);assert.equal(job.remaining,0);assert.equal(purchases.length,beforeJob+2);assert.ok(purchases.slice(beforeJob).every(order=>order.goods_id==='2'&&order.pay_method===56));
 assert.ok(view.events.some(event=>event.type==='trade-mode-skip'),'skips must be visible in the audit ledger');checks++;
 console.log(`PASS: ${checks} genuine-browser trade-mode checks, including semantic BUFF available funds, dynamic method IDs, unsupported-item skips, seller-offer confirmation and per-order response checks, payment-route protection, and continuous procurement after a skipped candidate. Local fictional payments only.`);
}finally{
 if(app)await new Promise(resolve=>app.server.close(resolve));
 await browser.close();await new Promise(resolve=>vendor.close(resolve));
}
