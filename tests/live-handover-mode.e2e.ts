// Handover mode on the real engines (his GO 10-25: "use opus5.5 as engine and astra"). Runs Ghidorah Dev from source:
// its own data and keys beside the installed copy, his Claude Code and ChatGPT sign-ins. Opt-in only.
// TRISMEGISTUS_LIVE_HANDOVER_MODE=1 node --import tsx tests/live-handover-mode.e2e.ts
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
if(process.env.TRISMEGISTUS_LIVE_HANDOVER_MODE!=='1')throw Error('Set TRISMEGISTUS_LIVE_HANDOVER_MODE=1 for the authorized live handover check.');
if(process.env.TRISMEGISTUS_TEST_DATA||process.env.TRISMEGISTUS_EXE)throw Error('This check runs Ghidorah Dev from source.');
const root=path.resolve('.'),env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
const instance=await electron.launch({args:[root,'--hidden'],env,timeout:60000});
await instance.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
const excerpt=(text:string)=>text.replace(/\s+/g,' ').trim().slice(0,400);
try{
 const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean,seconds=420)=>{const end=Date.now()+seconds*1000;while(Date.now()<end){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(500);}throw Error('Live handover timed out');};
 let state=await wait(s=>s.backend==='ready'&&s.claude?.models?.length,180);
 // Ghidorah Dev keeps its own sign-ins: Astra runs only once Dev's ChatGPT connection is set up.
 if(!state.codex?.models?.length)state=await wait(s=>s.codex?.models?.length||s.codex?.connected===false,60);
 const opus=state.claude.models.find((m:any)=>/opus/i.test(m.id+' '+m.label)&&/5\.5|5-5/.test(m.id+' '+m.label))||state.claude.models.find((m:any)=>/opus/i.test(m.id));
 const astra=state.codex?.models?.find((id:string)=>/astra/i.test(id));
 assert.ok(opus,'Opus 5.5 is connected');
 const done=async(id:string)=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted','stopped'].includes(t.status)));const turn=s.turns.find((t:any)=>t.id===id);assert.equal(turn.status,'completed',turn.error||'');return turn;};
 const run=async(label:string,model:string)=>{
  const old=await call('addProject');await call('sidebarChat',{action:'rename',chatId:old,name:'Handover live check '+label});await call('addModel',{chatId:old,model});await call('effort',{chatId:old,model,effort:'low'}).catch(()=>{});
  const send=async(chatId:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});return id;};
  await done(await send(old,'Live handover check. We are designing a tiny feature: a function `add(a, b)` that returns the sum, in a file `math.ts` that does not exist yet. My ruling: never use semicolons in this code. Decided: plain TypeScript, no library. Do not use tools and do not create files; reply in two sentences.'));
  const handoverId=await send(old,'/handoff Do not use tools.'),handover=await done(handoverId);
  assert.equal((await call('state')).chats.find((c:any)=>c.id===old).handover.stage,'writing');
  const check=await call('handoverCheck',{chatId:old,turnId:handoverId});
  const fresh=await call('handoverStart',{chatId:old,turnId:handoverId,model});
  state=await wait(s=>s.turns.some((t:any)=>t.chatId===fresh&&t.status==='completed'));
  const first=state.turns.find((t:any)=>t.chatId===fresh);assert.equal(first.model,model);
  assert.match(first.text,/add/i,'the restatement names the feature');assert.match(first.text,/semicolon/i,'the restatement keeps his ruling');
  const titles=[state.chats.find((c:any)=>c.id===old).title,state.chats.find((c:any)=>c.id===fresh).title];
  const comment=await done(await call('handoverPush',{chatId:fresh}));
  const reply=await done(await call('handoverPush',{chatId:old}));
  await call('handoverClose',{chatId:fresh});state=await call('state');
  const closed=state.chats.find((c:any)=>c.id===old);assert.equal(closed.handover,undefined);assert.equal(closed.pinned,false);
  console.log(`PASS ${label} (${model}): ${titles.join(' -> ')}`);
  console.log('  check: '+JSON.stringify(check));
  console.log('  handover: '+excerpt(handover.text));
  console.log('  restatement: '+excerpt(first.text));
  console.log('  old chat comment: '+excerpt(comment.text));
  console.log('  new chat after the comment: '+excerpt(reply.text));
 };
 await run('Opus 5.5',opus.id);
 if(astra)await run('Astra',astra);else console.log('SKIP Astra: Ghidorah Dev has no ChatGPT connection. Connect it in Dev, Settings, Connections, then run again.');
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
