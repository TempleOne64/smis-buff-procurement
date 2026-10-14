import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initial,migrate,mutate,control,opportunities,totals,jobStats,getJobs,planPurchase,reservePurchase,applyBrowserResult,validateSettings} from './core.mjs';
import {Store} from './store.mjs';

const steamId='76561198000000000',now=Date.now();
function fixture(time=now,budget=100000){
 const s=initial();s.settings.autoRefresh=false;s.settings.expectedSteamId=steamId;
 mutate(s,'job-create',{budget},time);mutate(s,'job-start',{id:s.activeJobId},time);
 s.snapshot={fetchedAt:new Date(time).toISOString(),scope:'测试数据',rows:[{buffId:1,appid:730,cnName:'测试饰品',hashName:'Test',buffSellPrice:2,steamBuyPrice:4,steamTransactionQuantity:30,updateTime:new Date(time).toISOString()}]};return s;
}
function inspect(depth=[{unitCost:200,quantity:10}],time=now){return {buffId:'1',steamId,depth,checkedAt:new Date(time).toISOString()};}
function plan(state=fixture(),depth){return planPurchase(state,{buffId:'1'},inspect(depth),now);}
function result(p,status='paid',overrides={}){return {status,final:true,steamId,quantity:p.quantity,totalCost:p.totalCost,orders:p.depth.flatMap(d=>Array.from({length:d.quantity},()=>({id:randomUUID(),cost:d.unitCost,status}))),...overrides};}
function received(state,depth=[{unitCost:200,quantity:3}]){const p=reservePurchase(state,plan(state,depth),now);applyBrowserResult(state,p.id,result(p,'received'),now);assert.equal(p.status,'received');return p;}
function sale(state,p,quantity,gross=1000,fee=100,time=now){mutate(state,'sale-add',{purchaseId:p.id,quantity,gross,fee,net:gross-fee,occurredAt:new Date(time).toISOString()},time);return state.sales.at(-1);}
function fakeBrowser(overrides={}){return {status:()=>({state:'ready',steamId,error:null}),open:async()=>{},close:async()=>{},inspect:async()=>inspect(undefined,Date.now()),buy:async p=>result(p),reconcile:async p=>({status:'received',final:true,steamId,quantity:p.quantity,totalCost:p.totalCost,orders:p.orderDetails?.map(o=>({...o,status:'received'}))||p.orderRefs.map(id=>({id,cost:200,status:'received'}))}),...overrides};}
async function temporaryApp(options={}){const {createApp}=await import('./server.mjs');const dir=await mkdtemp(path.join(os.tmpdir(),'funding-v4-'));const app=await createApp({dir,browser:fakeBrowser(),...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return {...app,dir,base:'http://127.0.0.1:'+app.server.address().port,dispose:async()=>{await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});}};}
const post=(app,url,data={})=>fetch(app.base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});

