import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nearlySpent,subscriptionLinks,subscriptionRows,subscriptionTotals,tightest,usedBy} from '../app/subscriptions';
import {elevenLabsAccount,readElevenLabsAccount} from '../app/elevenlabs-account';

const answer={tier:'starter',character_count:3700,character_limit:10000,status:'active',next_character_count_reset_unix:1795000000,currency:'usd',billing_period:'monthly_period',next_invoice:{amount_due_cents:600}};
const state:any={
 claude:{connected:true,status:'Signed in',plan:'max',windows:[{label:'Current session',usedPercent:12,resetAt:'2026-11-18T03:00:00.000Z'},{label:'Weekly · Fable',usedPercent:92,resetAt:null},{label:'Weekly · Opus',usedPercent:null,resetAt:null}],credits:{enabled:false}},
 codex:{connected:true,status:'Signed in',models:[],plan:'pro',windows:[{label:'Session',usedPercent:4,resetAt:null,durationSeconds:18000}]},
 connected:true,balance:'$3.42',
 apiProviders:[{provider:'gemini',connected:true,models:[{id:'api:gemini:gemini-4-carbon'},{id:'api:gemini:gemini-4-hydrogen'}]},{provider:'openrouter-api',connected:true,models:[],keyBudgetRemaining:4.5,keyLimitReset:'monthly'},{provider:'xai-oauth',connected:true,models:[]},{provider:'mistral',connected:false,models:[]}],
 voice:{listening:{connected:{elevenlabs:true,deepgram:true}},freeKeySaved:true,installed:['large-v3'],wake:{installed:true}},voices:{installed:true,zonos:{connected:true}},
 remote:{tokenSaved:true},share:{ready:true},decisionEngine:{pickers:[{id:'jev',label:'Jev · TypeSafe',connected:true},{id:'kev',label:'Kev · Local',connected:true},{id:'glide',label:'Fastino GLiDE',connected:false}]},
};
const account=readElevenLabsAccount(answer,new Date('2026-11-18T00:00:00Z'))!;

