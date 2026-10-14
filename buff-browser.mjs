import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {access,mkdir} from 'node:fs/promises';

const BUFF='https://buff.163.com';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const paymentMethods=new Set([1,43]); // NetEase balance and available BUFF balance.
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
function methodIsFree(value){return value===true||value==='true'||value===1||value==='1';}

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
   if(!permit||!this.canSubmit(permit.plan)||!known||permit.used.has(id)||cost===null||cost!==known.unitCost||cost<permit.minUnitPrice||cost>permit.maxPrice||
      String(data.goods_id)!==permit.buffId||String(data.steamid)!==permit.steamId||!paymentMethods.has(method)||permit.total+cost>permit.ceiling){
    if(permit)permit.blocked=true;
    return route.abort('blockedbyclient');
   }
   permit.used.add(id);permit.total+=cost;return route.continue();
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
   const event={code:json.code,id:json.data?.id?String(json.data.id):null,cost:priceCents(data.price),status:classifyOrder(json.data),error:json.error||null,sellId:String(data.sell_order_id||'')};
   this.buyEvents.push(event);
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
  const price=dialog.locator('#batch-buy-max-price');await price.fill((maxPrice/100).toFixed(2));
  await price.dispatchEvent('change');
  const until=Date.now()+this.timeoutMs;
  while(Date.now()<until){if(this.sellOrdersAt&&this.sellOrdersFor===buffId)break;await sleep(100);}
  const matching=this.sellOrders.filter(o=>o.buffId===buffId&&o.unitCost<=maxPrice&&o.unitCost/candidate.bidNet<settings.ratio).sort((a,b)=>a.unitCost-b.unitCost);
  // BUFF bulk purchase picks the lowest offers. A low offer makes this item ineligible,
  // even if more expensive orders exist, rather than paying extra for the same item.
  const orders=matching.some(o=>o.unitCost<(settings.minUnitPrice??0))?[]:matching;
  if(!this.sellOrdersAt||this.sellOrdersFor!==buffId)throw Error('BUFF 未返回可核对的真实卖单，已停止。');
  const grouped=new Map();for(const order of orders)grouped.set(order.unitCost,(grouped.get(order.unitCost)||0)+1);
  this.inspection={buffId,steamId:actor.steamId,checkedAt:new Date().toISOString(),maxPrice,orders,candidate};
  return {buffId,steamId:actor.steamId,depth:[...grouped].map(([unitCost,quantity])=>({unitCost,quantity})),checkedAt:this.inspection.checkedAt};
 }
 async buy(plan,settings){
  return this.exclusive(async()=>{
   let submitted=false;
   try{
    if(settings.autoBuy!==true)throw Error('自动采购未开启');
    if(!positiveInt(plan.quantity)||!positiveInt(plan.totalCost))throw Error('采购计划金额或数量无效');
    const candidate={buffId:plan.buffId,name:plan.name,bidNet:plan.bidNet};
    await this.inspectPage(candidate,settings);
    const inspected=this.inspection,orders=inspected.orders.slice(0,plan.quantity);
    if(orders.length!==plan.quantity)throw Error('实际可买数量已经变化，重新分析后再采购');
    const actualTotal=orders.reduce((n,o)=>n+o.unitCost,0);
    const minUnitPrice=Math.max(plan.minUnitPrice??0,settings.minUnitPrice??0);
    if(actualTotal>plan.totalCost||orders.some(o=>o.unitCost<minUnitPrice||o.unitCost>(plan.maxPrice??plan.unitCost)))throw Error('实际卖单价格不符合单件价格范围或预留预算，已停止');
    const dialog=this.page.locator('#j_popup_batchbuy');
    // Match the precise plan price again before a preview can enter the cashier.
    const max=Math.max(...orders.map(o=>o.unitCost));await dialog.locator('#batch-buy-max-price').fill((max/100).toFixed(2));await dialog.locator('#batch-buy-max-price').dispatchEvent('change');await sleep(350);
    await dialog.locator('#batch-buy-num').fill(String(plan.quantity));await dialog.locator('#batch-buy-num').dispatchEvent('change');
    const total=priceCents(await dialog.locator('.total_amount').first().innerText());
    if(total===null||total!==actualTotal)throw Error('BUFF 批量购买总价与核对卖单不一致');
    this.lastPreview=null;
    await dialog.locator('.i_Btn_main').click({timeout:this.timeoutMs}); // Preview only; payment not yet permitted.
    const cashier=this.page.locator('#j_popup_epay');await cashier.waitFor({state:'visible',timeout:this.timeoutMs});
    const methods=await cashier.locator('.pay-item').evaluateAll(nodes=>nodes.map((node,index)=>({index,value:Number(node.getAttribute('data-value')),free:node.getAttribute('data-free_password'),text:node.textContent||''})));
    const chosen=methods.find(m=>paymentMethods.has(m.value)&&methodIsFree(m.free));
    if(!chosen)throw Error('本次没有可用的 BUFF／网易余额免密付款选项；请在平台检查余额和免密设置');
    await cashier.locator('.pay-item').nth(chosen.index).click();
    const paymentTotal=priceCents(await cashier.locator('.total_price').first().innerText());
    if(paymentTotal===null||paymentTotal!==actualTotal||paymentTotal>plan.totalCost)throw Error('付款总额发生变化，未执行付款');
    const actor=await this.readAccount(settings);if(actor.state!=='ready'||actor.steamId!==String(plan.steamId||settings.expectedSteamId))throw Error('付款前 Steam 收货账号核对失败');
    const pay=cashier.locator('.pay-btn');if(await pay.evaluate(node=>node.classList.contains('error-pay')||node.classList.contains('i_Btn_disabled')))throw Error('付款选项不可用，等待用户处理');
    if(!this.canSubmit(plan))throw Error('采购任务已暂停、结束或切换，未执行付款');
    this.buyEvents=[];
    this.permit={plan,buffId:String(plan.buffId),steamId:actor.steamId,minUnitPrice,maxPrice:max,ceiling:plan.totalCost,orders:new Map(orders.map(o=>[o.id,o])),used:new Set(),total:0,blocked:false};
    submitted=true;
    await pay.click({timeout:this.timeoutMs});
    const until=Date.now()+this.timeoutMs;
    while(Date.now()<until){const unique=new Set(this.buyEvents.filter(e=>this.permit.orders.has(e.sellId)).map(e=>e.sellId));if(unique.size>=plan.quantity||this.permit.blocked)break;await sleep(150);}
    const results=[...new Map(this.buyEvents.filter(e=>this.permit.orders.has(e.sellId)).map(e=>[e.sellId,e])).values()];
    const paid=results.filter(e=>e.code==='OK'&&e.id&&positiveInt(e.cost)&&['paid','received'].includes(e.status));
    const evidence=results.filter(e=>e.code==='OK'&&e.id&&positiveInt(e.cost));
    const final=results.length===plan.quantity&&paid.length===plan.quantity&&new Set(paid.map(e=>e.id)).size===plan.quantity&&!this.permit.blocked;
    const result={status:final?(paid.every(e=>e.status==='received')?'received':'paid'):'unknown',final,steamId:actor.steamId,quantity:paid.length,totalCost:evidence.reduce((n,e)=>n+e.cost,0),orders:evidence.map(e=>({id:e.id,cost:e.cost,status:e.status})),error:final?null:'付款提交后未能完整核对全部订单，保留预算并停止新购买。'};
    if(final){
     try{
      this.receiptPermit={steamId:actor.steamId,refs:new Set(paid.map(e=>e.id))};
      const resultDialog=this.page.locator('.popup:visible').filter({hasText:/批量购买结果|Buying in bulk results|Result/});
      if(await resultDialog.count()===1){const confirm=resultDialog.locator('.i_Btn_main');if(await confirm.count()===1)await confirm.click({timeout:3000});}
      const askSeller=this.page.locator('#j_popup_payed #ask_seller');
      if(await askSeller.isVisible().catch(()=>false)){await askSeller.click({timeout:5000});result.receiptRequested=true;}
     }catch(e){result.receiptError=e.message;result.error='付款已核对；收货报价步骤需要在 BUFF 检查。';}
    }
    return result;
   }catch(e){
    this.update({state:'blocked',error:e.message});
    const known=submitted?[...new Map(this.buyEvents.filter(event=>event.code==='OK'&&event.id&&positiveInt(event.cost)&&this.permit?.orders.has(event.sellId)).map(event=>[event.id,event])).values()]:[];
    return {status:submitted?'unknown':'cancelled',final:!submitted,steamId:this.current.steamId,quantity:known.length,totalCost:known.reduce((sum,event)=>sum+event.cost,0),orders:known.map(event=>({id:event.id,cost:event.cost,status:event.status})),error:e.message};
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
