import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from './server.mjs';
import {initial,mutate} from './core.mjs';

const steamId='76561198000000000';
const iso=()=>new Date().toISOString();
function state({budget=1050,autoBuy=true,price=2,units=100}={}){
 const s=initial();Object.assign(s.settings,{autoRefresh:false,autoBuy,expectedSteamId:steamId,maxBatchSpend:400,maxUnits:units});
 s.snapshot={fetchedAt:iso(),scope:'测试假行情',rows:[{buffId:1,appid:730,cnName:'测试饰品 A',hashName:'A',buffSellPrice:price,steamBuyPrice:4,steamTransactionQuantity:30,updateTime:iso()}]};
 mutate(s,'job-create',{budget});return s;
}
function browser(overrides={}){return {status:()=>({state:'ready',steamId,error:null}),close:async()=>{},inspect:async candidate=>({buffId:candidate.buffId,steamId,checkedAt:iso(),depth:[{unitCost:candidate.cost,quantity:100}]}),buy:async plan=>({status:'received',final:true,steamId,quantity:plan.quantity,totalCost:plan.totalCost,orders:plan.depth.flatMap(d=>Array.from({length:d.quantity},()=>({id:randomUUID(),cost:d.unitCost,status:'received'})))}),...overrides};}
async function temporary(options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'funding-jobs-v4-'));const app=await createApp({dir,browser:browser(),...options});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 return {...app,base,dispose:async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});}};
}
async function post(app,route,payload={}){const response=await fetch(app.base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});return {status:response.status,value:await response.json()};}
function latch(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};}

test('最低单价通过HTTP持久化，低价候选不采购，任务保留余款',async()=>{
 let inspections=0,buys=0;const app=await temporary({browser:browser({inspect:async()=>{inspections++;throw Error('低价候选不应核价');},buy:async()=>{buys++;throw Error('不应支付');}})});
 try{
  app.store.save(state());const updated=await post(app,'/api/command',{key:randomUUID(),type:'settings',payload:{minUnitPrice:201}});
  assert.equal(updated.status,200);assert.equal(updated.value.state.settings.minUnitPrice,201);assert.equal(updated.value.state.candidates.length,0);
  await app.runJob();assert.equal(inspections,0);assert.equal(buys,0);assert.equal(app.view().activeJob.status,'completed');assert.equal(app.view().activeJob.remaining,1050);assert.equal(app.view().purchases.length,0);
 }finally{await app.dispose();}
});

test('降低最低采购金额后运行会刷新旧筛选快照，避免空快照误结束',async()=>{
 let refreshes=0;const app=await temporary({fetcher:async settings=>{refreshes++;assert.equal(settings.minUnitPrice,0);return {...state().snapshot,filters:{minUnitPrice:0}};}});
 try{
  const s=state({budget:205});s.snapshot.rows=[];s.snapshot.filters={minUnitPrice:1000};app.store.save(s);
  assert.equal(app.view().control.gateCode,'job_not_running');await app.runJob();
  assert.equal(refreshes,1);assert.equal(app.view().activeJob.spent,200);assert.equal(app.view().activeJob.remaining,5);assert.equal(app.view().ledger.purchaseQuantity,1);
 }finally{await app.dispose();}
});

