import {createCipheriv} from 'node:crypto';

const BASE = 'https://smis.club';
const credentialCache = new WeakMap();
const CACHE_MS = 10 * 60 * 1000;
const TOTAL_DEADLINE_MS = 80_000;
const IDENT = '[A-Za-z_$][\\w$]*';
const STRING = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;

function literal(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  return value.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\\'"nrtbfv0])/g, (_, escape) => {
    if (escape.startsWith('u') || escape.startsWith('x')) return String.fromCharCode(parseInt(escape.slice(1), 16));
    return ({n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', '0':'\0'})[escape] ?? escape;
  });
}

// Read the constants used by the AES call. Never execute the downloaded bundle.
export function parseCredentials(js) {
  if (typeof js !== 'string') throw Error('SMIS 校验脚本不是文本');
  const constants = new Map();
  const assignment = new RegExp(`(${IDENT})\\s*=\\s*(${IDENT})\\.enc\\.Utf8\\.parse\\(\\s*(${STRING})\\s*\\)`, 'g');
  for (const match of js.matchAll(assignment)) constants.set(match[1], {library:match[2], value:literal(match[3])});
  const authHeader = new RegExp(`\\.headers(?:\\.Auth2|\\[\\s*["']Auth2["']\\s*\\])\\s*=\\s*(${STRING})`).exec(js);
  if (!authHeader) throw Error('SMIS 校验脚本缺少 Auth2 请求头');
  const auth2 = literal(authHeader[1]);
  const encrypt = new RegExp(`(${IDENT})\\.AES\\.encrypt\\(\\s*[^,]{1,500},\\s*(${IDENT})\\s*,\\s*\\{([^}]{1,1500})\\}`, 'g');
  const matches = [];
  for (const match of js.matchAll(encrypt)) {
    const ivName = new RegExp(`(?:^|,)\\s*iv\\s*:\\s*(${IDENT})\\b`).exec(match[3])?.[1];
    const key = constants.get(match[2]), iv = constants.get(ivName);
    if (!key || !iv || key.library !== match[1] || iv.library !== match[1]) continue;
    if (!/\.mode\.CBC\b/.test(match[3]) || !/\.pad\.Pkcs7\b/.test(match[3])) continue;
    matches.push({key:key.value, iv:iv.value, auth2});
  }
  const unique = [...new Map(matches.map(value => [JSON.stringify(value), value])).values()];
  if (unique.length !== 1) throw Error('SMIS AES 校验结构变化，无法唯一确定 Key 和 IV');
  const value = unique[0];
  if (![16,24,32].includes(Buffer.byteLength(value.key)) || Buffer.byteLength(value.iv) !== 16 || !value.auth2)
    throw Error('SMIS AES 校验 Key、IV 或 Auth2 无效');
  return value;
}

function failure(message, {retryable=false, status, cause}={}) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.retryable = retryable;
  if (status) error.status = status;
  return error;
}
function detail(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code || cause?.errors?.find(value => value.code)?.code;
  return `${error?.message || String(error)}${code ? ` (${code})` : ''}`;
}
function validRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (![730,570].includes(Number(row.appid)) || !/^\d+$/.test(String(row.buffId)) || Number(row.buffId) <= 0) return false;
  if (typeof row.hashName !== 'string' || !row.hashName.trim() || typeof row.updateTime !== 'string') return false;
  const time = /[zZ]$|[+-]\d\d:\d\d$/.test(row.updateTime) ? row.updateTime : row.updateTime.replace(' ', 'T') + '+08:00';
  if (!Number.isFinite(Date.parse(time))) return false;
  for (const name of ['buffSellPrice','steamBuyPrice','steamSellPrice','steamTransactionQuantity']) {
    if (row[name] === null || row[name] === undefined || row[name] === '' || !Number.isFinite(Number(row[name])) || Number(row[name]) < 0) return false;
  }
  return true;
}

