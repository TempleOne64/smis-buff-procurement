import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv} from 'node:crypto';
import * as smis from './smis.mjs';

const credentials = {
  key: '1234567890123456',
  iv: '6543210987654321',
  auth2: '3d4b7647-283e-5f5b-8c1c-65ff8b166e97',
};
const bundle = `
const cryptoLibrary=libraryExport;
const renamedKey=cryptoLibrary.enc.Utf8.parse("${credentials.key}"),
      independentIv=cryptoLibrary.enc.Utf8.parse("${credentials.iv}");
function renamedToken(){
  let timestamp=cryptoLibrary.enc.Utf8.parse(Date.now());
  const encrypted=cryptoLibrary.AES.encrypt(timestamp,renamedKey,{
    iv:independentIv,mode:cryptoLibrary.mode.CBC,padding:cryptoLibrary.pad.Pkcs7
  });
  return cryptoLibrary.enc.Base64.stringify(encrypted.ciphertext);
}
client.interceptors.request.use(request=>{
  request.headers.Auth=renamedToken();
  request.headers.Auth2="${credentials.auth2}";
  return request;
});`;
const settings = {maxAgeMinutes:30,minVolume:30,ratio:0.7};
const options = {attempts:2,timeoutMs:1000,wait:async()=>{}};

function response(value,status=200){
  return new Response(typeof value==='string'?value:JSON.stringify(value),{
    status,headers:{'Content-Type':typeof value==='string'?'text/plain':'application/json'},
  });
}
function apiRequest(handler){
  return async(url,opts={})=>{
    const pathname=new URL(url).pathname;
    if(pathname==='/exchange'&&!opts.method)
      return response('<script type="module" crossorigin src="/assets/index-test.js"></script>');
    if(pathname==='/assets/index-test.js')return response(bundle);
    assert.equal(pathname,'/api/commodity/exchange');
    assert.equal(opts.method,'POST');
    return handler(JSON.parse(opts.body),opts);
  };
}
function quote(id){
  return {
    appid:730,buffId:id,id,cnName:`测试饰品 ${id}`,hashName:`Test item ${id}`,
    platform:'buff',buffSellPrice:2,steamBuyPrice:4,steamSellPrice:4.2,
    buffSellNum:100,steamBuyNum:100,steamTransactionQuantity:50,
    updateTime:new Date().toISOString(),
  };
}
function decryptAuth(auth){
  const decipher=createDecipheriv('aes-128-cbc',Buffer.from(credentials.key),Buffer.from(credentials.iv));
  return Number(Buffer.concat([decipher.update(Buffer.from(auth,'base64')),decipher.final()]).toString('utf8'));
}

test('SMIS 校验解析不依赖混淆变量名，独立读取 AES Key 与 IV',()=>{
  assert.deepEqual(smis.parseCredentials(bundle),credentials);
});

test('SMIS 校验解析拒绝不完整加密信息',()=>{
  assert.throws(()=>smis.parseCredentials('const a="1234567890123456";request.headers.Auth2="test";'));
  assert.throws(()=>smis.parseCredentials(bundle.replace(credentials.iv,'too-short')));
});

test('SMIS 校验解析允许单引号以及方括号请求头',()=>{
  assert.deepEqual(smis.parseCredentials(bundle.replaceAll('"',"'").replace('.headers.Auth2',".headers['Auth2']")),credentials);
});