test('采购任务预算不依赖Steam钱包，不设累计1000元上限',()=>{
 const s=fixture(now,150000);assert.equal(control(s,now).canBuy,true);assert.equal(control(s,now).jobBudget,150000);assert.equal(control(s,now).remaining,150000);
 for(const key of ['lower','target','upper','walletAgeMinutes','budget','trialBudget'])assert.equal(key in s.settings,false);
 assert.equal('wallet' in s,false);assert.equal('replenishing' in s,false);
 assert.throws(()=>mutate(s,'wallet',{balance:1},now),/未知指令/);assert.throws(()=>validateSettings({...s.settings,autoBuy:true,expectedSteamId:''}),/目标 Steam/);
 assert.throws(()=>mutate(s,'job-create',{budget:0},now),/采购金额/);assert.throws(()=>mutate(s,'job-create',{budget:0.5},now),/整数/);
});
test('只有一个活动任务；暂停后不采购，结束后新任务预算独立',()=>{
 const s=fixture(now,600),first=s.activeJobId,p=received(s);assert.equal(control(s,now).remaining,0);
 mutate(s,'job-create',{budget:300},now);const second=s.jobs.at(-1);assert.throws(()=>mutate(s,'job-start',{id:second.id},now),/结束当前/);
 mutate(s,'job-complete',{id:first},now);mutate(s,'job-start',{id:second.id},now);assert.equal(control(s,now).remaining,300);assert.equal(totals(s).spent,600);assert.equal(jobStats(s,first).spent,600);
 mutate(s,'job-pause',{id:second.id},now);assert.equal(control(s,now).gateCode,'job_not_running');mutate(s,'job-start',{id:second.id},now);assert.equal(control(s,now).canBuy,true);
 mutate(s,'pause',{paused:true},now);assert.equal(control(s,now).gateCode,'paused');assert.equal(p.jobId,first);
});
test('历史未决采购全局阻止新任务复购，不能结束尚有冻结的任务',()=>{
 const s=fixture(),p=reservePurchase(s,plan(s),now);p.status='unknown';assert.equal(control(s,now).gateCode,'pending');
 assert.throws(()=>mutate(s,'job-complete',{id:s.activeJobId},now),/未决/);assert.throws(()=>mutate(s,'job-cancel',{id:s.activeJobId},now),/未决/);
 mutate(s,'purchase-reconcile',{id:p.id,status:'cancelled',confirmed:true,note:'逐单确认未付款取消'},now);assert.equal(control(s,now).remaining,100000);mutate(s,'job-cancel',{id:s.activeJobId},now);assert.equal(s.jobs[0].status,'cancelled');
});
test('SMIS筛选严格比例、成交量、快照年龄、未来时间和去重',()=>{
 assert.equal(opportunities(fixture(),now).length,1);
 for(const change of [{steamTransactionQuantity:29},{steamTransactionQuantity:undefined},{updateTime:new Date(now-31*60000).toISOString()},{updateTime:new Date(now+6*60000).toISOString()},{buffSellPrice:3}]){const f=fixture();Object.assign(f.snapshot.rows[0],change);assert.equal(opportunities(f,now).length,0);}
 const s=fixture();s.snapshot.rows.push({...s.snapshot.rows[0]});assert.equal(opportunities(s,now).length,1);assert.equal(control(s,now+31*60000).gateCode,'stale');
});
test('BUFF逐档成本核验，单批和当前任务余额约束，不受Steam余额缺口影响',()=>{
 const s=fixture(),p=plan(s,[{unitCost:200,quantity:3},{unitCost:250,quantity:100},{unitCost:220,quantity:4}]);assert.equal(p.quantity,7);assert.equal(p.totalCost,1480);assert.deepEqual(p.depth,[{unitCost:200,quantity:3},{unitCost:220,quantity:4}]);
 const purchase=reservePurchase(s,p,now);assert.equal(purchase.jobId,s.activeJobId);assert.equal(control(s,now).reserved,1480);assert.equal(plan(s).quantity,3);
 assert.equal(plan(fixture(now,300)).quantity,1);const small=fixture();small.settings.maxBatchSpend=500;assert.equal(plan(small).quantity,2);
 assert.throws(()=>planPurchase(fixture(),{buffId:'1'},{...inspect(),steamId:'76561198000000001'},now),/账号/);assert.throws(()=>planPurchase(fixture(),{buffId:'1'},inspect(undefined,now-61000),now),/过期/);
});
test('预算锁定任务ID，拒绝过量预留及伪造最高单价',()=>{
 const s=fixture(now,300),p=plan(s);assert.throws(()=>reservePurchase(s,{...p,jobId:'other'},now),/当前运行任务/);
 assert.throws(()=>reservePurchase(s,{...p,maxPrice:9999},now),/最高价/);assert.throws(()=>reservePurchase(s,{...p,totalCost:400},now),/剩余预算/);
 reservePurchase(s,p,now);assert.equal(control(s,now).remaining,100);assert.throws(()=>plan(s),/不允许采购/);
});
test('未知或部分结果冻结全批预算，仅确认完整结果才释放差额',()=>{
 const s=fixture(),p=reservePurchase(s,plan(s),now),reservation=p.totalCost;applyBrowserResult(s,p.id,{status:'paid',final:false,steamId,orders:[{id:'KNOWN',cost:200,status:'paid'}],quantity:1,totalCost:200},now);
 assert.equal(p.status,'unknown');assert.equal(totals(s).reserved,reservation);assert.equal(totals(s).spent,0);assert.equal(s.jobs[0].status,'needs_action');
 mutate(s,'purchase-reconcile',{id:p.id,status:'paid',quantity:1,totalCost:200,orderRefs:['KNOWN'],confirmed:true,note:'该批仅此订单付款，余单未成交'},now);assert.equal(jobStats(s).spent,200);assert.equal(jobStats(s).reserved,0);assert.equal(p.quantity,1);assert.equal(control(s,now).canBuy,false);mutate(s,'job-start',{id:s.activeJobId},now);assert.equal(control(s,now).canBuy,true);
 const s2=fixture(),p2=reservePurchase(s2,plan(s2),now);applyBrowserResult(s2,p2.id,result(p2,'paid',{quantity:1,totalCost:200,orders:[{id:'ONE',cost:200,status:'paid'}]}),now);assert.equal(p2.status,'paid');assert.equal(totals(s2).spent,200);
});
test('订单号独立、金额与逐件比例强校验，超预留冻结实际金额',()=>{
 const s=fixture(),p=reservePurchase(s,plan(s),now);applyBrowserResult(s,p.id,result(p,'paid',{orders:Array.from({length:p.quantity},()=>({id:'DUP',cost:200,status:'paid'}))}),now);assert.equal(p.status,'unknown');
 const s2=fixture(),p2=reservePurchase(s2,plan(s2),now);applyBrowserResult(s2,p2.id,result(p2,'paid',{totalCost:2100,orders:Array.from({length:p2.quantity},(_,i)=>({id:`OVER-${i}`,cost:210,status:'paid'}))}),now);assert.equal(p2.status,'unknown');assert.equal(p2.totalCost,2100);assert.equal(s2.paused,true);
 const s3=fixture(),p3=received(s3);const p4=reservePurchase(s3,plan(s3),now);assert.throws(()=>mutate(s3,'purchase-reconcile',{id:p4.id,status:'paid',orderRefs:p3.orderRefs,confirmed:true,note:'误用订单'},now),/其他采购批次/);
});
test('付款不等于收货；只能售出明确收货批次，拒绝超售和重复成交号',()=>{
 const s=fixture(),p=reservePurchase(s,plan(s),now);applyBrowserResult(s,p.id,result(p),now);assert.throws(()=>sale(s,p,1),/明确收货/);
 mutate(s,'purchase-reconcile',{id:p.id,status:'received',confirmed:true,note:'Steam库存逐件确认收到'},now);sale(s,p,2);assert.equal(totals(s).soldQuantity,2);assert.equal(totals(s).unsoldQuantity,8);
 assert.throws(()=>sale(s,p,9),/未售数量/);mutate(s,'sale-add',{purchaseId:p.id,quantity:1,gross:100,fee:20,net:80,reference:'STEAM-1'},now);assert.throws(()=>mutate(s,'sale-add',{purchaseId:p.id,quantity:1,gross:100,fee:20,net:80,reference:'STEAM-1'},now),/重复/);
});
test('部分出售成本按逐单实付归集，手续费及净额精确，删除和修改重算库存',()=>{
 const s=fixture(),p=received(s,[{unitCost:201,quantity:1},{unitCost:219,quantity:2}]);const a=sale(s,p,1,500,50),b=sale(s,p,1,500,50,now+1);assert.equal(a.cost,201);assert.equal(b.cost,219);
 let t=totals(s);assert.equal(t.salesGross,1000);assert.equal(t.salesFees,100);assert.equal(t.salesNet,900);assert.equal(t.soldCost,420);assert.equal(t.inventoryCost,219);assert.equal(t.realizedRatio,420/900);
 mutate(s,'sale-delete',{id:a.id,note:'误录冲回'},now+2);assert.equal(b.cost,201);assert.equal(totals(s).unsoldQuantity,2);
 mutate(s,'sale-update',{id:b.id,quantity:3,gross:1200,fee:120,net:1080},now+3);t=totals(s);assert.equal(t.soldCost,p.totalCost);assert.equal(t.inventoryCost,0);assert.equal(t.soldQuantity,3);assert.equal(t.unsoldQuantity,0);
});
test('已有销售记录不能把已收货改回待收货；未售误标收货仍可纠正',()=>{
 const s=fixture(),p=received(s,[{unitCost:200,quantity:2}]);sale(s,p,1,400,50);const before=totals(s);
 assert.throws(()=>mutate(s,'purchase-reconcile',{id:p.id,status:'paid',confirmed:true,note:'错误改回未收货'},now),/已有出售记录.*已收货/);
 assert.equal(p.status,'received');assert.deepEqual(totals(s),before);assert.equal(before.receivedQuantity,2);assert.equal(before.soldQuantity,1);assert.equal(before.unsoldQuantity,1);assert.equal(before.inventoryCost,200);
 mutate(s,'purchase-reconcile',{id:p.id,status:'received',confirmed:true,note:'再次确认库存和订单'},now);assert.deepEqual(totals(s),before);
 const fresh=fixture(),unsold=received(fresh,[{unitCost:200,quantity:2}]);mutate(fresh,'purchase-reconcile',{id:unsold.id,status:'paid',confirmed:true,note:'原记录误标收货，实际尚未收到'},now);
 assert.equal(unsold.status,'paid');assert.equal(totals(fresh).receivedQuantity,0);assert.equal(totals(fresh).spent,400);assert.equal(totals(fresh).inventoryCost,400);
});
test('缺少逐单明细时整数分摊，全部出售总成本等于采购实付',()=>{
 const s=fixture(),p=received(s);delete p.orderDetails;p.totalCost=601;p.unitCost=201;sale(s,p,1);sale(s,p,1,1000,100,now+1);sale(s,p,1,1000,100,now+2);
 assert.deepEqual(s.sales.map(x=>x.cost),[200,200,201]);assert.equal(totals(s).soldCost,601);assert.equal(totals(s).inventoryCost,0);
});
test('净收入允许0或成本之下，售出收入不恢复采购预算；gross-fee=net必须满足',()=>{
 const s=fixture(now,600),p=received(s);sale(s,p,1,0,0);assert.equal(totals(s).salesNet,0);assert.equal(totals(s).realizedRatio,null);assert.equal(jobStats(s).remaining,0);
 assert.throws(()=>mutate(s,'sale-add',{purchaseId:p.id,quantity:1,gross:100,fee:20,net:90},now),/必须等于/);assert.throws(()=>mutate(s,'sale-add',{purchaseId:p.id,quantity:1,gross:100,fee:20,net:80,occurredAt:new Date(now+6*60000).toISOString()},now),/出售时间/);
});
test('退款仅按实际到账恢复当前任务余额，有出售记录不能全批退款',()=>{
 const s=fixture(now,600),p=received(s);mutate(s,'purchase-reconcile',{id:p.id,status:'refunded',refund:500,confirmed:true,note:'全批退回、退款到账500分'},now);assert.equal(totals(s).spent,100);assert.equal(jobStats(s).remaining,500);assert.equal(totals(s).receivedQuantity,0);assert.equal(totals(s).inventoryCost,0);
 const s2=fixture(),p2=received(s2);sale(s2,p2,1);assert.throws(()=>mutate(s2,'purchase-reconcile',{id:p2.id,status:'refunded',refund:600,confirmed:true,note:'错误退款'},now),/已有出售记录/);
});
test('全部售出后相同饰品释放持有件数，但不释放任务现金成本',()=>{
 const s=fixture(),p=received(s,[{unitCost:200,quantity:10}]);assert.equal(opportunities(s,now)[0].quantity,0);sale(s,p,10,4000,500);assert.equal(opportunities(s,now)[0].quantity,10);assert.equal(jobStats(s).spent,2000);assert.equal(totals(s).inventoryCost,0);
});
test('旧钱包和历史采购原样保留；旧closed不虚造售出收入，可补录出售',()=>{
 const old={schemaVersion:3,settings:{...initial().settings,lower:95000,target:100000,upper:105000,budget:100000,walletAgeMinutes:60},wallet:{balance:92000,at:new Date(now).toISOString()},purchases:[{id:'legacy-paid',name:'历史已售',quantity:2,totalCost:301,unitCost:151,expectedNet:400,bidNet:200,status:'closed',orderRefs:[]}]};
 const s=migrate(old);assert.equal(s.schemaVersion,4);assert.deepEqual(s.legacyWalletHistory[0],{...old.wallet,legacy:true});assert.equal(s.purchases[0].legacySaleUnrecorded,true);assert.equal(totals(s).salesNet,0);assert.equal(totals(s).soldQuantity,0);assert.equal('wallet' in s,false);assert.equal(s.jobs.length,0);
 sale(s,s.purchases[0],2,500,50);assert.equal(totals(s).soldCost,301);assert.equal(totals(s).legacySaleUnrecordedQuantity,0);
});
test('旧items预留迁移unknown；新任务不承接历史支出但仍拒绝未知结果',()=>{
 const s=migrate({settings:initial().settings,items:[{id:'old',buffId:'1',cost:350,expectedNet:600,status:'reserved'}]});assert.equal(s.purchases[0].status,'unknown');assert.equal(totals(s).reserved,350);assert.equal(s.legacyItems.length,1);mutate(s,'job-create',{budget:500},now);assert.throws(()=>mutate(s,'job-start',{id:s.activeJobId},now),/结果未知/);
});
test('SQLite幂等指令、冲突回滚与销售删除审计',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'funding-store-v4-')),file=path.join(dir,'funding.sqlite');let store;
 try{
  store=new Store(file);store.save(fixture());const key=randomUUID();store.command(key,'job-pause',{id:store.read().activeJobId},now);assert.equal(store.command(key,'job-pause',{id:store.read().activeJobId},now).duplicate,true);assert.throws(()=>store.command(key,'pause',{paused:true},now),/冲突/);assert.equal(store.read().paused,false);
  const s=fixture(),p=received(s),a=sale(s,p,1);store.save(s);store.command(randomUUID(),'sale-delete',{id:a.id,note:'错误录入'},now);assert.equal(store.read().sales.length,0);assert.equal(store.events()[0].type,'sale-delete');assert.equal(store.events()[0].payload.note,'错误录入');
 }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