export async function fetchSnapshot(settings={}, request=fetch, options={}) {
  if (typeof request !== 'function') throw Error('SMIS 请求适配器无效');
  const started = Date.now(), deadline = started + TOTAL_DEADLINE_MS;
  const attempts = Math.max(1, Math.min(5, Math.floor(Number(options.attempts) || 3)));
  const timeoutMs = Math.max(100, Math.min(25_000, Number(options.timeoutMs) || 15_000));
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const diagnostics = {pages:0, rawCount:0, validCount:0, partial:false, retries:0, durationMs:0};
  let latestAuthTime = 0;
  function progress(stage, message, extra={}) {
    try {
      const notification=options.onProgress?.({stage, message, elapsedMs:Date.now()-started, retries:diagnostics.retries, ...extra});
      notification?.catch?.(()=>{});
    } catch {}
  }
  async function get(url, makeOptions, read, stage) {
    for (let attempt=1; attempt<=attempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw failure(`SMIS 刷新已达到 ${TOTAL_DEADLINE_MS/1000} 秒总时限（${stage}）`);
      progress('request', `正在${stage}`, {attempt, attempts});
      const duration = Math.min(timeoutMs, remaining);
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const init = makeOptions?.() || {};
            const response = await request(url, {...init, headers:{
              'User-Agent':'Mozilla/5.0', 'Accept':'*/*', ...init.headers,
            }, signal:controller.signal});
            if (!response?.ok) {
              await response?.body?.cancel?.().catch(()=>{});
              if (response?.status === 401 || response?.status === 403) credentialCache.delete(request);
              throw failure(`SMIS ${stage} HTTP ${response?.status ?? '未知'}`, {
                retryable:response?.status === 429 || response?.status >= 500, status:response?.status,
              });
            }
            return await read(response);
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(failure(`SMIS ${stage}超过 ${Math.ceil(duration/1000)} 秒未响应`, {retryable:true}));
            }, duration);
          }),
        ]);
      } catch (caught) {
        const error = caught.retryable !== undefined ? caught : failure(`SMIS ${stage}失败：${detail(caught)}`, {
          retryable:caught.name === 'TypeError' || caught.name === 'AbortError' || caught.name === 'TimeoutError', cause:caught,
        });
        if (!error.retryable || attempt === attempts || deadline-Date.now() <= 0) throw error;
        diagnostics.retries++;
        progress('retry', `${error.message}，准备第 ${attempt+1} 次尝试`, {attempt:attempt+1, attempts});
        await wait(Math.min(1000*attempt, Math.max(0, deadline-Date.now())));
      } finally { clearTimeout(timer); }
    }
  }
  async function credentials() {
    const cached = credentialCache.get(request);
    if (cached && cached.expiresAt > Date.now()) {
      progress('credentials', '使用本次进程近期已验证的 SMIS 校验脚本');
      return cached.value;
    }
    const html = await get(BASE+'/exchange', null, response => response.text(), '读取页面');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)];
    const source = scripts.map(match => new URL(match[2], BASE)).find(url =>
      url.origin === BASE && /^\/assets\/index-[^/]+\.js$/.test(url.pathname));
    if (!source) throw failure('SMIS 页面结构变化，未找到官方主脚本');
    const js = await get(source.href, null, response => response.text(), '读取校验脚本');
    const value = parseCredentials(js);
    credentialCache.set(request, {value, expiresAt:Date.now()+CACHE_MS});
    return value;
  }
  const minVolume = Number(settings.minVolume ?? 30), ratio = Number(settings.ratio ?? .7);
  if (!Number.isFinite(minVolume) || minVolume < 0 || !Number.isFinite(ratio) || ratio <= 0)
    throw failure('SMIS 最低成交量或成本比例设置无效');
  const minUnitPrice = settings.minUnitPrice ?? 0;
  if (!Number.isSafeInteger(minUnitPrice) || minUnitPrice < 0)
    throw failure('SMIS 单件最低采购金额设置无效（单位：分）');
  let parsed;
  try { parsed=await credentials(); }
  catch(error) {
    error.diagnostics={...diagnostics, durationMs:Date.now()-started};
    progress('failed', error.message);
    throw error;
  }
  const {key, iv, auth2}=parsed;
  const query = {
    model:1, platforms:['buff'], appid:null, minPrice:Math.max(.01, minUnitPrice/100), maxPrice:5000,
    minTransactionQuantity:Math.max(30, Math.ceil(minVolume)),
    minWeekGrowthRate:null, maxWeekGrowthRate:null, minRate:null, maxRate:Math.min(.7, ratio),
    minSteamSellSubBuyRatio:null, timeAfter:null, pageSize:50,
    buffTax:.015, buffLimit:9999999, uuypTax:.01, uuypLimit:9999999,
    c5Tax:.01, c5Limit:100, igxeTax:.006, igxeLimit:9999999, ecoTax:0, ecoLimit:9999999,
  };
  const rows = [], seen = new Set();
  let warning = null;
  for (let pageNum=1; pageNum<=5; pageNum++) {
    try {
      const json = await get(BASE+'/api/commodity/exchange', () => {
        latestAuthTime = Math.max(Date.now(), latestAuthTime+1);
        const cipher = createCipheriv(`aes-${Buffer.byteLength(key)*8}-cbc`, Buffer.from(key), Buffer.from(iv));
        const auth = Buffer.concat([cipher.update(String(latestAuthTime)), cipher.final()]).toString('base64');
        return {method:'POST', headers:{
          'Content-Type':'application/json', Auth:auth, Auth2:auth2,
          Referer:BASE+'/exchange', Origin:BASE,
        }, body:JSON.stringify({...query, pageNum})};
      }, async response => {
        let json;
        try { json = await response.json(); } catch { throw failure('SMIS 行情响应不是有效 JSON'); }
        if (!json || json.code !== 200 || !Array.isArray(json.data)) {
          if (json?.code === 401 || json?.code === 403 || json?.code === 5001) credentialCache.delete(request);
          throw failure(`SMIS 行情响应结构或状态无效${json?.code ? `（code ${json.code}）` : ''}`);
        }
        if (json.data.some(row => !validRow(row))) throw failure('SMIS 行情数组存在缺少商品、价格或报价时间的记录');
        return json;
      }, `读取行情第 ${pageNum} 页`);
      diagnostics.pages++;
      diagnostics.rawCount += json.data.length;
      let added = 0;
      for (const row of json.data) {
        const id = `${row.appid}:${row.buffId}`;
        if (!seen.has(id)) { seen.add(id); rows.push(row); added++; }
      }
      diagnostics.validCount = rows.length;
      progress('page', `第 ${pageNum} 页取得 ${json.data.length} 条，共 ${rows.length} 条去重报价`, {page:pageNum, count:rows.length});
      if (!json.data.length) break;
      if (!added) { diagnostics.partial=true; warning='接口分页未前进，仅保留本轮已取得的报价'; break; }
      if (json.data.length < 50) break;
      if (pageNum === 5) { diagnostics.partial=true; warning='达到每轮 5 页扫描上限，结果仅覆盖部分市场'; }
    } catch (error) {
      if (!rows.length) {
        error.diagnostics={...diagnostics, durationMs:Date.now()-started};
        progress('failed', error.message);
        throw error;
      }
      diagnostics.partial=true;
      warning=`后续页未完成：${error.message}；仅保留本轮已取得的 ${rows.length} 条报价`;
      break;
    }
  }
  diagnostics.durationMs=Date.now()-started;
  const empty=rows.length === 0;
  progress('done', empty ? 'SMIS 接口已响应，本轮筛选结果为 0 条' : `本轮取得 ${rows.length} 条真实报价`, {count:rows.length, partial:diagnostics.partial});
  return {
    rows, fetchedAt:new Date().toISOString(), empty, warning, diagnostics, filters:{minUnitPrice},
    scope:`BUFF → Steam 丢求购；本轮读取 ${diagnostics.pages} 页、${rows.length} 条去重报价。${empty ? '接口筛选为空，不代表全市场没有机会。' : '报价更新时间由采购筛选单独核验。'}${warning ? ' '+warning : ''}`,
  };
}