test('任务按余额自动连续分批，最后不足一件保留余款，重复运行请求不会并发付款',async()=>{
 let buys=0;const blocked=latch(),entered=latch();
 const app=await temporary({browser:browser({buy:async plan=>{buys++;if(buys===1){entered.release();await blocked.promise;}return browser().buy(plan);}})});
 try{
  app.store.save(state());const id=app.view().activeJobId;
  assert.equal((await post(app,'/api/jobs/run',{id})).status,202);await entered.promise;
  assert.equal((await post(app,'/api/jobs/run',{id})).status,202);
  const done=app.runJob({id});blocked.release();await done;
  const s=app.view();assert.equal(buys,3);assert.equal(s.activeJob.status,'completed');assert.equal(s.activeJob.spent,1000);assert.equal(s.activeJob.remaining,50);assert.equal(s.ledger.purchaseQuantity,5);assert.equal(s.ledger.reserved,0);
 }finally{blocked.release();await app.dispose();}
});
test('自动采购关闭时任务运行只预检，不改变draft或创建订单',async()=>{
 let buys=0;const app=await temporary({browser:browser({buy:async()=>{buys++;throw Error('不应支付');}})});
 try{app.store.save(state({autoBuy:false}));const response=await post(app,'/api/jobs/run',{id:app.view().activeJobId,wait:true});assert.equal(response.status,200);assert.equal(buys,0);assert.equal(response.value.activeJob.status,'draft');assert.equal(response.value.purchases.length,0);assert.equal(response.value.automation.state,'preview');assert.equal(response.value.activeJob.remaining,1050);}finally{await app.dispose();}
});
test('真实合格卖单为空可完成，页面异常需要处理且保留全部预算',async()=>{
 for(const [inspection,status] of [[async candidate=>({buffId:candidate.buffId,steamId,depth:[],checkedAt:iso()}),'completed'],[async()=>{throw Error('BUFF 页面选择器超时');},'needs_action']]){
  const app=await temporary({browser:browser({inspect:inspection})});
  try{app.store.save(state());await app.runJob();const s=app.view();assert.equal(s.activeJob.status,status);assert.equal(s.activeJob.remaining,1050);assert.equal(s.purchases.length,0);}finally{await app.dispose();}
 }
});
test('付款未知停止连续购买、冻结本批、再次运行拒绝重买',async()=>{
 let buys=0;const app=await temporary({browser:browser({buy:async()=>{buys++;throw Error('付款超时');}})});
 try{app.store.save(state());await app.runJob();const s=app.view();assert.equal(buys,1);assert.equal(s.activeJob.status,'needs_action');assert.equal(s.activeJob.reserved,400);assert.equal(s.activeJob.remaining,650);assert.equal(s.purchases[0].status,'unknown');assert.equal((await post(app,'/api/jobs/run',{id:s.activeJobId})).status,400);assert.equal(buys,1);}finally{await app.dispose();}
});
test('明确付款但收货动作失败保留已付凭证并停止下一批',async()=>{
 let buys=0;const app=await temporary({browser:browser({buy:async plan=>{buys++;return {...await browser().buy(plan),status:'paid',orders:(await browser().buy(plan)).orders.map(o=>({...o,status:'paid'})),receiptError:'收货报价按钮超时'};}})});
 try{app.store.save(state());await app.runJob();assert.equal(buys,1);assert.equal(app.view().activeJob.status,'needs_action');assert.equal(app.view().purchases[0].status,'paid');assert.equal(app.view().activeJob.spent,400);assert.equal(app.view().activeJob.reserved,0);}finally{await app.dispose();}
});
test('核价期间暂停不提交订单，不自动把用户暂停改成需处理',async()=>{
 let buys=0;const entered=latch(),blocked=latch();const app=await temporary({browser:browser({inspect:async candidate=>{entered.release();await blocked.promise;return browser().inspect(candidate);},buy:async()=>{buys++;throw Error('不应支付');}})});
 try{app.store.save(state());const id=app.view().activeJobId,task=app.runJob();await entered.promise;assert.equal((await post(app,'/api/command',{key:randomUUID(),type:'job-pause',payload:{id}})).status,200);blocked.release();await task;assert.equal(buys,0);assert.equal(app.view().activeJob.status,'paused');assert.equal(app.view().purchases.length,0);}finally{blocked.release();await app.dispose();}
});
test('已提交后暂停仍核对本批实付，停止下一批采购',async()=>{
 let buys=0;const entered=latch(),blocked=latch();const app=await temporary({browser:browser({buy:async plan=>{buys++;entered.release();await blocked.promise;return browser().buy(plan);}})});
 try{app.store.save(state());const id=app.view().activeJobId,task=app.runJob();await entered.promise;await post(app,'/api/command',{key:randomUUID(),type:'job-pause',payload:{id}});blocked.release();await task;assert.equal(buys,1);assert.equal(app.view().activeJob.status,'paused');assert.equal(app.view().activeJob.spent,400);assert.equal(app.view().purchases[0].status,'received');assert.equal(app.view().activeJob.reserved,0);}finally{blocked.release();await app.dispose();}
});
test('过期快照运行前刷新，临时网络失败不将任务完成',async()=>{
 let refreshes=0;const app=await temporary({fetcher:async()=>{refreshes++;throw Error('SMIS 网络连接失败');}});
 try{const s=state();s.snapshot.fetchedAt='2020-01-01T00:00:00Z';app.store.save(s);await app.runJob();assert.equal(refreshes,1);assert.equal(app.view().activeJob.status,'needs_action');assert.equal(app.view().activeJob.remaining,1050);assert.match(app.view().sync.error,/连接失败/);}finally{await app.dispose();}
});
test('核价期间旧任务结束再启动新任务，不将旧候选偷换到新预算',async()=>{
 let buys=0;const entered=latch(),blocked=latch();const app=await temporary({browser:browser({inspect:async candidate=>{entered.release();await blocked.promise;return browser().inspect(candidate);},buy:async()=>{buys++;throw Error('不应支付');}})});
 try{app.store.save(state());const oldId=app.view().activeJobId,task=app.runJob();await entered.promise;app.store.command(randomUUID(),'job-cancel',{id:oldId});app.store.command(randomUUID(),'job-create',{budget:2000});const nextId=app.view().activeJobId;app.store.command(randomUUID(),'job-start',{id:nextId});blocked.release();await task;assert.equal(buys,0);assert.equal(app.view().purchases.length,0);assert.equal(app.view().activeJob.remaining,2000);assert.equal(app.view().jobs.find(j=>j.id===oldId).status,'cancelled');}finally{blocked.release();await app.dispose();}
});
test('采购和手动售出账本通过HTTP添加修改删除，导出同时含两类记录',async()=>{
 const app=await temporary();
 try{app.store.save(state({budget:200}));await app.runJob();const purchase=app.view().purchases[0];const add=await post(app,'/api/command',{key:randomUUID(),type:'sale-add',payload:{purchaseId:purchase.id,quantity:1,gross:400,fee:50,net:350,reference:'STEAM-TEST',occurredAt:iso()}});assert.equal(add.status,200);assert.equal(add.value.state.ledger.salesNet,350);const sale=add.value.state.sales[0];assert.equal((await post(app,'/api/command',{key:randomUUID(),type:'sale-update',payload:{id:sale.id,gross:300,fee:40,net:260}})).status,200);assert.equal(app.view().ledger.salesNet,260);const exported=await(await fetch(app.base+'/api/export')).text();assert.match(exported,/Steam手动销售/);assert.match(exported,/STEAM-TEST/);assert.equal((await post(app,'/api/command',{key:randomUUID(),type:'sale-delete',payload:{id:sale.id,note:'测试冲回'}})).status,200);assert.equal(app.view().ledger.salesNet,0);assert.equal(app.view().ledger.unsoldQuantity,1);}finally{await app.dispose();}
});
