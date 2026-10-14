import {randomUUID} from 'node:crypto';

export const defaults = Object.freeze({ratio:0.7,minVolume:30,minUnitPrice:0,maxAgeMinutes:30,maxUnits:10,maxBatchSpend:2000,refreshMinutes:5,autoRefresh:true,autoBuy:false,expectedSteamId:''});
export const states = Object.freeze({reserved:'已预留',submitting:'提交中',unknown:'结果未知／预算冻结',paid:'已付款待收货',received:'已收货待手动出售',closed:'历史已售出，待补录',cancelled:'已确认未付款取消',refunded:'已确认退款'});
const reservedStatuses=new Set(['reserved','submitting','unknown']);
const paidStatuses=new Set(['paid','received','closed','refunded']);
const terminalJobs=new Set(['completed','cancelled']);
const jobStatuses=new Set(['draft','running','paused','completed','needs_action','cancelled']);
export const initial=()=>({schemaVersion:4,settings:{...defaults},paused:false,purchases:[],jobs:[],activeJobId:null,sales:[],legacyItems:[],legacyWalletHistory:[],snapshot:{rows:[],fetchedAt:null,scope:'尚未抓取'},sync:{error:null,lastAttempt:null,lastSuccess:null,progress:null,cooldownUntil:null},automation:{state:'idle',lastRun:null,lastError:null,lastPreview:null,plan:null}});
function check(ok,message){if(!ok)throw Error(message);}
export function money(n,label='金额',min=0,max=100000000){check(Number.isSafeInteger(n)&&n>=min&&n<=max,`${label}必须为 ${min}–${max} 范围内的整数（金额单位：分）`);return n;}
function text(v,label,min=1,max=500){check(typeof v==='string'&&v.trim().length>=min&&v.length<=max,`${label}不能为空且不得超过${max}字`);return v.trim();}
function optionalText(v,label,max=500){return v===undefined||v===null||v===''?'':text(v,label,1,max);}
function date(value,label,now){const at=Date.parse(value);check(typeof value==='string'&&Number.isFinite(at)&&at<=now+300000,`${label}无效或超过当前时间`);return new Date(at).toISOString();}
export function validateSettings(input={}){
 const s={...defaults,...input};
 check(Number.isFinite(s.ratio)&&s.ratio>0&&s.ratio<=0.7,'采购比例必须大于0且不超过0.70');
 money(s.minVolume,'最低日成交量',30,10000000);money(s.maxAgeMinutes,'行情有效期',1,120);
 money(s.minUnitPrice,'单件最低采购金额',0);
 money(s.maxUnits,'单商品在途件数上限',1,100);money(s.maxBatchSpend,'单批现金上限',1,100000000);money(s.refreshMinutes,'刷新间隔',1,60);
 check(typeof s.autoRefresh==='boolean'&&typeof s.autoBuy==='boolean','自动运行参数无效');
 check(typeof s.expectedSteamId==='string'&&(s.expectedSteamId===''||/^7656119\d{10}$/.test(s.expectedSteamId)),'目标 Steam ID 应为17位数字');
 check(!s.autoBuy||s.expectedSteamId!=='','启用自动采购前请填写目标 Steam ID');
 return Object.fromEntries(Object.keys(defaults).map(k=>[k,s[k]]));
}
export function migrate(source={}){
 const state={...initial(),...source};
 state.settings=validateSettings(source.settings||{});state.sync={...initial().sync,...source.sync};state.automation={...initial().automation,...source.automation};
 state.legacyItems=source.legacyItems||source.items||[];state.purchases=structuredClone(source.purchases||[]);state.jobs=structuredClone(source.jobs||[]);state.sales=structuredClone(source.sales||[]);
 state.activeJobId=source.activeJobId||null;state.legacyWalletHistory=structuredClone(source.legacyWalletHistory||source.walletHistory||[]);
 if(source.wallet&&!state.legacyWalletHistory.some(w=>w.at===source.wallet.at&&w.balance===source.wallet.balance))state.legacyWalletHistory.push({...source.wallet,legacy:true});
 if((source.schemaVersion||0)<3){
  const mapping={reserved:'unknown',purchased:'paid',locked:'received',ready:'received',listed:'received',pending:'received',settled:'closed',cancelled:'cancelled',refunded:'refunded'};
  const existing=new Set(state.purchases.map(p=>p.legacyItemId));
  for(const item of state.legacyItems){
   if(existing.has(item.id))continue;
   const cost=money(item.cost,'历史采购成本'),bidNet=Math.max(0,Number(item.expectedNet)||0),appMatch=/^https:\/\/steamcommunity\.com\/market\/listings\/(570|730)\//.exec(item.steamUrl||'');
   state.purchases.push({id:`legacy-${item.id||randomUUID()}`,legacyItemId:item.id,source:'legacy',jobId:null,buffId:String(item.buffId||''),appid:item.appid||(appMatch?Number(appMatch[1]):null),name:item.name||'历史采购',quantity:1,unitCost:cost,totalCost:cost,bidNet,expectedNet:bidNet,status:mapping[item.status]||'unknown',orderRefs:item.orderRef?[String(item.orderRef)]:[],createdAt:item.createdAt||new Date().toISOString(),updatedAt:item.updatedAt||item.createdAt||new Date().toISOString(),refund:item.status==='refunded'?Math.min(cost,Math.max(0,Number(item.refund)||0)):0,error:item.status==='reserved'?'历史采购预留未核对，需手动确认实际结果':undefined});
  }
 }
 for(const p of state.purchases){p.jobId??=null;p.orderRefs??=[];if(p.status==='closed'&&!state.sales.some(s=>s.purchaseId===p.id))p.legacySaleUnrecorded=true;}
 for(const job of state.jobs){check(jobStatuses.has(job.status),'历史任务状态无效');money(job.budget,'历史任务采购金额',1);}
 if(state.activeJobId&&!state.jobs.some(j=>j.id===state.activeJobId))state.activeJobId=null;
 delete state.items;delete state.wallet;delete state.walletHistory;delete state.replenishing;state.schemaVersion=4;allocateSales(state);
 return state;
}
function saleQuantity(state,id,excludeId){return state.sales.filter(s=>s.purchaseId===id&&s.id!==excludeId).reduce((sum,s)=>sum+s.quantity,0);}
function paidAmount(p){return paidStatuses.has(p.status)?Math.max(0,p.totalCost-(p.status==='refunded'?(p.refund||0):0)):0;}
function reservedAmount(p){return reservedStatuses.has(p.status)?p.totalCost:0;}
function cumulativeCost(p,quantity){
 const details=p.orderDetails;
 if(Array.isArray(details)&&details.length===p.quantity&&details.every(o=>Number.isSafeInteger(o.cost)&&o.cost>=0)&&details.reduce((sum,o)=>sum+o.cost,0)===p.totalCost)return details.slice(0,quantity).reduce((sum,o)=>sum+o.cost,0);
 return Math.floor(p.totalCost*quantity/p.quantity);
}
function allocatedSales(state){
 const map=new Map();
 for(const p of state.purchases){
  let quantity=0;
  for(const sale of state.sales.filter(s=>s.purchaseId===p.id).sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''))){
   const next=quantity+sale.quantity;check(next<=p.quantity,'售出数量超过采购件数');map.set(sale.id,cumulativeCost(p,next)-cumulativeCost(p,quantity));quantity=next;
  }
 }
 return map;
}
function allocateSales(state){const costs=allocatedSales(state);for(const s of state.sales)s.cost=costs.get(s.id)||0;}
export function jobStats(state,id=state.activeJobId){
 const job=state.jobs.find(j=>j.id===id),purchases=state.purchases.filter(p=>p.jobId===id&&id);let spent=0,reservation=0,purchaseQuantity=0,receivedQuantity=0,soldQuantity=0;
 for(const p of purchases){spent+=paidAmount(p);reservation+=reservedAmount(p);if(paidStatuses.has(p.status))purchaseQuantity+=p.quantity;if(['received','closed'].includes(p.status))receivedQuantity+=p.quantity;soldQuantity+=saleQuantity(state,p.id);}
 const budget=job?.budget||0,remaining=Math.max(0,budget-spent-reservation);
 return {budget,spent,reserved:reservation,remaining,jobBudget:budget,jobSpent:spent,jobReserved:reservation,jobRemaining:remaining,purchaseQuantity,receivedQuantity,soldQuantity};
}
export function getJobs(state){return state.jobs.map(job=>({...job,...jobStats(state,job.id)}));}
export function totals(state){
 let spent=0,reservation=0,inFlight=0,refunds=0,purchaseQuantity=0,receivedQuantity=0,inventoryCost=0,unsoldQuantity=0,legacySaleUnrecordedQuantity=0,legacySaleUnrecordedCost=0;
 const costs=allocatedSales(state);let salesGross=0,salesFees=0,salesNet=0,soldCost=0,soldQuantity=0;
 for(const sale of state.sales){salesGross+=sale.gross;salesFees+=sale.fee;salesNet+=sale.net;soldQuantity+=sale.quantity;soldCost+=costs.get(sale.id)||0;}
 for(const p of state.purchases){
  spent+=paidAmount(p);reservation+=reservedAmount(p);if(p.status==='refunded')refunds+=p.refund||0;
  if(paidStatuses.has(p.status))purchaseQuantity+=p.quantity;
  if(['received','closed'].includes(p.status))receivedQuantity+=p.quantity;
  const qty=saleQuantity(state,p.id),remainingQuantity=Math.max(0,p.quantity-qty),remainingCost=p.totalCost-cumulativeCost(p,qty);
  if(p.status==='closed'&&p.legacySaleUnrecorded){legacySaleUnrecordedQuantity+=remainingQuantity;legacySaleUnrecordedCost+=remainingCost;}
  if(p.status==='received')unsoldQuantity+=remainingQuantity;
  if(['paid','received'].includes(p.status)){inventoryCost+=remainingCost;inFlight+=(p.bidNet||0)*remainingQuantity;}
 }
 return {spent,reserved:reservation,inFlight,refunds,used:spent+reservation,remaining:jobStats(state).remaining,purchaseQuantity,receivedQuantity,soldQuantity,unsoldQuantity,salesGross,salesFees,salesNet,soldCost,inventoryCost,realizedRatio:salesNet>0?soldCost/salesNet:null,legacySaleUnrecordedQuantity,legacySaleUnrecordedCost};
}
export function control(state,now=Date.now()){
 const t=totals(state),s=state.settings,activeJob=state.jobs.find(j=>j.id===state.activeJobId)||null,stats=jobStats(state);let reason='可采购',gateCode='ready';
 const block=(code,message)=>{gateCode=code;reason=message;};
 if(state.paused)block('paused','已手动暂停新增采购');
 else if(state.purchases.some(p=>p.status==='unknown'||p.status==='submitting'))block('pending','有结果未知或提交中的采购，先核对订单');
 else if(!activeJob)block('no_job','请创建并启动采购任务');
 else if(activeJob.status!=='running')block('job_not_running',({draft:'采购任务待开始',paused:'采购任务已暂停',completed:'本次采购已完成，可创建新任务',needs_action:'采购任务需要人工处理',cancelled:'采购任务已结束，可创建新任务'})[activeJob.status]||'采购任务尚未运行');
 else if(!stats.remaining)block('exhausted','本次采购任务预算已用完');
 else if(state.sync.error)block('sync_error','行情刷新失败，请重试后采购');
 else if((state.snapshot.filters?.minUnitPrice??0)>s.minUnitPrice)block('stale','最低采购金额已降低，请重新刷新行情');
 else if(!state.snapshot.fetchedAt||!Number.isFinite(Date.parse(state.snapshot.fetchedAt))||now-Date.parse(state.snapshot.fetchedAt)>s.maxAgeMinutes*60000||Date.parse(state.snapshot.fetchedAt)>now+300000)block('stale','行情快照已过期，请刷新');
 return {...t,...stats,remaining:stats.remaining,activeJob,jobId:activeJob?.id||null,canBuy:gateCode==='ready',reason,gateCode};
}
export function quoteTime(value){if(typeof value!=='string')return NaN;return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value)?value:value.replace(' ','T')+'+08:00');}
// Conservative estimate of proceeds when selling into the current Steam buy order.
export function estimatedNet(gross){return Math.max(0,Math.min(Math.floor(gross/1.15+1e-8),gross-14));}
function heldQuantity(state,id){return state.purchases.filter(p=>String(p.buffId)===String(id)&&['reserved','submitting','unknown','paid','received'].includes(p.status)).reduce((sum,p)=>sum+Math.max(0,p.quantity-saleQuantity(state,p.id)),0);}
export function opportunities(state,now=Date.now()){
 const s=state.settings,c=control(state,now),seen=new Set(),rows=[];
 for(const r of state.snapshot.rows||[]){
  const timestamp=quoteTime(r.updateTime),cost=Math.round(Number(r.buffSellPrice)*100),gross=Math.round(Number(r.steamBuyPrice)*100),net=estimatedNet(gross),volume=Number(r.steamTransactionQuantity),id=String(r.buffId);
  if(!/^\d+$/.test(id)||!['730','570'].includes(String(r.appid))||seen.has(id))continue;
  if(!Number.isFinite(timestamp)||timestamp>now+300000||now-timestamp>s.maxAgeMinutes*60000||!Number.isFinite(volume)||volume<s.minVolume)continue;
  if(!Number.isSafeInteger(cost)||cost<1||cost<s.minUnitPrice||!Number.isSafeInteger(net)||net<1||cost/net>=s.ratio)continue;
  seen.add(id);const held=heldQuantity(state,id);
  rows.push({buffId:id,name:String(r.cnName||r.hashName||id),appid:Number(r.appid),hashName:String(r.hashName||''),cost,bidGross:gross,bidNet:net,ratio:cost/net,volume,time:r.updateTime,held,quantity:c.canBuy?Math.max(0,Math.min(s.maxUnits-held,Math.floor(c.remaining/cost),Math.floor(s.maxBatchSpend/cost))):0,buffUrl:`https://buff.163.com/goods/${id}`,steamUrl:`https://steamcommunity.com/market/listings/${r.appid}/${encodeURIComponent(r.hashName||'')}`});
 }
 return rows.sort((a,b)=>a.ratio-b.ratio||a.cost-b.cost||a.buffId.localeCompare(b.buffId));
}
export function planPurchase(state,candidate,inspection,now=Date.now()){
 const c=control(state,now),s=state.settings;check(c.canBuy,c.reason);
 const quote=opportunities(state,now).find(q=>q.buffId===String(candidate.buffId));check(quote,'SMIS 候选已失效，请重新刷新');
 check(!inspection.requiresAction,'BUFF 报价需要人工处理，未执行采购');check(String(inspection.buffId)===quote.buffId,'BUFF 商品与候选不一致');
 check(s.expectedSteamId&&String(inspection.steamId)===s.expectedSteamId,'BUFF 绑定 Steam 账号与目标不一致或尚未设置');
 const checked=Date.parse(inspection.checkedAt);check(Number.isFinite(checked)&&now-checked<=60000&&checked<=now+5000,'BUFF 实时报价已过期，请重新核价');check(Array.isArray(inspection.depth)&&inspection.depth.length>0,'BUFF 未提供可核对的实时价格档位');
 let quantity=0,totalCost=0,units=s.maxUnits-quote.held,cash=Math.min(c.remaining,s.maxBatchSpend);const selected=[];
 for(const depth of [...inspection.depth].sort((a,b)=>a.unitCost-b.unitCost)){
  const cost=money(depth.unitCost,'BUFF 每件实时报价',1),available=money(depth.quantity,'BUFF 可购买数量',1,100000);if(cost<s.minUnitPrice||cost/quote.bidNet>=s.ratio)continue;
  const take=Math.min(units,available,Math.floor(cash/cost));if(!take)continue;selected.push({unitCost:cost,quantity:take});quantity+=take;totalCost+=take*cost;units-=take;cash-=take*cost;if(!units||!cash)break;
 }
 if(!quantity){const error=Error('实时单件最低金额、比例、深度或任务预算不允许采购');error.code='NO_ELIGIBLE';throw error;}
 return {jobId:c.jobId,buffId:quote.buffId,appid:quote.appid,name:quote.name,quantity,unitCost:Math.max(...selected.map(d=>d.unitCost)),maxPrice:Math.max(...selected.map(d=>d.unitCost)),minUnitPrice:s.minUnitPrice,ratioLimit:s.ratio,totalCost,expectedNet:quantity*quote.bidNet,bidNet:quote.bidNet,depth:selected,checkedAt:inspection.checkedAt,steamId:String(inspection.steamId),buffUrl:quote.buffUrl};
}
export function reservePurchase(state,plan,now=Date.now()){
 const gate=control(state,now);check(gate.canBuy,gate.reason);check(plan.jobId===gate.jobId,'采购方案不属于当前运行任务');
 check(String(plan.steamId)===state.settings.expectedSteamId,'采购方案的 Steam 账号与目标不一致');
 money(plan.quantity,'采购数量',1,state.settings.maxUnits);money(plan.totalCost,'采购预留金额',1);money(plan.bidNet,'每件求购估算净额',1);
 check(heldQuantity(state,plan.buffId)+plan.quantity<=state.settings.maxUnits,'超过单商品在途件数上限');check(plan.totalCost<=gate.remaining,'超过本次采购任务剩余预算');check(plan.totalCost<=state.settings.maxBatchSpend,'超过单批现金上限');check(plan.expectedNet===plan.quantity*plan.bidNet,'预计净额与采购件数不一致');
 check(Array.isArray(plan.depth)&&plan.depth.reduce((sum,d)=>sum+d.quantity,0)===plan.quantity&&plan.depth.reduce((sum,d)=>sum+d.quantity*d.unitCost,0)===plan.totalCost,'预留数量与实时档位金额不一致');
 check(plan.maxPrice===Math.max(...plan.depth.map(d=>d.unitCost))&&plan.ratioLimit===state.settings.ratio,'采购最高价或比例参数与核价结果不一致');
 check(plan.minUnitPrice===state.settings.minUnitPrice,'单件最低采购金额已变化，请重新核价');
 for(const d of plan.depth){money(d.unitCost,'逐件采购成本',1);money(d.quantity,'档位数量',1,plan.quantity);check(d.unitCost>=state.settings.minUnitPrice,'逐件采购成本低于单件最低金额');check(d.unitCost/plan.bidNet<state.settings.ratio,'逐件成本比例必须严格低于采购阈值');}
 const at=new Date(now).toISOString(),purchase={...plan,id:randomUUID(),status:'reserved',orderRefs:[],createdAt:at,updatedAt:at};state.purchases.push(purchase);return purchase;
}
function refs(values){check(Array.isArray(values)&&values.length<=200,'订单号列表无效');return [...new Set(values.map(v=>text(String(v),'平台订单号',1,200)))];}
function ensureUniqueOrders(state,purchase,orders){for(const id of orders)check(!state.purchases.some(p=>p.id!==purchase.id&&p.orderRefs?.includes(id)),`平台订单号 ${id} 已属于其他采购批次`);}
function blockJob(state,p,error,at){const job=state.jobs.find(j=>j.id===p.jobId);if(job&&!terminalJobs.has(job.status)){job.status='needs_action';job.reason=error;job.updatedAt=at;}}
export function applyBrowserResult(state,id,result,now=Date.now()){
 const p=state.purchases.find(x=>x.id===id);check(p,'采购批次不存在');check(['reserved','submitting','unknown','paid','received'].includes(p.status),'当前批次不能应用采购结果');const at=new Date(now).toISOString();p.updatedAt=at;
 try{
  check(result&&typeof result==='object','平台结果无效');const incoming=refs((result.orders||[]).map(o=>o.id));ensureUniqueOrders(state,p,incoming);p.orderRefs=[...new Set([...p.orderRefs,...incoming])];
  if(result.steamId&&String(result.steamId)!==state.settings.expectedSteamId)throw Error('付款结果的 Steam 账号与目标不一致');
  if(result.status==='unknown'||result.final!==true){p.status='unknown';p.error=result.error||'平台未确认完整结果，预算保持冻结';blockJob(state,p,p.error,at);return p;}
  if(result.status==='cancelled'){check(!incoming.length&&!p.orderRefs.length,'存在订单号，不能按未付款取消自动释放预算');check(!paidStatuses.has(p.status),'已付款批次不能按未付款取消释放');p.status='cancelled';p.error=null;return p;}
  check(['paid','received'].includes(result.status),'平台返回未知采购状态');money(result.quantity,'平台确认成交数量',1,p.quantity);money(result.totalCost,'平台确认实付金额',1);
  check(String(result.steamId||'')===state.settings.expectedSteamId,'付款结果缺少目标 Steam 账号核对');check(incoming.length>0,'平台结果没有明确订单号');check(result.orders.every(o=>['paid','received'].includes(o.status)),'存在未确认完成的订单');
  check(incoming.length===result.quantity&&result.orders.length===incoming.length,'成交件数与独立平台订单号不一致');check(result.orders.reduce((sum,o)=>sum+money(o.cost,'订单实付金额',1),0)===result.totalCost,'订单金额与采购实付合计不一致');
  if(result.totalCost>p.totalCost){p.totalCost=result.totalCost;state.paused=true;throw Error('平台实付超过预留，已暂停采购并冻结实际金额');}
  if(result.status==='received')check(result.orders.every(o=>o.status==='received'),'部分订单尚未明确收货');
  if(p.source!=='legacy')check(result.orders.every(o=>o.cost>=(p.minUnitPrice??0)&&o.cost<=(p.maxPrice??p.unitCost)&&o.cost/p.bidNet<(p.ratioLimit??state.settings.ratio)),'实际逐件成本不符合本批最低价、最高价或采购比例，保持预算冻结');
  check(saleQuantity(state,p.id)===0||result.quantity===p.quantity&&result.totalCost===p.totalCost,'已记出售的批次不能修改采购数量和金额');
  p.orderDetails=result.orders.map(order=>({id:String(order.id),cost:order.cost,status:order.status}));p.quantity=result.quantity;p.totalCost=result.totalCost;p.unitCost=Math.ceil(result.totalCost/result.quantity);p.expectedNet=p.quantity*p.bidNet;p.status=result.status;p.error=null;p.paidAt=p.paidAt||at;if(result.status==='received')p.receivedAt=at;
 }catch(error){p.status='unknown';p.error=error.message;blockJob(state,p,p.error,at);}
 return p;
}
function validateSale(state,input,previous,now){
 const purchaseId=text(input.purchaseId??previous?.purchaseId,'采购批次编号',1,200),purchase=state.purchases.find(p=>p.id===purchaseId);check(purchase,'采购批次不存在');check(purchase.status==='received'||purchase.status==='closed'&&purchase.legacySaleUnrecorded===true,'只能记录已明确收货的饰品出售');
 const quantity=money(input.quantity??previous?.quantity,'本次出售件数',1,purchase.quantity);check(quantity+saleQuantity(state,purchase.id,previous?.id)<=purchase.quantity,'本次出售件数超过该批未售数量');
 const gross=money(input.gross??previous?.gross,'本次出售总额'),fee=money(input.fee??previous?.fee,'本次手续费'),net=money(input.net??previous?.net,'本次净收入');check(gross-fee===net,'出售总额减手续费必须等于净收入');
 const occurredAt=date(input.occurredAt??previous?.occurredAt??new Date(now).toISOString(),'出售时间',now),reference=optionalText(input.reference??previous?.reference,'Steam成交编号',200),note=optionalText(input.note??previous?.note,'出售说明',1000);
 if(reference)check(!state.sales.some(s=>s.id!==previous?.id&&s.reference===reference),'该 Steam 成交编号已记录，不能重复添加');
 return {purchaseId,quantity,gross,fee,net,occurredAt,reference,note};
}
export function mutate(state,type,p={},now=Date.now()){
 const at=new Date(now).toISOString();check(p&&typeof p==='object'&&!Array.isArray(p),'操作参数无效');
 if(type==='settings')state.settings=validateSettings({...state.settings,...p});
 else if(type==='pause'){check(typeof p.paused==='boolean','暂停状态无效');state.paused=p.paused;}
 else if(type==='job-create'){
  const budget=money(p.budget,'本次采购金额',1),name=optionalText(p.name,'任务名称',100)||`采购任务 ${state.jobs.length+1}`;
  const job={id:randomUUID(),name,budget,status:'draft',createdAt:at,updatedAt:at};state.jobs.push(job);const active=state.jobs.find(j=>j.id===state.activeJobId);if(!active||terminalJobs.has(active.status))state.activeJobId=job.id;
 }else if(['job-start','job-pause','job-complete','job-cancel'].includes(type)){
  const job=state.jobs.find(j=>j.id===p.id);check(job,'采购任务不存在');check(!terminalJobs.has(job.status),'已结束任务不能重新操作');
  if(type==='job-start'){
   check(!state.purchases.some(x=>x.status==='unknown'||x.status==='submitting'),'有结果未知或提交中的采购，先核对订单');
   const other=state.jobs.find(j=>j.id===state.activeJobId&&j.id!==job.id&&!terminalJobs.has(j.status));check(!other,'请先结束当前采购任务，再启动其他任务');
   check(jobStats(state,job.id).remaining>0,'本次采购任务预算已用完');state.activeJobId=job.id;job.status='running';job.startedAt??=at;job.reason=null;
  }else if(type==='job-pause'){job.status='paused';job.reason=optionalText(p.reason,'暂停说明',1000)||'用户暂停';}
  else{
   check(!state.purchases.some(x=>x.jobId===job.id&&reservedStatuses.has(x.status)),'任务存在未决预留，请核对订单后结束');job.status=type==='job-complete'?'completed':'cancelled';job.reason=optionalText(p.reason,'结束说明',1000)||(type==='job-complete'?'用户结束采购':'用户取消任务');job.endedAt=at;
  }
  job.updatedAt=at;
 }else if(type==='sale-add'){
  const sale={...validateSale(state,p,null,now),id:randomUUID(),createdAt:at,updatedAt:at};state.sales.push(sale);allocateSales(state);
 }else if(type==='sale-update'){
  const sale=state.sales.find(s=>s.id===p.id);check(sale,'出售记录不存在');Object.assign(sale,validateSale(state,p,sale,now),{updatedAt:at});allocateSales(state);
 }else if(type==='sale-delete'){
  const index=state.sales.findIndex(s=>s.id===p.id);check(index>=0,'出售记录不存在');optionalText(p.note,'删除说明',1000);state.sales.splice(index,1);allocateSales(state);
 }else if(type==='purchase-reconcile'){
  const purchase=state.purchases.find(x=>x.id===p.id);check(purchase,'采购批次不存在');check(p.confirmed===true,'请先核对平台订单、实际付款和收货结果');check(['reserved','unknown','paid','received'].includes(purchase.status),'当前批次不能重新核对');check(['paid','received','cancelled','refunded'].includes(p.status),'核对状态无效');
  check(saleQuantity(state,purchase.id)===0||p.status==='received','已有出售记录的批次必须保持已收货状态');
  const note=text(p.note||'','核对说明');
  if(p.status==='cancelled'){
   check(['reserved','unknown'].includes(purchase.status),'已确认付款的批次必须按退款处理');if(purchase.orderRefs.length)check(p.confirmedUnpaid===true,'存在订单号，必须明确确认这些订单未付款且已取消');purchase.status='cancelled';
  }else if(p.status==='refunded'){
   check(saleQuantity(state,purchase.id)===0,'已有出售记录的批次不能登记全部退款');const actualCost=money(p.totalCost??purchase.totalCost,'退款批次实际实付金额',1,purchase.totalCost);money(p.refund,'实际到账退款金额',1,actualCost);check(purchase.status!=='reserved','尚未付款的预留请按未付款取消处理');const orderRefs=refs(p.orderRefs||purchase.orderRefs);check(orderRefs.length>0,'退款必须保留平台订单号');ensureUniqueOrders(state,purchase,orderRefs);purchase.totalCost=actualCost;purchase.orderRefs=orderRefs;purchase.refund=p.refund;purchase.status='refunded';purchase.refundedAt=at;
  }else{
   const quantity=money(p.quantity??purchase.quantity,'实际成交数量',1,purchase.quantity),cost=money(p.totalCost??purchase.totalCost,'实际实付金额',1,purchase.totalCost),orderRefs=refs(p.orderRefs||purchase.orderRefs);check(orderRefs.length>0,'必须填写平台订单号');ensureUniqueOrders(state,purchase,orderRefs);check(!saleQuantity(state,purchase.id)||quantity===purchase.quantity&&cost===purchase.totalCost,'已有出售记录的批次不能修改采购数量和金额');
   const netPerUnit=purchase.bidNet||Math.floor(purchase.expectedNet/purchase.quantity);purchase.quantity=quantity;purchase.totalCost=cost;purchase.unitCost=Math.ceil(cost/quantity);purchase.expectedNet=quantity*netPerUnit;purchase.orderRefs=orderRefs;purchase.status=p.status;purchase.paidAt=purchase.paidAt||at;if(p.status==='received')purchase.receivedAt=at;
   if(purchase.orderDetails&&(purchase.orderDetails.length!==quantity||purchase.orderDetails.reduce((sum,o)=>sum+o.cost,0)!==cost))delete purchase.orderDetails;
  }
  purchase.note=note;purchase.error=null;purchase.updatedAt=at;allocateSales(state);
 }else throw Error('未知指令；本版本管理按金额采购任务与手动出售账本');
 return state;
}
