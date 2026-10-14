import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Store} from './store.mjs';
import {applyBrowserResult,control,getJobs,opportunities,planPurchase,reservePurchase,states,totals} from './core.mjs';
import {fetchSnapshot} from './smis.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const demoSteamId='76561198000000000';
const iso=()=>new Date().toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fault(message,code='NEEDS_ACTION'){return Object.assign(Error(message),{code});}

function demonstrationBrowser(){
 return {
  status:()=>({state:'ready',steamId:demoSteamId,error:null}),open:async()=>{},close:async()=>{},
  inspect:async candidate=>({buffId:candidate.buffId,steamId:demoSteamId,depth:[{unitCost:candidate.cost,quantity:100}],checkedAt:iso()}),
  buy:async plan=>({status:'received',final:true,steamId:demoSteamId,orders:plan.depth.flatMap(d=>Array.from({length:d.quantity},()=>({id:'DEMO-'+randomUUID(),cost:d.unitCost,status:'received'}))),quantity:plan.quantity,totalCost:plan.totalCost}),
  reconcile:async purchase=>({status:'received',final:true,steamId:demoSteamId,orders:purchase.orderDetails||[],quantity:purchase.quantity,totalCost:purchase.totalCost})
 };
}
function unavailableBrowser(error){return {status:()=>({state:'blocked',steamId:null,error}),open:async()=>{throw Error(error);},inspect:async()=>{throw Error(error);},buy:async()=>{throw Error(error);},reconcile:async()=>{throw Error(error);},close:async()=>{}};}
function csv(rows){return '\uFEFF'+rows.map(row=>row.map(value=>'"'+String(value??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');}
function exportsFor(state,{salesOnly=false}={}){
 const rows=[['记录类型','记录ID','任务ID','采购批次ID','饰品名称','BUFF商品ID','状态','件数','采购实付或冻结元','确认退款元','Steam买方支付元','Steam手续费元','Steam实际净收入元','BUFF订单号或销售凭证','记录时间']];
 if(!salesOnly)for(const p of state.purchases)rows.push(['采购',p.id,p.jobId||'',p.id,p.name,p.buffId,states[p.status]||p.status,p.quantity,(p.totalCost/100).toFixed(2),((p.refund||0)/100).toFixed(2),'','','',(p.orderRefs||[]).join(' '),p.createdAt]);
 for(const sale of state.sales||[]){const p=state.purchases.find(item=>item.id===sale.purchaseId);rows.push(['Steam手动销售',sale.id,p?.jobId||'',sale.purchaseId,p?.name||'',p?.buffId||'','已记账',sale.quantity,'','',(sale.gross/100).toFixed(2),(sale.fee/100).toFixed(2),(sale.net/100).toFixed(2),sale.reference||'',sale.occurredAt]);}
 return csv(rows);
}

export async function createApp({dir=path.join(root,'data'),demo=false,fetcher=fetchSnapshot,browser:injectedBrowser}={}){
 await mkdir(dir,{recursive:true});
 const store=new Store(path.join(dir,'funding.sqlite'));
 let refreshing=false,refreshPromise=null,automationPromise=null,browserPromise=null,reconcilePromise=null,jobRunnerPromise=null,runningJobId=null,closed=false,lastReconcile=0,lastCycle=0;
 if(demo&&!store.read().snapshot.fetchedAt){
  const s=store.read(),at=iso();s.settings.expectedSteamId=demoSteamId;
  s.snapshot={fetchedAt:at,scope:'虚构演示数据，不用于真实采购',rows:[{buffId:42346,appid:730,cnName:'演示饰品 A（虚构报价）',hashName:'Demo item',buffSellPrice:2,steamBuyPrice:4,steamTransactionQuantity:120,updateTime:at},{buffId:1116126,appid:730,cnName:'演示饰品 B（虚构报价）',hashName:'Demo item B',buffSellPrice:1,steamBuyPrice:2,steamTransactionQuantity:48,updateTime:at}]};store.save(s);
 }
 let browser=injectedBrowser;
 if(!browser){
  if(demo)browser=demonstrationBrowser();
  else try{
   const {BuffBrowser}=await import('./buff-browser.mjs');
   browser=new BuffBrowser({profileDir:path.join(dir,'buff-profile'),canSubmit:plan=>{
    if(closed||!plan)return false;
    const s=store.read(),job=s.jobs.find(item=>item.id===s.activeJobId);
    return !s.paused&&s.settings.autoBuy&&job?.status==='running'&&job.id===plan.jobId&&s.settings.expectedSteamId===browser.status().steamId&&(plan.minUnitPrice??0)>=s.settings.minUnitPrice&&(plan.ratioLimit??s.settings.ratio)<=s.settings.ratio;
   }});
  }catch(error){browser=unavailableBrowser(`BUFF 浏览器暂不可用：${error.message}`);}
 }
 function saveAutomation(patch){if(closed)return;const s=store.read();s.automation={...s.automation,...patch};store.save(s);}
 function recordTradeModeSkip(candidate,reason,{jobId,purchaseId,stage='inspect'}={}){
  const skipped={jobId,buffId:String(candidate.buffId),name:candidate.name,reason,stage,at:iso(),...(purchaseId?{purchaseId}:{})};
  store.update('trade-mode-skip',skipped,state=>{state.automation={...state.automation,lastSkipped:skipped,lastError:null};return state;});
 }
 function view(){
  const s=store.read(),jobs=getJobs(s),ledger=totals(s);return {version:'0.4.0',settings:s.settings,paused:s.paused,control:control(s),snapshot:s.snapshot,sync:s.sync,refreshing,candidates:opportunities(s),purchases:s.purchases,jobs,activeJobId:s.activeJobId,activeJob:jobs.find(job=>job.id===s.activeJobId)||null,sales:s.sales,ledger,totals:ledger,automation:{...s.automation,busy:Boolean(automationPromise||jobRunnerPromise),runningJobId},browser:browser.status(),states,events:store.events(),demo,legacyCount:s.legacyItems.length};
 }
 function progress(update){if(closed)return;const s=store.read();s.sync.progress={...(s.sync.progress||{}),...update,at:iso()};store.save(s);}
 function refresh({force=false}={}){
  if(closed)return Promise.reject(Error('程序正在关闭'));
  if(refreshPromise)return refreshPromise;
  const previous=store.read(),cooldown=Date.parse(previous.sync.cooldownUntil||'');
  if(!force&&cooldown>Date.now())return Promise.resolve(view());
  const s=store.read();s.sync.lastAttempt=iso();s.sync.progress={stage:'starting',message:'正在连接 SMIS',rows:0,at:iso()};s.sync.cooldownUntil=null;store.save(s);refreshing=true;
  refreshPromise=Promise.resolve().then(async()=>{
   try{
    let snapshot;
    if(demo){const old=store.read().snapshot,at=iso();snapshot={...old,fetchedAt:at,rows:old.rows.map(row=>({...row,updateTime:at}))};}
    else snapshot=await fetcher(previous.settings,fetch,{onProgress:progress});
    if(!snapshot||!Array.isArray(snapshot.rows)||!Number.isFinite(Date.parse(snapshot.fetchedAt)))throw Error('SMIS 未返回有效行情快照');
    if(!closed){const latest=store.read();latest.snapshot=snapshot;latest.sync.error=null;latest.sync.lastSuccess=iso();latest.sync.cooldownUntil=new Date(Date.now()+30000).toISOString();latest.sync.progress={stage:'done',message:`已更新 ${snapshot.rows.length} 条行情`,rows:snapshot.rows.length,at:iso()};store.save(latest);}
   }catch(error){
    if(!closed){const latest=store.read();latest.sync.error=error.message;latest.sync.cooldownUntil=null;latest.sync.progress={stage:'error',message:error.message,at:iso()};store.save(latest);}throw error;
   }finally{refreshing=false;refreshPromise=null;}
   return closed?null:view();
  });return refreshPromise;
 }
 function accountGate(state){
  const status=browser.status();
  if(status.state!=='ready')throw fault(status.error||'请打开 BUFF 专用浏览器并完成登录');
  if(!state.settings.expectedSteamId)throw fault('请先设置目标 Steam ID');
  if(String(status.steamId)!==state.settings.expectedSteamId)throw fault('BUFF 绑定 Steam 账号与目标不一致');
 }
 function previewState(jobId){
  const s=store.read(),id=jobId||s.activeJobId,job=s.jobs.find(item=>item.id===id);
  if(!job)throw fault('请先创建本次采购任务');
  if(['completed','cancelled'].includes(job.status))throw fault('采购任务已经结束，请创建新任务');
  // A preview plans against a copy. It cannot start a real task or reserve money.
  s.activeJobId=id;job.status='running';return s;
 }
 async function inspectPlan({buffId,jobId,preview=false,excludeBuffIds=new Set(),unsupportedBuffIds=new Set()}={}){
  const state=preview?previewState(jobId):store.read(),gate=control(state);
  if(!gate.canBuy)throw fault(gate.reason,gate.gateCode?.toUpperCase());
  const lockedJobId=jobId||gate.jobId;
  if(!preview&&gate.jobId!==lockedJobId)throw fault('当前采购任务已变化，未执行采购');
  accountGate(state);
  const eligible=opportunities(state).filter(q=>q.quantity>0&&(!buffId||q.buffId===String(buffId))),candidates=eligible.filter(q=>!excludeBuffIds.has(q.buffId)&&!unsupportedBuffIds.has(q.buffId)),hasUnstable=eligible.some(q=>excludeBuffIds.has(q.buffId)&&!unsupportedBuffIds.has(q.buffId));
  if(!candidates.length)throw hasUnstable?fault('合格饰品的卖单连续变化，已暂停本次任务，稍后可继续采购','QUOTES_UNSTABLE'):fault(unsupportedBuffIds.size?'没有同时支持 BUFF 可用资金付款和卖家发起报价的合格饰品，本次保留余款':'当前没有满足成本比例、日成交量和本次剩余预算的候选','NO_ELIGIBLE');
  for(const candidate of candidates){
   let inspection,inspectionError;
   try{inspection=await browser.inspect(candidate,store.read().settings);}catch(error){if(error.code!=='UNSUPPORTED_TRADE_MODE')throw error;inspectionError=error;}
   if(closed)throw fault('程序正在关闭');
   const latest=store.read();
   if(!preview&&latest.activeJobId!==lockedJobId)throw fault('核价期间采购任务已变化，未执行采购');
   accountGate(latest);
   if(inspectionError||inspection.unsupported===true&&inspection.skipCode==='UNSUPPORTED_TRADE_MODE'){
    const reason=inspectionError?.message||inspection.reason||'该饰品不同时支持 BUFF 可用资金付款和卖家发起报价，已跳过';
    unsupportedBuffIds.add(String(candidate.buffId));recordTradeModeSkip(candidate,reason,{jobId:lockedJobId});continue;
   }
   if(inspection.requiresAction)throw fault('BUFF 报价需要人工处理，未执行采购');
   if(Array.isArray(inspection.depth)&&inspection.depth.length===0)continue;
   try{return {candidate,inspection,plan:planPurchase(preview?previewState(jobId):store.read(),candidate,inspection)};}
   catch(error){if(error.code==='NO_ELIGIBLE')continue;throw error;}
  }
  if(hasUnstable)throw fault('剩余合格饰品的卖单连续变化，已暂停本次任务，稍后可继续采购','QUOTES_UNSTABLE');
  throw fault(unsupportedBuffIds.size?'没有同时支持 BUFF 可用资金付款和卖家发起报价的可买饰品，或剩余合格档位不满足金额、比例和预算；本次保留余款':'BUFF 实时可买档位不足、逐件比例不合格或剩余预算不足','NO_ELIGIBLE');
 }
 function automate({buy=false,buffId,jobId,fromRunner=false,excludeBuffIds=new Set(),unsupportedBuffIds=new Set()}={}){
  if(automationPromise)return automationPromise;
  if(jobRunnerPromise&&!fromRunner)throw fault('采购任务正在运行，请等待本轮完成或暂停任务');
  if(browserPromise||reconcilePromise)throw fault('BUFF 浏览器正在启动或核对收货，请稍候');
  saveAutomation({state:'inspecting',lastRun:iso(),lastError:null,plan:null});
  automationPromise=Promise.resolve().then(async()=>{
   let purchaseId=null;
   try{
    const shouldBuy=buy&&store.read().settings.autoBuy;
    const {candidate,inspection,plan}=await inspectPlan({buffId,jobId,preview:!shouldBuy,excludeBuffIds,unsupportedBuffIds});
    if(closed)return null;
    saveAutomation({state:'preview',lastPreview:iso(),plan});
    if(!shouldBuy)return view();
    store.update('purchase-submit',{jobId:plan.jobId,buffId:plan.buffId,quantity:plan.quantity,totalCost:plan.totalCost},state=>{
     if(!state.settings.autoBuy)throw fault('自动采购已关闭');
     if(state.activeJobId!==plan.jobId)throw fault('核价后采购任务已变化，未执行采购');
     accountGate(state);
     const latest=planPurchase(state,candidate,inspection),purchase=reservePurchase(state,latest);
     purchase.status='submitting';purchaseId=purchase.id;state.automation={...state.automation,state:'buying',purchaseId,plan:latest};return state;
    });
    const purchase=store.read().purchases.find(p=>p.id===purchaseId);
    let result;
    try{result=await browser.buy(purchase,store.read().settings);}catch(error){result={status:'unknown',final:false,orders:[],error:error.message};}
    if(closed)return null;
    // A skip label cannot override evidence of a possible charge or incomplete
    // cancellation. Only an explicit zero-amount result is safe to release.
    if(result.skip===true&&result.skipCode==='UNSUPPORTED_TRADE_MODE'&&result.status==='cancelled'&&(result.quantity!==0||result.totalCost!==0))result={...result,status:'unknown',final:false,error:result.error||'跳过结果缺少明确的未付款证明，预算保持冻结'};
    store.update('purchase-result',{purchaseId,result},state=>{
     const purchase=applyBrowserResult(state,purchaseId,result);
     if(['paid','received'].includes(purchase.status)){
      if(result.receiptError)purchase.receiptError=result.receiptError;
      if(typeof result.receiptRequested==='boolean')purchase.receiptRequested=result.receiptRequested;
      if(result.receiptMode==='seller')purchase.receiptMode='seller';
     }
     return state;
    });
    const final=store.read().purchases.find(p=>p.id===purchaseId),failed=['unknown','cancelled'].includes(final.status);
    if(final.status==='cancelled'&&result.status==='cancelled'&&result.final===true&&result.skip===true&&result.skipCode==='UNSUPPORTED_TRADE_MODE'&&result.quantity===0&&result.totalCost===0&&Array.isArray(result.orders)&&result.orders.length===0&&!final.orderRefs.length){
     const reason=result.error||'该饰品不同时支持 BUFF 可用资金付款和卖家发起报价，已跳过';
     recordTradeModeSkip(candidate,reason,{jobId:plan.jobId,purchaseId,stage:'buy'});
     throw Object.assign(fault(reason,'UNSUPPORTED_TRADE_MODE'),{buffId:final.buffId});
    }
    // Only a proven, unpaid cancellation may be replanned. Never retry paid,
    // partial or unknown results even when a driver mistakenly labels them retryable.
    if(final.status==='cancelled'&&result.status==='cancelled'&&result.final===true&&result.retryable===true&&result.retryCode==='QUOTE_CHANGED'&&Array.isArray(result.orders)&&result.orders.length===0&&!final.orderRefs.length){
     throw Object.assign(fault(result.error||'BUFF 卖单价格已变化，正在重新核价','QUOTE_CHANGED'),{buffId:final.buffId});
    }
    saveAutomation({state:failed?'blocked':'done',lastError:final.error||result.error||null});
    if(failed)throw fault(final.error||result.error||'本轮未明确完成采购，请检查 BUFF 订单');
    if(result.receiptError){setJobAttention(plan.jobId,'付款已确认，收货步骤需要处理：'+result.receiptError);throw fault('付款已确认，收货步骤需要处理：'+result.receiptError);}
    return view();
   }catch(error){
    if(purchaseId&&!closed)store.update('purchase-error',{purchaseId,error:error.message},state=>{
     const p=state.purchases.find(p=>p.id===purchaseId);if(p?.status==='submitting'){p.status='unknown';p.error=error.message;p.updatedAt=iso();}return state;
    });
    if(error.code==='UNSUPPORTED_TRADE_MODE')saveAutomation({state:'inspecting',lastError:null});
    else if(error.code==='QUOTE_CHANGED')saveAutomation({state:'inspecting',lastError:null,lastRetry:{buffId:error.buffId,reason:error.message,at:iso()}});
    else saveAutomation({state:'blocked',lastError:error.message});throw error;
   }finally{automationPromise=null;}
  });return automationPromise;
 }
 function setJobAttention(id,reason){
  if(closed)return;
  store.update('job-needs-action',{id,reason},state=>{
   const job=state.jobs.find(item=>item.id===id);
   if(job?.status==='running'){job.status='needs_action';job.reason=reason;job.updatedAt=iso();}
   return state;
  });
 }
 function pauseJob(id,reason){
  if(closed)return;
  store.update('job-paused',{id,reason},state=>{const job=state.jobs.find(item=>item.id===id);if(job?.status==='running'){job.status='paused';job.reason=reason;job.updatedAt=iso();}return state;});
 }
 function completeJob(id,reason){store.command(randomUUID(),'job-complete',{id,reason});saveAutomation({state:'done',lastError:null});}
 function runJob({id}={}){
  if(closed)throw fault('程序正在关闭');
  if(jobRunnerPromise){if(id&&id!==runningJobId)throw fault('另一个采购任务正在运行');return jobRunnerPromise;}
  if(automationPromise||browserPromise||reconcilePromise)throw fault('BUFF 正在核验、采购或核对收货，请稍候');
  const s=store.read(),job=s.jobs.find(item=>item.id===(id||s.activeJobId));
  if(!job)throw fault('请先创建本次采购任务');
  if(!s.settings.autoBuy)return automate({jobId:job.id,buy:false});
  accountGate(s);
  store.command(randomUUID(),'job-start',{id:job.id});runningJobId=job.id;
  jobRunnerPromise=Promise.resolve().then(async()=>{
   const quoteChanges=new Map(),excludeBuffIds=new Set(),unsupportedBuffIds=new Set();
   try{
    while(!closed){
     let state=store.read(),current=state.jobs.find(item=>item.id===job.id);
     if(current?.status!=='running'||state.activeJobId!==job.id)break;
     if(state.paused||!state.settings.autoBuy){pauseJob(job.id,state.paused?'用户已暂停采购':'自动采购已关闭');break;}
     let gate=control(state);
     if(gate.gateCode==='exhausted'){completeJob(job.id,'本次采购预算已用完');break;}
     if(['stale','sync_error'].includes(gate.gateCode)){await refresh({force:true});state=store.read();current=state.jobs.find(item=>item.id===job.id);if(current?.status!=='running'||state.paused||!state.settings.autoBuy)continue;gate=control(state);}
     if(!gate.canBuy)throw fault(gate.reason,gate.gateCode?.toUpperCase());
     try{await automate({buy:true,jobId:job.id,fromRunner:true,excludeBuffIds,unsupportedBuffIds});quoteChanges.clear();}
     catch(error){
      if(error.code==='UNSUPPORTED_TRADE_MODE'){unsupportedBuffIds.add(String(error.buffId));quoteChanges.delete(String(error.buffId));continue;}
      if(error.code==='QUOTE_CHANGED'){
       const latest=store.read(),current=latest.jobs.find(item=>item.id===job.id);
       if(current?.status!=='running'||latest.activeJobId!==job.id)break;
       if(latest.paused||!latest.settings.autoBuy){pauseJob(job.id,latest.paused?'用户已暂停采购':'自动采购已关闭');break;}
       const id=String(error.buffId),count=(quoteChanges.get(id)||0)+1;quoteChanges.set(id,count);
       if(count>=3)excludeBuffIds.add(id);
       await sleep(300);continue;
      }
      if(error.code==='QUOTES_UNSTABLE'){pauseJob(job.id,error.message);saveAutomation({state:'idle',lastError:error.message});break;}
      if(error.code==='NO_ELIGIBLE'){const latest=store.read();if(latest.jobs.find(item=>item.id===job.id)?.status==='running'&&!latest.paused&&latest.settings.autoBuy)completeJob(job.id,error.message);break;}
      throw error;
     }
     await sleep(300);
    }
   }catch(error){
    if(!closed){const state=store.read(),current=state.jobs.find(item=>item.id===job.id);if(current?.status==='running'){if(state.paused||!state.settings.autoBuy)pauseJob(job.id,state.paused?'用户已暂停采购':'自动采购已关闭');else setJobAttention(job.id,error.message);}saveAutomation({state:'blocked',lastError:error.message});}
   }finally{jobRunnerPromise=null;runningJobId=null;}
   return closed?null:view();
  });return jobRunnerPromise;
 }
 async function reconcilePaidWork(){
  if(closed||automationPromise||jobRunnerPromise||browserPromise||browser.status().state!=='ready')return;
  const state=store.read();if(!state.settings.expectedSteamId||browser.status().steamId!==state.settings.expectedSteamId)return;
  for(const purchase of state.purchases.filter(p=>p.status==='paid')){
   if(closed||automationPromise||jobRunnerPromise)return;
   try{
    const result=await browser.reconcile(purchase,state.settings);if(closed)return;
    const current=store.read().purchases.find(item=>item.id===purchase.id);
    if(!current||current.status!=='paid'||current.updatedAt!==purchase.updatedAt||current.quantity!==purchase.quantity||current.totalCost!==purchase.totalCost||JSON.stringify(current.orderRefs)!==JSON.stringify(purchase.orderRefs))continue;
    // An unclear receipt query must not erase an already proven payment.
    if(result.status==='received'&&result.final===true)store.update('purchase-receipt',{purchaseId:purchase.id,result},s=>{
     const original=structuredClone(s.purchases.find(p=>p.id===purchase.id)),updated=applyBrowserResult(s,purchase.id,result);
     if(updated.status==='unknown'&&updated.totalCost===original.totalCost)s.purchases[s.purchases.findIndex(p=>p.id===purchase.id)]={...original,receiptError:updated.error};
     if(updated.status==='received')delete updated.receiptError;return s;
    });
    else if(result.error){const latest=store.read(),p=latest.purchases.find(item=>item.id===purchase.id);p.receiptError=result.error;store.save(latest);}
   }catch(error){if(!closed){const latest=store.read(),p=latest.purchases.find(item=>item.id===purchase.id);p.receiptError=error.message;store.save(latest);}}
  }
 }
 function reconcilePaid(){
  if(reconcilePromise)return reconcilePromise;
  reconcilePromise=Promise.resolve().then(reconcilePaidWork).finally(()=>{reconcilePromise=null;});return reconcilePromise;
 }
 async function body(req){let chunks=[],length=0;for await(const chunk of req){length+=chunk.length;if(length>100000)throw Error('请求过大');chunks.push(chunk);}const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error('请求参数必须为对象');return value;}
 const server=http.createServer(async(req,res)=>{
  const send=(code,value,type='application/json')=>{if(res.writableEnded)return;res.writeHead(code,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"});res.end(type==='application/json'?JSON.stringify(value):value);};
  try{
   const host=req.headers.host;
   if(!/^127\.0\.0\.1:\d+$/.test(host||''))return send(403,{error:'仅支持本机127.0.0.1访问'});
   if(req.headers.origin&&req.headers.origin!==`http://${host}`)return send(403,{error:'来源不匹配'});
   if(req.method==='POST'&&!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'需要JSON请求'});
   const url=new URL(req.url,`http://${host}`),files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
   if(req.method==='GET'&&files[url.pathname]){const [file,type]=files[url.pathname];return send(200,await readFile(path.join(root,'public',file),'utf8'),type);}
   if(req.method==='GET'&&url.pathname==='/api/state')return send(200,view());
   if(req.method==='GET'&&['/api/export','/api/sales/export'].includes(url.pathname)){
    if(url.searchParams.get('format')==='json'){res.setHeader('Content-Disposition','attachment; filename="funding-backup.json"');return send(200,{...store.read(),events:store.events()});}
    res.setHeader('Content-Disposition','attachment; filename="funding-ledger.csv"');return send(200,exportsFor(store.read(),{salesOnly:url.pathname==='/api/sales/export'}),'text/csv');
   }
   if(req.method==='POST'&&url.pathname==='/api/refresh'){const options=await body(req),task=refresh({force:options.force===true});if(options.wait){await task;return send(200,view());}task.catch(()=>{});return send(refreshing?202:200,view());}
   if(req.method==='POST'&&url.pathname==='/api/command'){const b=await body(req),result=store.command(b.key,b.type,b.payload);return send(200,{...result,state:view()});}
   if(req.method==='POST'&&['/api/browser/open','/api/browser/check'].includes(url.pathname)){
    await body(req);if(automationPromise||jobRunnerPromise||reconcilePromise)throw fault('正在核验、购买或核对收货，请稍候');if(browserPromise)throw fault('浏览器正在启动或核验');
    browserPromise=Promise.resolve().then(async()=>{if(url.pathname==='/api/browser/open')await browser.open();else if(browser.check)await browser.check(store.read().settings);else await browser.open();});
    try{await browserPromise;}finally{browserPromise=null;}return send(200,view());
   }
   if(req.method==='POST'&&url.pathname==='/api/jobs/run'){
    const b=await body(req),task=runJob({id:b.id});if(b.wait){await task;return send(200,view());}task.catch(()=>{});return send(202,view());
   }
   if(req.method==='POST'&&['/api/automation/preview','/api/automation/run'].includes(url.pathname)){
    const b=await body(req),task=automate({buy:url.pathname.endsWith('/run'),buffId:b.buffId,jobId:b.id||b.jobId});if(b.wait){await task;return send(200,view());}task.catch(()=>{});return send(202,view());
   }
   send(404,{error:'路径不存在'});
  }catch(error){send(400,{error:error.message});}
 });
 async function tick(){
  if(closed)return;
  const state=store.read(),now=Date.now();
  if(!automationPromise&&!browserPromise&&!reconcilePromise&&!jobRunnerPromise&&!refreshing&&state.settings.autoRefresh&&now-lastCycle>=state.settings.refreshMinutes*60000){lastCycle=now;try{await refresh();}catch{}}
  if(now-lastReconcile>=30000){lastReconcile=now;await reconcilePaid();}
 }
 const timer=setInterval(()=>{tick().catch(()=>{});},10000);timer.unref();
 server.on('close',()=>{closed=true;clearInterval(timer);void Promise.resolve(browser.close()).catch(()=>{});store.close();});
 return {server,store,refresh,view,automate,runJob,reconcilePaid,browser};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const demo=process.env.FUNDING_DEMO==='1',port=Number(process.env.PORT||(demo?8770:8769));
 const app=await createApp({dir:process.env.DATA_DIR||path.join(root,demo?'data-demo':'data'),demo});
 app.server.on('error',error=>{console.error('启动失败：'+error.message);process.exitCode=1;});
 app.server.listen(port,'127.0.0.1',()=>{const address=`http://127.0.0.1:${port}`;console.log(`SMIS → BUFF 任务采购与账本${demo?'【演示模式】':''} ${address}`);if(process.env.OPEN_DASHBOARD==='1'&&process.platform==='win32')execFile('cmd.exe',['/d','/c','start','',address],{windowsHide:true},()=>{});});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.server.close());
}