test('SQLite迁移及提交中重启冻结，正在跑的任务不会重启后自动扣款',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'funding-recovery-v4-')),file=path.join(dir,'funding.sqlite');let store;
 try{
  const old=new DatabaseSync(file);old.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,body TEXT NOT NULL)');old.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify({schemaVersion:3,settings:initial().settings,purchases:[],wallet:{balance:1000,at:new Date(now).toISOString()}}));old.close();store=new Store(file);assert.equal(store.read().schemaVersion,4);assert.equal(store.read().legacyWalletHistory[0].balance,1000);
  const s=fixture(),p=reservePurchase(s,plan(s),now);p.status='submitting';store.save(s);store.close();store=new Store(file);assert.equal(store.read().purchases[0].status,'unknown');assert.equal(store.read().jobs[0].status,'needs_action');assert.equal(totals(store.read()).reserved,2000);
  store.save(fixture());store.close();store=new Store(file);assert.equal(store.read().jobs[0].status,'paused');assert.equal(control(store.read(),now).canBuy,false);
 }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
test('刷新失败可重试，异步进度可见，失败保留旧快照，成功才冷却',async()=>{
 let attempt=0,release;const delayed=new Promise(r=>{release=r;});const app=await temporaryApp({fetcher:async(s,request,options)=>{attempt++;options.onProgress({stage:'page',message:'正在读取第1页',page:1,rows:0});if(attempt===1)throw Error('测试网络中断');await delayed;return fixture().snapshot;}});
 try{
  app.store.save(fixture());await assert.rejects(app.refresh(),/中断/);assert.equal(app.view().control.canBuy,false);assert.equal(app.view().snapshot.rows.length,1);assert.equal(app.view().sync.cooldownUntil,null);
  const response=await post(app,'/api/refresh');assert.equal(response.status,202);assert.equal(app.view().refreshing,true);assert.equal(app.view().sync.progress.page,1);release();await app.refresh();assert.equal(app.view().sync.error,null);assert.equal(app.view().sync.progress.stage,'done');assert.equal(app.view().refreshing,false);await app.refresh();assert.equal(attempt,2);
 }finally{release();await app.dispose();}
});
test('自动采购关闭只预检；付款前持久化预留，支付异常冻结后不复购',async()=>{
 let buys=0,app;const browser=fakeBrowser({buy:async p=>{buys++;const live=app.store.read();assert.equal(live.purchases[0].status,'submitting');assert.equal(live.purchases[0].jobId,live.activeJobId);assert.equal(totals(live).reserved,p.totalCost);throw Error('支付页面超时');}});app=await temporaryApp({browser});
 try{
  app.store.save(fixture());await app.automate({buy:true});assert.equal(buys,0);assert.equal(app.view().purchases.length,0);assert.equal(app.view().automation.plan.quantity,10);
  app.store.command(randomUUID(),'settings',{autoBuy:true});await assert.rejects(app.automate({buy:true}),/支付页面超时/);assert.equal(buys,1);assert.equal(app.view().purchases[0].status,'unknown');assert.equal(app.view().totals.reserved,2000);assert.equal(app.view().jobs[0].status,'needs_action');await assert.rejects(app.automate({buy:true}),/结果未知|人工处理/);assert.equal(buys,1);
 }finally{await app.dispose();}
});
test('付款后核对收货，未知结果不自动释放，目标Steam账号不符禁止支付',async()=>{
 let buys=0,reconciles=0;const browser=fakeBrowser({buy:async p=>{buys++;return result(p);},reconcile:async p=>{reconciles++;return {status:'received',final:true,steamId,quantity:p.quantity,totalCost:p.totalCost,orders:p.orderDetails.map(o=>({...o,status:'received'}))};}});const app=await temporaryApp({browser});
 try{
  const s=fixture();s.settings.autoBuy=true;app.store.save(s);await app.automate({buy:true});assert.equal(app.view().purchases[0].status,'paid');await app.reconcilePaid();assert.equal(app.view().purchases[0].status,'received');assert.equal(reconciles,1);
  const state=app.store.read();state.purchases[0].status='unknown';app.store.save(state);await app.reconcilePaid();assert.equal(reconciles,1);
  app.store.save(fixture());app.store.command(randomUUID(),'settings',{autoBuy:true,expectedSteamId:'76561198000000001'});await assert.rejects(app.automate({buy:true}),/目标不一致/);assert.equal(buys,1);
 }finally{await app.dispose();}
});
test('本机HTTP来源限制、v0.4任务与账本契约、备份保留迁移钱包',async()=>{
 const app=await temporaryApp();
 try{
  app.store.save(fixture());const blocked=await fetch(app.base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'});assert.equal(blocked.status,403);
  const state=await(await fetch(app.base+'/api/state')).json();assert.equal(state.version,'0.4.0');for(const field of ['settings','jobs','activeJobId','activeJob','sales','totals','control','snapshot','sync','refreshing','candidates','purchases','automation','browser','events','demo'])assert.ok(field in state,field);assert.equal('wallet' in state,false);
  assert.equal((await fetch(app.base+'/')).status,200);assert.match(await(await fetch(app.base+'/api/export')).text(),/采购批次ID/);assert.equal((await(await fetch(app.base+'/api/export?format=json')).json()).schemaVersion,4);assert.equal((await post(app,'/api/command',{key:randomUUID(),type:'wallet',payload:{balance:1}})).status,400);assert.equal((await post(app,'/api/automation/preview',{wait:true})).status,200);
 }finally{await app.dispose();}
});
test('getJobs分任务件数与预算，旧采购不会耗新预算',()=>{
 const s=fixture(now,600),first=s.activeJobId,p=received(s);sale(s,p,1);mutate(s,'job-complete',{id:first},now);mutate(s,'job-create',{budget:500},now);mutate(s,'job-start',{id:s.activeJobId},now);const jobs=getJobs(s);assert.equal(jobs[0].spent,600);assert.equal(jobs[0].soldQuantity,1);assert.equal(jobs[1].remaining,500);assert.equal(totals(s).spent,600);
});
test('运行任务逐批采购至剩额不足，完成后保留未使用金额且不超支',async()=>{
 let buys=0;const app=await temporaryApp({browser:fakeBrowser({buy:async p=>{buys++;return result(p,'received');}})});
 try{
  const s=fixture(Date.now(),1100);s.settings.autoBuy=true;s.settings.maxBatchSpend=500;app.store.save(s);await app.runJob({id:s.activeJobId});const view=app.view();assert.equal(buys,3);assert.equal(view.purchases.reduce((n,p)=>n+p.totalCost,0),1000);assert.equal(view.jobs[0].remaining,100);assert.equal(view.jobs[0].status,'completed');assert.equal(view.totals.receivedQuantity,5);
 }finally{await app.dispose();}
});
test('核价期间切换任务拒绝旧任务继续付款，不把旧方案重绑新预算',async()=>{
 let signal,release,buys=0;const started=new Promise(r=>{signal=r;}),waiting=new Promise(r=>{release=r;});const app=await temporaryApp({browser:fakeBrowser({inspect:async()=>{signal();await waiting;return inspect(undefined,Date.now());},buy:async p=>{buys++;return result(p);}})});
 try{
  const s=fixture();s.settings.autoBuy=true;app.store.save(s);const task=app.automate({buy:true,jobId:s.activeJobId});await started;app.store.command(randomUUID(),'job-cancel',{id:s.activeJobId});app.store.command(randomUUID(),'job-create',{budget:500});app.store.command(randomUUID(),'job-start',{id:app.store.read().activeJobId});release();await assert.rejects(task,/任务/);assert.equal(buys,0);assert.equal(app.view().purchases.length,0);
 }finally{release();await app.dispose();}
});
test('历史已售未补金额独立列示，既不虚造收入也不计入库存；提交中禁止人工核对',()=>{
 const s=fixture(),current=received(s),legacy={id:'old-sold',quantity:2,totalCost:301,unitCost:151,bidNet:200,expectedNet:400,status:'closed',legacySaleUnrecorded:true,orderRefs:[],jobId:null};s.purchases.push(legacy);
 let t=totals(s);assert.equal(t.unsoldQuantity,current.quantity);assert.equal(t.inventoryCost,current.totalCost);assert.equal(t.salesNet,0);assert.equal(t.legacySaleUnrecordedQuantity,2);assert.equal(t.legacySaleUnrecordedCost,301);
 sale(s,legacy,1,300,30);t=totals(s);assert.equal(t.legacySaleUnrecordedQuantity,1);assert.equal(t.legacySaleUnrecordedCost,151);assert.equal(t.unsoldQuantity,current.quantity);assert.equal(t.inventoryCost,current.totalCost);
 sale(s,legacy,1,300,30,now+1);assert.equal(totals(s).legacySaleUnrecordedCost,0);assert.equal(totals(s).soldCost,301);assert.equal(totals(s).inventoryCost,current.totalCost);
 const submitting=reservePurchase(s,plan(s),now);submitting.status='submitting';assert.throws(()=>mutate(s,'purchase-reconcile',{id:submitting.id,status:'received',confirmed:true,note:'付款尚在进行，不能改写'},now),/当前批次不能重新核对/);assert.equal(submitting.status,'submitting');
});

test('单件最低采购金额以整数分保存，旧设置补0，SMIS筛选含等于最低金额',()=>{
 const old=initial();delete old.settings.minUnitPrice;assert.equal(migrate(old).settings.minUnitPrice,0);
 for(const minUnitPrice of [-1,1.5,'200',null])assert.throws(()=>validateSettings({minUnitPrice}),/单件最低采购金额/);
 const s=fixture();mutate(s,'settings',{minUnitPrice:200},now);assert.equal(opportunities(s,now).length,1);
 mutate(s,'settings',{minUnitPrice:201},now);assert.equal(opportunities(s,now).length,0);
 mutate(s,'settings',{minUnitPrice:0},now);assert.equal(opportunities(s,now).length,1);
});
test('实时逐件最低金额过滤及预留校验，金额更新后的旧方案不能提交',()=>{
 const s=fixture();mutate(s,'settings',{minUnitPrice:200},now);
 const p=plan(s,[{unitCost:199,quantity:5},{unitCost:200,quantity:1},{unitCost:220,quantity:1}]);
 assert.deepEqual(p.depth,[{unitCost:200,quantity:1},{unitCost:220,quantity:1}]);assert.equal(p.totalCost,420);assert.equal(p.minUnitPrice,200);
 assert.throws(()=>plan(s,[{unitCost:199,quantity:100}]),/最低金额/);
 assert.throws(()=>reservePurchase(s,{...p,minUnitPrice:0},now),/最低采购金额已变化/);
 assert.throws(()=>reservePurchase(s,{...p,depth:[{unitCost:199,quantity:2}],maxPrice:199,totalCost:398},now),/低于单件最低金额/);
 mutate(s,'settings',{minUnitPrice:201},now);assert.throws(()=>reservePurchase(s,p,now),/最低采购金额已变化/);assert.equal(s.purchases.length,0);
});
test('成交逐件低于批次最低金额冻结预算；后续提高最低金额不改变已付款记录',()=>{
 const s=fixture();mutate(s,'settings',{minUnitPrice:200},now);const p=reservePurchase(s,plan(s,[{unitCost:200,quantity:2}]),now);
 applyBrowserResult(s,p.id,result(p,'paid',{totalCost:399,orders:[{id:'BELOW-FLOOR',cost:199,status:'paid'},{id:'AT-FLOOR',cost:200,status:'paid'}]}),now);
 assert.equal(p.status,'unknown');assert.equal(totals(s).reserved,400);assert.equal(s.jobs[0].status,'needs_action');
 const existing=fixture(),paid=reservePurchase(existing,plan(existing,[{unitCost:200,quantity:1}]),now);applyBrowserResult(existing,paid.id,result(paid),now);
 mutate(existing,'settings',{minUnitPrice:300},now);applyBrowserResult(existing,paid.id,{status:'received',final:true,steamId,quantity:1,totalCost:200,orders:paid.orderDetails.map(o=>({...o,status:'received'}))},now);
 assert.equal(paid.status,'received');assert.equal(paid.totalCost,200);assert.equal(totals(existing).spent,200);
});