test('every connection is a row, with its plan, what is left and where its price comes from',()=>{
 const {rows,free}=subscriptionRows(state,{prices:{},elevenlabs:account});
 assert.deepEqual(rows.map(row=>[row.id,row.group,row.price.source,row.price.usd]),[
  ['claude','subscription','estimate',100],['chatgpt','subscription','unknown',null],['elevenlabs','subscription','confirmed',6],
  ['gemini','use','unknown',null],['openrouter-api','use','unknown',null],['xai-oauth','subscription','unknown',null],
  ['deepseek','use','unknown',null],['deepgram','use','unknown',null],['zyphra','use','unknown',null]]);
 const [claude,chatgpt,eleven]=rows;
 assert.equal(claude.plan,'Max');assert.match(claude.price.why,/^List price of Max, read 2026-\d\d-\d\d from claude\.com$/);
 assert.deepEqual(claude.windows,[{label:'Current session',left:88,resetAt:'2026-11-18T03:00:00.000Z'},{label:'Weekly · Fable',left:8,resetAt:null}],'a window with no figure is left out');
 assert.deepEqual(tightest(claude),{label:'Weekly · Fable',left:8,resetAt:null});assert.deepEqual(claude.facts,[['Usage credits','Off']]);
 assert.match(chatgpt.price.why,/several prices \(\$100\.00, \$200\.00, \$500\.00\)/);assert.equal(chatgpt.windows[0].label,'5-hour limit');
 assert.equal(eleven.plan,'Starter');assert.match(eleven.price.why,/next invoice/);assert.equal(eleven.listUsd,6);
 assert.deepEqual(eleven.windows,[{label:'Credits this period',left:63,resetAt:account.resetAt}]);
 assert.equal(rows.find(row=>row.id==='openrouter-api')!.balance,'$4.50 · resets monthly');assert.equal(rows.find(row=>row.id==='deepseek')!.balance,'$3.42');
 assert.deepEqual(free,[{name:'Gemini voice',what:'free tier key'},{name:'Telegram remote',what:'free'},{name:'Cloudflare share site',what:'plan not read'},{name:'Jev · TypeSafe',what:'cost not read'},{name:'Kev · Local',what:'on this PC'},{name:'Whisper',what:'on this PC'},{name:'Kokoro voices',what:'on this PC'},{name:'Wake word',what:'on this PC'}]);
});
test('a typed figure confirms a row and moves it between the totals',()=>{
 const before=subscriptionTotals(subscriptionRows(state,{prices:{},elevenlabs:account}).rows);
 assert.deepEqual(before,{confirmed:6,estimated:100,unknown:7,sum:106});
 const {rows}=subscriptionRows(state,{prices:{claude:108.9,chatgpt:200,gemini:0},elevenlabs:account});
 assert.deepEqual(rows[0].price,{usd:108.9,source:'confirmed',why:'You typed this figure'});assert.equal(rows[0].listUsd,100);
 assert.deepEqual(subscriptionTotals(rows),{confirmed:314.9,estimated:0,unknown:5,sum:314.9});
 assert.equal(subscriptionRows(state,{prices:{toString:1} as any}).rows.length,9,'a price for no row changes nothing');
});
test('ElevenLabs without an account read is an estimate from nothing, so paid and unknown; another currency is not added as dollars',()=>{
 const none=subscriptionRows(state,{prices:{},elevenlabsNote:'This key may not read the account.'}).rows.find(row=>row.id==='elevenlabs')!;
 assert.equal(none.price.source,'unknown');assert.equal(none.plan,'API key');assert.deepEqual(none.facts.at(-1),['Account','This key may not read the account.']);
 const euro=subscriptionRows(state,{prices:{},elevenlabs:readElevenLabsAccount({...answer,currency:'eur',billing_period:'annual_period',next_invoice:{amount_due_cents:6000}})}).rows.find(row=>row.id==='elevenlabs')!;
 assert.deepEqual(euro.price,{usd:null,source:'confirmed',why:'Your next invoice, as ElevenLabs reports it',other:'5.00 EUR'});
 const noInvoice=subscriptionRows(state,{prices:{},elevenlabs:readElevenLabsAccount({...answer,next_invoice:null})}).rows.find(row=>row.id==='elevenlabs')!;
 assert.equal(noInvoice.price.source,'estimate');assert.equal(noInvoice.price.usd,6);
});
test('a row is marked nearly spent by its tightest limit, at 20% left or less',()=>{
 const {rows}=subscriptionRows(state,{prices:{},elevenlabs:account}),[claude,chatgpt,eleven]=rows;
 assert.deepEqual(nearlySpent(claude),{label:'Weekly · Fable',left:8,resetAt:null});
 assert.equal(nearlySpent(chatgpt),null,'96% left');assert.equal(nearlySpent(eleven),null,'63% left');
 assert.equal(nearlySpent(rows.find(row=>row.id==='deepseek')!),null,'a balance is not a limit');
 const edge=(left:number)=>nearlySpent({...claude,windows:[{label:'Weekly',left,resetAt:null}]});
 assert.equal(edge(20)?.left,20);assert.equal(edge(20.5),null);assert.equal(edge(0)?.left,0);
});
test('a row uses the tokens of its own supplier\'s models; links open only the suppliers\' own pages',()=>{
 const {rows}=subscriptionRows(state,{prices:{}}),models={'claude-code:opus':10,'claude-code:fable':5,'gpt-6-astra':7,'api:gemini:gemini-4-carbon':3,'deepseek-flash':2,'command:x':9};
 assert.deepEqual(rows.map(row=>usedBy(row,models)),[15,7,null,3,0,0,2,null,null]);
 for(const row of rows)for(const link of row.links){assert.match(link.kind,/^sub:[a-z-]+:\d$/);assert.match(subscriptionLinks[link.kind],/^https:\/\//,link.kind);}
 assert.equal(subscriptionLinks['sub:claude:0'],'https://claude.ai/settings/billing');assert.ok(rows.every(row=>row.links.length>0));
});
test('the ElevenLabs answer is read by its documented shape, and a refusal is said in words',async()=>{
 assert.deepEqual(account,{tier:'starter',status:'active',used:3700,limit:10000,resetAt:new Date(1795000000*1000).toISOString(),invoice:{amount:6,currency:'usd',months:1},checkedAt:'2026-11-18T00:00:00.000Z'});
 assert.equal(readElevenLabsAccount({tier:'free',character_count:1,character_limit:10000})!.invoice,null);assert.equal(readElevenLabsAccount({tier:'free',character_count:1,character_limit:10000})!.resetAt,null);
 for(const bad of [null,{},{tier:'',character_count:1,character_limit:2},{tier:'x',character_count:-1,character_limit:2},{tier:'x',character_count:'1',character_limit:2}])assert.equal(readElevenLabsAccount(bad),null);
 let asked:any;const fetcher=(async(url:string,init:any)=>{asked={url,key:init.headers['xi-api-key']};return new Response(JSON.stringify(answer),{status:200});}) as typeof fetch;
 assert.equal((await elevenLabsAccount('k1','http://127.0.0.1:9/',fetcher)).tier,'starter');assert.deepEqual(asked,{url:'http://127.0.0.1:9/v1/user/subscription',key:'k1'});
 await assert.rejects(elevenLabsAccount('k',undefined,(async()=>new Response('',{status:401})) as typeof fetch),/may not read the account/);
 await assert.rejects(elevenLabsAccount('k',undefined,(async()=>new Response('',{status:500})) as typeof fetch),/HTTP 500/);
 await assert.rejects(elevenLabsAccount('k',undefined,(async()=>{throw Error('offline');}) as typeof fetch),/could not be reached/);
 await assert.rejects(elevenLabsAccount('k',undefined,(async()=>new Response('{"tier":1}',{status:200})) as typeof fetch),/shape/);
});
