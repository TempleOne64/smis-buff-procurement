import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {createApp} from '../server.mjs';
import {loadPlaywright} from '../buff-browser.mjs';
const folder=(await readdir('.diagnostics')).filter(name=>/^live-verification-\d+$/.test(name)).sort().at(-1);
if(!folder)throw Error('请先运行 verify-live.mjs 取得真实行情验证记录');
const app=await createApp({dir:path.resolve('.diagnostics',folder)});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const {chromium}=await loadPlaywright();const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_BROWSER_EXECUTABLE}:{})});
try{const page=await browser.newPage({viewport:{width:1440,height:1050}});await page.goto('http://127.0.0.1:'+app.server.address().port);await page.waitForFunction(()=>document.querySelector('#connection').classList.contains('connected'));await page.screenshot({path:'artifacts/procurement-live.png',fullPage:false});await page.screenshot({path:'artifacts/procurement-overview.png',fullPage:true});}
finally{await browser.close();await new Promise(r=>app.server.close(r));}
