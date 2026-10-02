// Local browser worker for the owner-only dry-run queue. No login secrets.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { OneWinDryRunCart } from './browser_cart.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pause = ms => new Promise(r => setTimeout(r, ms));
export async function connectWorker(cdp = 'http://127.0.0.1:19333') {
  const browser = await chromium.connectOverCDP(cdp);
  const pages = browser.contexts().flatMap(c => c.pages());
  const robin = pages.find(p => new URL(p.url()).hostname === 'robinarb.com');
  const one = pages.find(p => new URL(p.url()).hostname === '1win.pro');
  if (!robin || !one) throw new Error('Open signed-in RobinArb and 1win tabs in the test browser');
  const cart = new OneWinDryRunCart(one);
  const api = async (path, body) => robin.evaluate(async ({path,body}) => {
    const token = localStorage.getItem('robinarb.authToken');
    if (!token) throw new Error('RobinArb session missing');
    const response = await fetch('/api' + path, {method:body === undefined ? 'GET':'POST',
      headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json'},
      body:body === undefined ? undefined:JSON.stringify(body), signal:AbortSignal.timeout(35000)});
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail || result));
    return result;
  }, {path,body});
  return {browser, robin, one, cart, api};
}

export async function resolvePlan(arb) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.ROBINARB_TEST_PYTHON || resolve(root,'backend/.venv-test/bin/python'),
      [resolve(root,'scripts/onewin_plan.py')], {stdio:['pipe','pipe','pipe']});
    let output = '';
    const timer = setTimeout(()=>child.kill('SIGTERM'),20000);
    child.stdout.on('data',x=>output+=x);
    child.on('error',reject);
    child.on('close',()=>{clearTimeout(timer);try {resolveResult(JSON.parse(output));}catch {reject(new Error('ONEWIN_RESOLVER_NO_RESULT'));}});
    child.stdin.end(JSON.stringify(arb));
  });
}

export async function executeJob(worker, job, {allowPin888=false, screenshot}={}) {
  const started = performance.now();
  const clientId = `dry-${job.id}`;
  let report = {ok:false, dry_run:true, external_placement:false, cart_cleared:false,
    bia_or_pin_verified:false, stage:'price_verification'};
  try {
    // Independent reads in parallel. Only one requested event on each side.
    const [pin, plan] = await Promise.all([
      worker.api('/verify',{arb_id:job.arb_id, verify_mode:'betslip',verify_scope:'calculator',client_id:clientId,
        // Main qualification is deliberately BIA-only, including no MORE_BET.
        audit_bia_only:!allowPin888}),
      resolvePlan(job.arb),
    ]);
    report.pin_source = pin.source;
    report.pin_status = pin.status;
    report.pin_error = pin.error_code;
    if (!pin.verified || !pin.robin_quote_verified) throw new Error(pin.error_code || pin.detail || pin.status);
    report.bia_or_pin_verified = true;
    report.pin_price = pin.current_odds;
    report.robin_price = pin.robin_odds;
    report.price_check_ms = Math.round(performance.now()-started);
    if (!plan.ok) {report.stage='onewin_mapping'; report.quote=plan.quote; throw new Error(plan.quote?.status || plan.error || 'ONEWIN_PLAN_FAILED');}
    const cancelled = async()=>{
      const status = await worker.api('/automation/dry-run');
      return status.jobs.find(j=>j.id===job.id)?.cancel_requested === true;
    };
    if (await cancelled()) throw new Error('CANCELLED');
    const cartResult = await worker.cart.run(plan,{screenshot,cancelled});
    report = {...report,...cartResult};
  } catch(error) {
    report.error=String(error.message || error).slice(0,600);
    try {report.cart_cleared=await worker.cart.clear();} catch(cleanup) {report.cleanup_error=String(cleanup.message).slice(0,300);}
  } finally {
    try {await worker.api('/verify/calculator/release',{arb_id:job.arb_id,client_id:clientId});}
    catch(error) {report.release_error=String(error.message).slice(0,300);report.ok=false;}
    report.elapsed_ms=Math.round(performance.now()-started);
  }
  return report;
}

async function main() {
  const worker=await connectWorker(process.env.ROBINARB_TEST_CDP);
  await worker.cart.installGuard();
  console.log(JSON.stringify({mode:'dry_run',connected:true,live_placement:false}));
  let stop=false;
  process.on('SIGINT',()=>{stop=true;});
  process.on('SIGTERM',()=>{stop=true;});
  while (!stop) {
    try {
      const {job}=await worker.api('/automation/dry-run/claim');
      if (job) {
        const report=await executeJob(worker,job);
        const result=await worker.api('/automation/dry-run/result',{job_id:job.id,report});
        console.log(JSON.stringify({job:job.id,arb:job.arb_id,status:result.status,report}));
      }
    } catch(error) {console.log(JSON.stringify({stage:'worker',error:String(error.message).slice(0,500)}));}
    await pause(2000);
  }
  await worker.cart.clear();
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
