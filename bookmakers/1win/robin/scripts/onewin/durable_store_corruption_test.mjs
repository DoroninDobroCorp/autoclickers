import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptStore } from './browser_live_cart.mjs';

for (const kind of ['malformed_entry','duplicate_key','invalid_legacy_entry']) {
 test('durable store fails closed on '+kind, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'onewin-corrupt-fixture-'));
  try{
   const file=path.join(dir,'attempts.json');const store=new DurableAttemptStore(file,{maxStake:2});
   await store.claim('stable',{stake:1,currency:'USDT',payload:{idempotency_key:'stable',stake:1,currency:'USDT',selection:{event_id:'42',market_id:'fixture',selection_id:'10:1:0'},expected_odds:2.1}});
   const data=JSON.parse(fs.readFileSync(file,'utf8'));
   if(kind==='malformed_entry') data.entries.push(['corrupt']);
   if(kind==='duplicate_key') data.entries.push(data.entries[0]);
   if(kind==='invalid_legacy_entry'){data.attempts={'stable':data.entries[0][1],'lost':null};delete data.entries;}
   fs.writeFileSync(file,JSON.stringify(data));const original=fs.readFileSync(file,'utf8');
   assert.throws(()=>new DurableAttemptStore(file),/CORRUPT_DURABLE_ATTEMPT_STORE/);
   assert.equal(fs.readFileSync(file,'utf8'),original);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
}