test('SMIS 查询保留入金筛选，不额外要求服务器日期或涨幅；读取真实字段和多页',async()=>{
  const pages=[];
  const result=await smis.fetchSnapshot(settings,apiRequest((body,opts)=>{
    assert.equal(body.model,1);
    assert.deepEqual(body.platforms,['buff']);
    assert.equal(body.minTransactionQuantity,settings.minVolume);
    assert.equal(body.maxRate,settings.ratio);
    assert.equal(body.timeAfter,null);
    assert.equal(body.minWeekGrowthRate,null);
    assert.equal(body.maxWeekGrowthRate,null);
    assert.equal(opts.headers.Auth2,credentials.auth2);
    const timestamp=decryptAuth(opts.headers.Auth);
    assert.ok(Number.isSafeInteger(timestamp)&&Math.abs(Date.now()-timestamp)<5000);
    pages.push(body.pageNum);
    return response({code:200,data:Array.from({length:body.pageNum===1?50:2},(_,i)=>quote(body.pageNum*100+i))});
  }),options);
  assert.deepEqual(pages,[1,2]);
  assert.equal(result.rows.length,52);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('SMIS最低采购金额由整数分转为BUFF查询元金额，0保留默认且拒绝异常设置',async()=>{
 for(const [minUnitPrice,expected] of [[0,.01],[123,1.23],[200,2]]){
  let requested=false;await smis.fetchSnapshot({...settings,minUnitPrice},apiRequest(body=>{
   requested=true;assert.equal(body.minPrice,expected);assert.equal(body.maxPrice,5000);return response({code:200,data:[]});
  }),options);assert.equal(requested,true);
 }
 for(const minUnitPrice of [-1,1.5,'200'])await assert.rejects(smis.fetchSnapshot({...settings,minUnitPrice},apiRequest(()=>{throw Error('无效设置不能请求行情');}),options),/最低采购金额设置无效/);
});

test('SMIS HTTP 522 可恢复，重试必须重新生成可解密且更新的 Auth',async()=>{
  const timestamps=[];
  const progress=[];
  let waits=0;
  const request=apiRequest((body,opts)=>{
    timestamps.push(decryptAuth(opts.headers.Auth));
    return timestamps.length===1?response('upstream timeout',522):response({code:200,data:[quote(1)]});
  });
  const result=await smis.fetchSnapshot(settings,request,{
    ...options,
    onProgress:event=>progress.push(event),
    wait:async()=>{waits++;await new Promise(resolve=>setTimeout(resolve,15));},
  });
  assert.equal(result.rows.length,1);
  assert.equal(timestamps.length,2);
  assert.ok(timestamps[1]>timestamps[0],`重试 Auth 时间未更新：${timestamps}`);
  assert.ok(waits>=1);
  assert.equal(result.diagnostics.retries,1);
  assert.ok(progress.some(event=>event.stage==='retry'&&event.retries===1));
  assert.equal(progress.at(-1).stage,'done');
});

test('SMIS 首次请求重试仍失败时拒绝，不伪装成空行情',async()=>{
  await assert.rejects(smis.fetchSnapshot(settings,apiRequest(()=>response('upstream timeout',522)),options),/522/);
});

test('SMIS 拒绝异常响应外壳与缺少商品字段的伪行情',async()=>{
  for(const value of [{code:200,data:{}},{code:500,message:'maintenance',data:[]},{code:200,data:[{}]}]){
    await assert.rejects(smis.fetchSnapshot(settings,apiRequest(()=>response(value)),options));
  }
});

test('SMIS 重复分页保留去重报价并显式标记未完整扫描',async()=>{
  const first=Array.from({length:50},(_,i)=>quote(i+1));
  let calls=0;
  const result=await smis.fetchSnapshot(settings,apiRequest(()=>{calls++;return response({code:200,data:first});}),options);
  assert.equal(result.rows.length,50);
  assert.ok(calls>=2&&calls<=5);
  assert.equal(result.diagnostics.partial,true);
});

test('SMIS 后续页失败保留首批报价并显式标记部分结果',async()=>{
  const result=await smis.fetchSnapshot(settings,apiRequest(body=>body.pageNum===1
    ?response({code:200,data:Array.from({length:50},(_,i)=>quote(i+1))})
    :response('upstream timeout',522)),options);
  assert.equal(result.rows.length,50);
  assert.equal(result.diagnostics.partial,true);
});

test('SMIS 正常空数组以结构化空结果返回，不等同于网络失败',async()=>{
  const result=await smis.fetchSnapshot(settings,apiRequest(()=>response({code:200,data:[]})),options);
  assert.deepEqual(result.rows,[]);
  assert.equal(result.empty,true);
  assert.equal(result.diagnostics.partial,false);
  assert.equal(result.diagnostics.pages,1);
  assert.equal(result.diagnostics.rawCount,0);
  assert.equal(result.diagnostics.validCount,0);
});

test('SMIS 前端校验缓存以请求适配器隔离，不代替新行情读取',async()=>{
  let html=0,script=0,quotes=0;
  const original=apiRequest(()=>{quotes++;return response({code:200,data:[quote(quotes)]});});
  const request=async(url,opts)=>{
    const pathname=new URL(url).pathname;
    if(pathname==='/exchange')html++;
    if(pathname.endsWith('.js'))script++;
    return original(url,opts);
  };
  const first=await smis.fetchSnapshot(settings,request,options);
  const second=await smis.fetchSnapshot(settings,request,options);
  assert.equal(html,1);
  assert.equal(script,1);
  assert.equal(quotes,2);
  assert.notEqual(first.rows[0].buffId,second.rows[0].buffId);
});

test('SMIS 最低成交量与成本比例不能被设置放宽',async()=>{
  await smis.fetchSnapshot({minVolume:1,ratio:1},apiRequest(body=>{
    assert.equal(body.minTransactionQuantity,30);
    assert.equal(body.maxRate,.7);
    return response({code:200,data:[]});
  }),options);
  await assert.rejects(smis.fetchSnapshot({minVolume:30,ratio:0},apiRequest(()=>response({code:200,data:[]})),options),/设置/);
});

test('SMIS 5 页上限是部分市场，不伪装成完整行情',async()=>{
  const result=await smis.fetchSnapshot(settings,apiRequest(body=>response({code:200,data:Array.from({length:50},(_,i)=>quote(body.pageNum*100+i))})),options);
  assert.equal(result.rows.length,250);
  assert.equal(result.diagnostics.pages,5);
  assert.equal(result.diagnostics.partial,true);
  assert.match(result.warning,/上限/);
});

test('SMIS 页面阶段网络错误可诊断，重试次数保留在失败结果中',async()=>{
  let calls=0;
  const error=new TypeError('fetch failed',{cause:{code:'ENOTFOUND'}});
  await assert.rejects(smis.fetchSnapshot(settings,async()=>{calls++;throw error;},options),failure=>{
    assert.match(failure.message,/读取页面.*ENOTFOUND/);
    assert.equal(failure.diagnostics.retries,1);
    assert.equal(failure.diagnostics.pages,0);
    return true;
  });
  assert.equal(calls,2);
});

test('SMIS 不响应的请求受超时约束，不能让刷新永远卡住',async()=>{
  const started=Date.now();
  await assert.rejects(smis.fetchSnapshot(settings,()=>new Promise(()=>{}),{...options,attempts:1,timeoutMs:100}),/未响应/);
  assert.ok(Date.now()-started<2000);
});
