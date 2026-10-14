import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {initial,migrate,mutate} from './core.mjs';

export class Store{
 constructor(file){
  this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL);');
  this.db.prepare('INSERT OR IGNORE INTO state VALUES(1,?)').run(JSON.stringify(initial()));
  const before=this.read(),state=migrate(before),recovered=[],recoveredJobs=[];
  if(before.schemaVersion!==4){
   for(const event of this.db.prepare("SELECT seq,at,payload FROM events WHERE type='wallet' ORDER BY seq").all()){
    if(!state.legacyWalletHistory.some(record=>record.legacyEventSeq===event.seq))state.legacyWalletHistory.push({...JSON.parse(event.payload),at:event.at,legacy:true,legacyEventSeq:event.seq});
   }
  }
  for(const purchase of state.purchases){if(purchase.status==='submitting'){purchase.status='unknown';purchase.error='程序在提交期间退出；必须核对平台订单，禁止重复购买';purchase.updatedAt=new Date().toISOString();recovered.push(purchase.id);}}
  for(const job of state.jobs){
   if(job.status!=='running')continue;
   const unresolved=state.purchases.some(p=>p.jobId===job.id&&['submitting','unknown'].includes(p.status));
   job.status=unresolved?'needs_action':'paused';job.reason=unresolved?'重启后存在未决采购，先核对订单':'程序重新启动，请手动恢复本次采购任务';job.updatedAt=new Date().toISOString();recoveredJobs.push(job.id);
  }
  state.automation={...state.automation,state:'idle'};
  if(before.schemaVersion!==4||recovered.length||recoveredJobs.length)this.transaction(randomUUID(),'startup-recovery',{schemaVersion:4,recovered,recoveredJobs},()=>state);else this.save(state);
 }
 read(){return JSON.parse(this.db.prepare('SELECT body FROM state WHERE id=1').get().body);}
 save(state){this.db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(state));}
 transaction(key,type,payload,operation,now=Date.now()){
  if(typeof key!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw Error('缺少有效操作编号，请重新提交');
  const digest=createHash('sha256').update(JSON.stringify({type,payload})).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{
   const old=this.db.prepare('SELECT digest FROM events WHERE key=?').get(key);if(old){if(old.digest!==digest)throw Error('操作编号冲突');this.db.exec('COMMIT');return {duplicate:true};}
   const state=operation(this.read());this.save(state);this.db.prepare('INSERT INTO events(key,digest,at,type,payload) VALUES(?,?,?,?,?)').run(key,digest,new Date(now).toISOString(),type,JSON.stringify(payload));this.db.exec('COMMIT');return {duplicate:false};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 command(key,type,payload,now=Date.now()){return this.transaction(key,type,payload,state=>mutate(state,type,payload,now),now);}
 update(type,payload,operation,now=Date.now()){return this.transaction(randomUUID(),type,payload,operation,now);}
 events(){return this.db.prepare('SELECT seq,at,type,payload FROM events ORDER BY seq DESC LIMIT 200').all().map(event=>({...event,payload:JSON.parse(event.payload)}));}
 close(){if(!this.closed){this.closed=true;this.db.close();}}
}
