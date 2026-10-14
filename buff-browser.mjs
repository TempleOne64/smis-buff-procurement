import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {access,mkdir} from 'node:fs/promises';

const BUFF='https://buff.163.com';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const positiveInt=value=>Number.isSafeInteger(value)&&value>0;

export async function loadPlaywright(){
 try{return await import('playwright');}catch{}
 const file=path.join(process.env.USERPROFILE||'','.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright','index.mjs');
 try{await access(file);return await import(pathToFileURL(file).href);}catch{throw Error('未找到浏览器组件。请运行 setup.cmd 安装 Playwright，然后重新启动程序。');}
}

export function priceCents(value){
 const text=String(value??'').trim().replace(/[¥￥,\s]/g,'');
 if(!/^\d+(?:\.\d{1,2})?$/.test(text))return null;
 const [whole,fraction='']=text.split('.');const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 return Number.isSafeInteger(cents)?cents:null;
}

export function classifyOrder(order){
 const state=String(order?.state||'').toUpperCase();
 // These named states are used by BUFF's current webpage, not invented numeric mappings.
 if(state==='SUCCESS')return 'received';
 if(state==='TO_DELIVER')return 'paid';
 if(state==='PAYING')return 'unknown';
 return 'unknown';
}

function bodyObject(request){
 try{return request.postDataJSON()||{};}catch{try{return Object.fromEntries(new URLSearchParams(request.postData()||''));}catch{return {};}}
}
function centsFromOrder(order){return priceCents(order?.price??order?.pay_price??order?.amount);}
// BUFF's PayPopup defaults a missing free_password flag to direct payment.
function methodIsFree(value){return value!==false&&value!=='false';}
function quoteChanged(message){const error=Error(message);error.code='QUOTE_CHANGED';return error;}
function unsupportedTradeMode(message){const error=Error(message);error.code='UNSUPPORTED_TRADE_MODE';return error;}
async function within(promise,timeoutMs,message){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeoutMs);})]);}finally{clearTimeout(timer);}
}

export class BuffBrowser{
 constructor({profileDir=path.resolve('data/buff-profile'),onStatus=()=>{},canSubmit=()=>true,context=null,launchOptions={},baseURL=BUFF,timeoutMs=20000}={}){
  if(baseURL!==BUFF&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL))throw Error('浏览器来源不允许');
  this.profileDir=profileDir;this.onStatus=onStatus;this.canSubmit=canSubmit;this.context=context;this.launchOptions=launchOptions;this.baseURL=baseURL;this.timeoutMs=timeoutMs;
  this.page=null;this.bound=false;this.locked=false;this.permit=null;this.receiptPermit=null;this.sellOrders=[];this.sellOrdersFor=null;this.orderMap=new Map();this.buyEvents=[];this.lastAccount=null;this.lastPreview=null;
  this.current={state:'closed',steamId:null,error:null,openedAt:null};
 }
 status(){return {...this.current};}
 update(patch){this.current={...this.current,...patch};this.onStatus(this.status());return this.status();}
 async exclusive(work){if(this.locked)throw Error('BUFF 浏览器正在执行另一项操作');this.locked=true;try{return await work();}finally{this.locked=false;}}
 async open(){
  return this.exclusive(async()=>{
   if(this.context&&this.page&&!this.page.isClosed())return this.status();
   if(!this.context){
    const {chromium}=await loadPlaywright();await mkdir(this.profileDir,{recursive:true});
    const custom=process.env.BUFF_BROWSER_EXECUTABLE;
    const launch={headless:false,locale:'zh-CN',viewport:{width:1280,height:900},...this.launchOptions};
    if(custom)launch.executablePath=custom;
    else if(!launch.executablePath&&!launch.channel)launch.channel='msedge';
    try{this.context=await chromium.launchPersistentContext(this.profileDir,launch);}
    catch(e){this.update({state:'blocked',error:'浏览器启动失败：'+e.message});throw Error(this.current.error);}
   }
   this.page=this.context.pages()[0]||await this.context.newPage();await this.attach();
   this.update({state:'login_required',error:null,openedAt:new Date().toISOString()});
   await this.page.goto(this.baseURL+'/goods/42346',{waitUntil:'domcontentloaded',timeout:this.timeoutMs});
   await this.readAccount({});return this.status();
  });
 }
 async attach(){
  if(this.bound)return;this.bound=true;
  this.context.on('close',()=>{this.context=null;this.page=null;this.bound=false;this.permit=null;this.update({state:'closed',steamId:null,error:null});});
  this.context.on('page',page=>page.on('response',response=>this.observe(response).catch(()=>{})));
  for(const page of this.context.pages())page.on('response',response=>this.observe(response).catch(()=>{}));
  // A dedicated automation browser cannot submit a purchase without an active, bounded plan.
  await this.context.route(this.baseURL+'/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()!=='POST')return route.continue();
   if(url.pathname==='/api/market/goods/batch_buy/create')return route.abort('blockedbyclient');
   if(url.pathname==='/api/market/bill_order/ask_seller_to_send_offer'){
    const data=bodyObject(request),permit=this.receiptPermit;
    const refs=Array.isArray(data.bill_orders)?data.bill_orders.map(String):String(data.bill_orders||'').split(',');
    if(!permit||String(data.steamid)!==permit.steamId||!refs.length||refs.some(id=>!permit.refs.has(id)))return route.abort('blockedbyclient');
    return route.continue();
   }
   if(url.pathname!=='/api/market/goods/buy')return route.continue();
   const data=bodyObject(request),permit=this.permit;
   const id=String(data.sell_order_id||''),cost=priceCents(data.price),method=Number(data.pay_method);
   const known=permit?.orders.get(id);
   if(permit?.blocked)return route.abort('blockedbyclient');
   const controlChanged=!permit||!this.canSubmit(permit.plan)||String(data.goods_id)!==permit.buffId||String(data.steamid)!==permit.steamId||permit.used.has(id)||cost===null;
   const modeChanged=permit&&method!==permit.payMethod;
   const marketChanged=!known||cost!==known.unitCost||cost<permit?.minUnitPrice||cost>permit?.maxPrice||(permit&&permit.total+cost>permit.ceiling);
   if(controlChanged||modeChanged||marketChanged){
    if(permit){permit.blocked=true;permit.blockReason=controlChanged?'CONTROL_CHANGED':modeChanged?'UNSUPPORTED_TRADE_MODE':'QUOTE_CHANGED';}
    return route.abort('blockedbyclient');
   }
   permit.used.add(id);permit.requests.add(request);permit.total+=cost;return route.continue();
  });
 }
 async observe(response){
  const url=new URL(response.url());if(url.origin!==this.baseURL||!url.pathname.includes('/api/'))return;
  if(!/user\/info|goods\/sell_order|batch_buy\/preview|goods\/buy$|bill_order|buy_order/.test(url.pathname))return;
  let json;try{json=await response.json();}catch{return;}
  if(url.pathname.includes('/user/info')&&json.code==='OK')this.lastAccount=json.data?.user_info||null;
  if(url.pathname.endsWith('/goods/sell_order')&&json.code==='OK'&&Array.isArray(json.data?.items)){
   this.sellOrdersFor=String(url.searchParams.get('goods_id')||json.data.items[0]?.goods_id||'');
   this.sellOrders=json.data.items.map(item=>({id:String(item.id),buffId:String(item.goods_id||url.searchParams.get('goods_id')||''),unitCost:priceCents(item.price),raw:item})).filter(item=>item.id&&positiveInt(item.unitCost));
   this.sellOrdersAt=Date.now();
  }
  if(url.pathname.endsWith('/batch_buy/preview'))this.lastPreview={...json,at:Date.now()};
  if(url.pathname.endsWith('/goods/buy')){
   const data=bodyObject(response.request());
   const event={code:json.code,id:json.data?.id?String(json.data.id):null,cost:priceCents(data.price),status:classifyOrder(json.data),mode:json.data?.mode,error:json.error||null,sellId:String(data.sell_order_id||'')};
   if(this.permit?.requests?.has(response.request()))this.buyEvents.push(event);
   if(event.id)this.orderMap.set(event.id,{...json.data,id:event.id,cost:event.cost,observedAt:Date.now(),source:url.pathname});
  }
  if(url.pathname==='/api/market/bill_order/batch/info'&&json.code==='OK'){
   const items=Array.isArray(json.data?.items)?json.data.items:[];
   for(const item of items){if(item.id)this.orderMap.set(String(item.id),{...item,id:String(item.id),cost:centsFromOrder(item)??this.orderMap.get(String(item.id))?.cost,observedAt:Date.now(),source:url.pathname});}
  }
 }
 async readAccount(settings){
  if(!this.page||this.page.isClosed())return this.update({state:'closed',steamId:null,error:null});
  const info=await this.page.evaluate(()=>{
   let steamId=null;
   try{steamId=window.MultiSteamId?.().get_steamid('purchase')||null;}catch{}
   const user=window.g?.user;
   return {steamId:steamId||user?.steamid||null,loggedIn:!!user?.id,currency:window.g?.currency?.code||null};
  });
  const id=String(info.steamId||this.lastAccount?.steamid||'');
  if(!info.loggedIn)return this.update({state:'login_required',steamId:null,error:'BUFF 登录状态已经失效，请在专用浏览器重新登录。'});
  if(!/^765\d{14}$/.test(id))return this.update({state:'login_required',steamId:null,error:'请在专用浏览器登录 BUFF，并检查目标 Steam 账号绑定。'});
  if(info.currency!=='CNY')return this.update({state:'blocked',steamId:id,error:'BUFF 页面币种未明确为人民币，已停止自动采购。'});
  if(settings.expectedSteamId&&id!==String(settings.expectedSteamId))return this.update({state:'blocked',steamId:id,error:'BUFF 当前收货 Steam 账号与设置不一致。'});
  return this.update({state:'ready',steamId:id,error:null});
 }
 async check(settings={}){
  return this.exclusive(async()=>{
   if(!this.page||this.page.isClosed())throw Error('请先打开 BUFF 专用浏览器');
   await this.page.reload({waitUntil:'domcontentloaded',timeout:this.timeoutMs});
   await sleep(500);let status=await this.readAccount(settings);
   if(status.state==='login_required'&&await this.page.locator('#batch-buy-btn').isVisible().catch(()=>false)){
    try{await this.page.locator('#batch-buy-btn').click({timeout:3000});await sleep(500);status=await this.readAccount(settings);}catch{}
   }
   return status;
  });
 }
 async inspect(candidate,settings){return this.exclusive(()=>this.inspectPage(candidate,settings));}
 async refreshSellOrders(dialog,buffId,maxPrice){
  // Bind the quote to the request caused by this price change, not another
  // response from the default dialog or an older filter request.
  const pending=this.page.waitForRequest(request=>{
   const url=new URL(request.url());return url.origin===this.baseURL&&url.pathname.endsWith('/goods/sell_order')&&String(url.searchParams.get('goods_id'))===buffId&&priceCents(url.searchParams.get('max_price'))===maxPrice;
  },{timeout:this.timeoutMs});pending.catch(()=>{});
  const price=dialog.locator('#batch-buy-max-price');await price.fill((maxPrice/100).toFixed(2));await price.dispatchEvent('change');
  const request=await pending,response=await within(request.response(),this.timeoutMs,'BUFF 卖单响应超时，请检查网络');
  if(!response||!response.ok())throw Error('BUFF 卖单请求未正常完成，请重新检查页面与网络');
  const json=await within(response.json(),this.timeoutMs,'BUFF 卖单内容读取超时');
  if(json.code!=='OK'||!Array.isArray(json.data?.items))throw Error('BUFF 未返回有效的实时卖单');
  const orders=json.data.items.map(item=>({id:String(item.id||''),buffId:String(item.goods_id||buffId),unitCost:priceCents(item.price),raw:item})).filter(order=>order.id&&order.buffId===buffId&&positiveInt(order.unitCost)&&order.unitCost<=maxPrice).sort((a,b)=>a.unitCost-b.unitCost);
  return orders;
 }
 async waitTotal(locator,expected,label){
  let amount=null;const until=Date.now()+Math.min(this.timeoutMs,2500);
  do{
   amount=priceCents(await locator.first().innerText({timeout:this.timeoutMs}));
   if(amount===expected)return;
   await sleep(100);
  }while(Date.now()<until);
  if(amount===null)throw Error(`BUFF ${label}无法识别，请检查页面结构`);
  throw quoteChanged(`BUFF ${label}与最新卖单暂未一致，自动重新核价`);
 }
 async sellerOfferOrders(orders){
  // Official sell-order mode 2 delivers from the seller; mode 5 exposes the
  // native "ask seller" choice after payment. Unknown modes cannot prove support.
  let hasAskSellerTemplate;
  const accepted=[];
  for(const order of orders){
   const raw=order.raw,mode=Number(raw.mode);
   if(![2,5].includes(mode)||[true,1,'1','true'].includes(raw.force_buyer_send_offer)||[false,0,'0','false'].includes(raw.can_ask_seller_to_send_offer))continue;
   if(mode===5){
    hasAskSellerTemplate??=await this.page.locator('#manual_plus_pay_success_pat').evaluateAll(nodes=>nodes.some(node=>/id=["']ask_seller["']/.test(node.textContent||'')));
    if(!hasAskSellerTemplate)continue;
   }
   accepted.push(order);
  }
  return accepted;
 }
 async chooseBuffFunds(cashier){
  const read=()=>cashier.locator('.pay-item, .unselectable-pay-item').evaluateAll(nodes=>{
   const nonempty=value=>{
    if(value===undefined||value===null||value===false||value===0||value===''||value==='undefined')return false;
    if(typeof value==='string'){try{const parsed=JSON.parse(value);if(parsed!==value)return nonempty(parsed);}catch{}return true;}
    return typeof value==='object'?Object.keys(value).length>0:!!value;
   };
   return nodes.map((node,index)=>{
   const heading=node.querySelector('.epay-info h5, h5')?.cloneNode(true);
   heading?.querySelectorAll('.c_Blue,.tag,i,.balance').forEach(part=>part.remove());
   let meta={};try{meta=JSON.parse(node.getAttribute('data-method')||'{}');}catch{}
   return {index,value:Number(node.getAttribute('data-value')),name:(heading?.textContent||node.textContent||'').trim(),free:node.getAttribute('data-free_password'),selectable:node.classList.contains('pay-item')&&!node.classList.contains('disabled')&&!node.classList.contains('i_Btn_disabled')&&!node.hasAttribute('disabled')&&node.getAttribute('aria-disabled')!=='true',visible:!!node.getClientRects().length,extra:nonempty(node.getAttribute('data-ejzb_auth'))||nonempty(meta.ejzb_auth)||nonempty(meta.error)||nonempty(meta.error_entry)||nonempty(meta.children)||!!meta.sub_pay?.selected||!!node.querySelector('.mix-item, [name=sub_pay] [value=selected].on')};
   });
  });
  const eligible=method=>Number.isSafeInteger(method.value)&&method.value>0&&/^(?:BUFF\s*可用资金|BUFF\s*available\s*(?:funds|balance))$/i.test(method.name)&&method.selectable&&!method.extra&&methodIsFree(method.free);
  let methods=await read(),chosen=methods.find(eligible);
  if(chosen&&!chosen.visible){
   const expand=cashier.locator('#j_fold-handler');
   if(await expand.isVisible().catch(()=>false)){await expand.click({timeout:this.timeoutMs});methods=await read();chosen=methods.find(m=>eligible(m)&&m.visible);}
   else chosen=null;
  }
  if(!chosen)throw unsupportedTradeMode('该饰品没有可直接使用的 BUFF 可用资金付款选项，已跳过');
  await cashier.locator('.pay-item, .unselectable-pay-item').nth(chosen.index).click({timeout:this.timeoutMs});
  return chosen.value;
 }
 async askSeller(paid,orders,steamId){
  const modes=new Map(orders.map(order=>[order.id,Number(order.raw.mode)]));
  for(const order of paid){
   if(order.mode!==undefined&&order.mode!==null){const mode=Number(order.mode);if(![2,5].includes(mode))throw Error('实际订单的收货模式已变化，已保留付款记录，请核对收货');modes.set(order.sellId,mode);}
  }
  const sellerChoice=paid.filter(order=>modes.get(order.sellId)===5),pending=sellerChoice.filter(order=>order.status!=='received');
  if(!pending.length)return {receiptRequested:false,receiptMode:'seller'};
  const refs=new Set(sellerChoice.map(order=>order.id));this.receiptPermit={steamId,refs};
  const ask=this.page.locator('#j_popup_payed #ask_seller'),until=Date.now()+this.timeoutMs;
  while(Date.now()<until){
   if(await ask.isVisible().catch(()=>false))break;
   const resultDialog=this.page.locator('.popup:visible').filter({hasText:/批量购买结果|批量购买成功|Buying in bulk results|Bulk.*results|Purchase results/i});
   if(await resultDialog.count()===1){const confirm=resultDialog.locator('.i_Btn_main');if(await confirm.count()===1)await confirm.click({timeout:3000});}
   await sleep(100);
  }
  if(!await ask.isVisible().catch(()=>false))throw Error('已确认付款，但未出现让卖家发起报价的入口，请核对收货');
  const requestPromise=this.page.waitForRequest(request=>new URL(request.url()).origin===this.baseURL&&new URL(request.url()).pathname==='/api/market/bill_order/ask_seller_to_send_offer'&&request.method()==='POST',{timeout:this.timeoutMs});requestPromise.catch(()=>{});
  await ask.click({timeout:this.timeoutMs});const request=await requestPromise;
  const response=await within(request.response(),this.timeoutMs,'卖家发起报价请求未返回，请核对收货');
  if(!response||!response.ok())throw Error('卖家发起报价请求失败，已保留付款记录');
  const json=await within(response.json(),this.timeoutMs,'卖家报价结果读取超时');
  if(json.code!=='OK'||pending.some(order=>json.data?.[order.id]!=='OK'))throw Error('平台未确认全部订单可以由卖家发起报价，已保留付款记录');
  return {receiptRequested:true,receiptMode:'seller'};
 }
 async inspectPage(candidate,settings){
  if(!this.page||this.page.isClosed())throw Error('请先打开并登录 BUFF 专用浏览器');
  const buffId=String(candidate.buffId);if(!/^\d+$/.test(buffId))throw Error('BUFF 商品标识无效');
  if(!positiveInt(candidate.bidNet))throw Error('缺少有效 Steam 求购净额');
  this.sellOrders=[];this.sellOrdersAt=0;this.sellOrdersFor=null;
  await this.page.goto(this.baseURL+'/goods/'+buffId,{waitUntil:'domcontentloaded',timeout:this.timeoutMs});
  await this.readAccount(settings);
  const actor=this.status();if(actor.state!=='ready')throw Error(actor.error||'BUFF 登录状态需要处理');
  if(!settings.expectedSteamId||actor.steamId!==String(settings.expectedSteamId))throw Error('请在设置中确认目标 SteamID，再执行购买预检。');
  await this.page.locator('#batch-buy-btn').click({timeout:this.timeoutMs});
  const dialog=this.page.locator('#j_popup_batchbuy');await dialog.waitFor({state:'visible',timeout:this.timeoutMs});
  const maxPrice=Math.ceil(candidate.bidNet*settings.ratio)-1;
  if(!positiveInt(maxPrice))throw Error('按采购比例没有有效最高价');
  const matching=(await this.refreshSellOrders(dialog,buffId,maxPrice)).filter(o=>o.unitCost/candidate.bidNet<settings.ratio);
  // BUFF bulk purchase picks the lowest offers. A low offer makes this item ineligible,
  // even if more expensive orders exist, rather than paying extra for the same item.
  const eligible=matching.some(o=>o.unitCost<(settings.minUnitPrice??0))?[]:matching;
  const acceptedIds=new Set((await this.sellerOfferOrders(eligible)).map(order=>order.id)),orders=[];
  for(const order of eligible){if(!acceptedIds.has(order.id))break;orders.push(order);}
  // Bulk UI always chooses the cheapest rows; do not silently substitute higher
  // offers while an unsupported row is still in that selection.
  if(eligible.length&&!orders.length)throw unsupportedTradeMode('当前卖单不支持指定收货方式，需让卖家发起报价，已跳过');
  const grouped=new Map();for(const order of orders)grouped.set(order.unitCost,(grouped.get(order.unitCost)||0)+1);
  this.inspection={buffId,steamId:actor.steamId,checkedAt:new Date().toISOString(),maxPrice,orders,candidate};
  return {buffId,steamId:actor.steamId,depth:[...grouped].map(([unitCost,quantity])=>({unitCost,quantity})),checkedAt:this.inspection.checkedAt};
 }
 async buy(plan,settings){
  return this.exclusive(async()=>{
   let paymentPermit=null;
   this.buyEvents=[];
   try{
    if(settings.autoBuy!==true)throw Error('自动采购未开启');
    if(!positiveInt(plan.quantity)||!positiveInt(plan.totalCost))throw Error('采购计划金额或数量无效');
    const candidate={buffId:plan.buffId,name:plan.name,bidNet:plan.bidNet};
    await this.inspectPage(candidate,settings);
    let orders=this.inspection.orders.slice(0,plan.quantity);
    if(orders.length!==plan.quantity)throw quoteChanged('实际可买数量已经变化，自动重新核价');
    const minUnitPrice=Math.max(plan.minUnitPrice??0,settings.minUnitPrice??0);
    const checkQuote=()=>{
     if(orders.length!==plan.quantity||orders.some(o=>o.unitCost<minUnitPrice||o.unitCost>(plan.maxPrice??plan.unitCost)||o.unitCost/plan.bidNet>=(plan.ratioLimit??settings.ratio))||orders.reduce((n,o)=>n+o.unitCost,0)>plan.totalCost)throw quoteChanged('实时价格或数量发生变化，按采购条件重新规划');
    };checkQuote();
    const dialog=this.page.locator('#j_popup_batchbuy');
    // The UI rebuilds its selected offers when the maximum price changes.
    // Re-read that exact response before comparing its asynchronously updated total.
    const quoteMax=Math.max(...orders.map(o=>o.unitCost));
    const refreshed=await this.refreshSellOrders(dialog,String(plan.buffId),quoteMax);
    if(refreshed.some(o=>o.unitCost<minUnitPrice))throw quoteChanged('最新卖单低于单件最低采购金额，重新选择饰品');
    orders=refreshed.slice(0,plan.quantity);checkQuote();
    if((await this.sellerOfferOrders(orders)).length!==orders.length)throw unsupportedTradeMode('最新卖单不支持让卖家发起报价，已跳过');
    const actualTotal=orders.reduce((n,o)=>n+o.unitCost,0),max=Math.max(...orders.map(o=>o.unitCost));
    await dialog.locator('#batch-buy-num').fill(String(plan.quantity));await dialog.locator('#batch-buy-num').dispatchEvent('change');
    await this.waitTotal(dialog.locator('.total_amount'),actualTotal,'批量购买总价');
    if(Number(await dialog.locator('#batch-buy-num').inputValue())!==plan.quantity)throw quoteChanged('BUFF 已调整可购买数量，自动重新核价');
    this.lastPreview=null;
    await dialog.locator('.i_Btn_main').click({timeout:this.timeoutMs}); // Preview only; payment not yet permitted.
    const cashier=this.page.locator('#j_popup_epay');await cashier.waitFor({state:'visible',timeout:this.timeoutMs});
    const payMethod=await this.chooseBuffFunds(cashier);
    await this.waitTotal(cashier.locator('.total_price'),actualTotal,'付款总额');
    const actor=await this.readAccount(settings);if(actor.state!=='ready'||actor.steamId!==String(plan.steamId||settings.expectedSteamId))throw Error('付款前 Steam 收货账号核对失败');
    const pay=cashier.locator('.pay-btn');if(await pay.evaluate(node=>node.classList.contains('error-pay')||node.classList.contains('i_Btn_disabled')))throw unsupportedTradeMode('该饰品当前不可使用 BUFF 可用资金付款，已跳过');
    if(!this.canSubmit(plan))throw Error('采购任务已暂停、结束或切换，未执行付款');
    this.buyEvents=[];
    paymentPermit={plan,buffId:String(plan.buffId),steamId:actor.steamId,payMethod,minUnitPrice,maxPrice:max,ceiling:plan.totalCost,orders:new Map(orders.map(o=>[o.id,o])),used:new Set(),requests:new Set(),total:0,blocked:false,blockReason:null};
    this.permit=paymentPermit;
    await pay.click({timeout:this.timeoutMs});
    const until=Date.now()+this.timeoutMs;
    while(Date.now()<until){const unique=new Set(this.buyEvents.filter(e=>paymentPermit.orders.has(e.sellId)).map(e=>e.sellId));if(unique.size>=plan.quantity||paymentPermit.blocked||!this.context)break;await sleep(150);}
    const results=[...new Map(this.buyEvents.filter(e=>paymentPermit.orders.has(e.sellId)).map(e=>[e.sellId,e])).values()];
    const paid=results.filter(e=>e.code==='OK'&&e.id&&positiveInt(e.cost)&&['paid','received'].includes(e.status));
    const evidence=results.filter(e=>e.code==='OK'&&e.id&&positiveInt(e.cost));
    if(!paymentPermit.used.size&&!evidence.length){
     if(paymentPermit.blockReason==='QUOTE_CHANGED')throw quoteChanged('付款前卖单已变化，未发出付款请求，自动重新核价');
     if(paymentPermit.blockReason==='UNSUPPORTED_TRADE_MODE')throw unsupportedTradeMode('付款请求不再使用已核对的 BUFF 可用资金，已跳过');
     throw Error(paymentPermit.blockReason==='CONTROL_CHANGED'?'采购状态、账号或付款方式已变化，未执行付款':'BUFF 未发出可核对的付款请求，请检查页面');
    }
    const final=results.length===plan.quantity&&paid.length===plan.quantity&&new Set(paid.map(e=>e.id)).size===plan.quantity&&!paymentPermit.blocked;
    const result={status:final?(paid.every(e=>e.status==='received')?'received':'paid'):'unknown',final,steamId:actor.steamId,quantity:paid.length,totalCost:evidence.reduce((n,e)=>n+e.cost,0),orders:evidence.map(e=>({id:e.id,cost:e.cost,status:e.status})),error:final?null:'付款提交后未能完整核对全部订单，保留预算并停止新购买。'};
    if(final){
     this.permit=null;
     try{
      Object.assign(result,await this.askSeller(paid,orders,actor.steamId));
     }catch(e){result.receiptError=e.message;result.error='付款已核对；收货报价步骤需要在 BUFF 检查。';}
    }
    return result;
   }catch(e){
    // Closing the browser revokes the global permit, but cannot erase evidence
    // that a payment request already left this batch.
    const known=[...new Map(this.buyEvents.filter(event=>event.code==='OK'&&event.id&&positiveInt(event.cost)&&paymentPermit?.orders.has(event.sellId)).map(event=>[event.id,event])).values()];
    const submitted=(paymentPermit?.used.size??0)>0||known.length>0,retryable=!submitted&&e.code==='QUOTE_CHANGED',skip=!submitted&&e.code==='UNSUPPORTED_TRADE_MODE';
    if(!retryable&&!skip)this.update({state:'blocked',error:e.message});
    return {status:submitted?'unknown':'cancelled',final:!submitted,steamId:this.current.steamId,quantity:known.length,totalCost:known.reduce((sum,event)=>sum+event.cost,0),orders:known.map(event=>({id:event.id,cost:event.cost,status:event.status})),retryable,retryCode:retryable?'QUOTE_CHANGED':null,skip,skipCode:skip?'UNSUPPORTED_TRADE_MODE':null,error:e.message};
   }finally{this.permit=null;this.receiptPermit=null;}
  });
 }
 async reconcile(purchase,settings){
  return this.exclusive(async()=>{
   if(!this.page||this.page.isClosed())return {status:'unknown',final:false,error:'BUFF 浏览器未打开'};
   const refs=(purchase.orderRefs||[]).map(String);if(!refs.length)return {status:'unknown',final:false,error:'缺少可核对的 BUFF 订单号'};
   const started=Date.now();
   const game=Number(purchase.appid)===570?'dota2':'csgo';
   for(const id of refs){
    await this.page.goto(this.baseURL+'/market/buy_order/history?game='+game+'&search='+encodeURIComponent(id),{waitUntil:'domcontentloaded',timeout:this.timeoutMs});
    await this.readAccount(settings);if(this.status().state!=='ready')return {status:'unknown',final:false,error:this.status().error};
    const detail=this.page.getByText(/^(?:详情|查看详情|Details|View details)$/);
    if(await detail.count()===1)await detail.click({timeout:3000}).catch(()=>{});
    await sleep(700);
   }
   const orders=refs.map(id=>this.orderMap.get(id));
   if(orders.some(o=>!o||o.source!=='/api/market/bill_order/batch/info'||o.observedAt<started||classifyOrder(o)==='unknown'))return {status:'paid',final:false,quantity:purchase.quantity,totalCost:purchase.totalCost,orders:refs.map(id=>({id,status:'paid'})),error:'本次尚未取得全部订单的明确收货状态，继续保留在途额度。'};
   const details=orders.map(order=>({id:order.id,cost:order.cost??purchase.orderDetails?.find(item=>String(item.id)===order.id)?.cost,status:classifyOrder(order)}));
   if(details.some(order=>!positiveInt(order.cost))||details.reduce((sum,order)=>sum+order.cost,0)!==purchase.totalCost)return {status:'paid',final:false,error:'收货状态有新响应，但订单金额尚不能与已付款记录核对；付款证明继续保留。'};
   const received=orders.every(o=>classifyOrder(o)==='received');
   return {status:received?'received':'paid',final:true,steamId:this.status().steamId,quantity:purchase.quantity,totalCost:purchase.totalCost,orders:details};
  });
 }
 async close(){this.permit=null;if(this.context)await this.context.close();this.update({state:'closed',steamId:null,error:null});}
}
