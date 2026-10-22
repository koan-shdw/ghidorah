// Explicit owner-authorized check in the app's real credential home. No grant copies.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
if(process.env.TRISMEGISTUS_LIVE_GPT!=='1')throw Error('Set TRISMEGISTUS_LIVE_GPT=1 for the authorized live account check.');
if(process.env.TRISMEGISTUS_TEST_DATA)throw Error('This check uses the canonical credential home.');
const root=path.resolve('.');
const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
const instance=await electron.launch({args:[root],env,timeout:30000});
try{
  const page=await instance.firstWindow();
  const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
  const wait=async(predicate:(state:any)=>boolean)=>{const end=Date.now()+150000;while(Date.now()<end){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(150);}throw Error('Live account check timed out');};
  let state=await wait(state=>state.backend==='ready'&&state.codex?.models?.length);
  const model=state.codex.models.find((id:string)=>id==='gpt-6-luna')||state.codex.models[0];
  const chatId=await call('addProject');await call('addModel',{chatId,model});await call('effort',{chatId,model,effort:'low'});
  const send=async(text:string)=>{await call('modelSelection',{chatId,model,selected:true});const id=crypto.randomUUID();await call('submit',{id,chatId,text});return id;};
  const done=async(id:string)=>{
    const state=await wait(state=>state.turns.some((turn:any)=>turn.id===id&&['completed','failed','interrupted','stopped'].includes(turn.status)));
    const turn=state.turns.find((turn:any)=>turn.id===id);assert.equal(turn.status,'completed',turn.error);return turn;
  };
  const first=await send('Connection check: remember the word copperfinch. Reply exactly READY. Do not use tools.');
  assert.match((await done(first)).text,/READY/);console.log('PASS real ChatGPT subscription reply through app and Hermes: '+model);
  const second=await send('What word did I ask you to remember? Reply only that word. Do not use tools.');
  assert.match((await done(second)).text,/copperfinch/i);console.log('PASS real GPT conversation history');
  state=await call('state');assert.ok(state.defaultFolder,'Select a root working folder before the live tool check.');
  const relative='trismegistus-check-'+Date.now()+'.txt',target=path.join(state.defaultFolder,relative);
  const write=await send(`Use write_file to create ${relative} in the current working folder containing exactly gpt-live-ok. Do not use terminal or other tools. Then reply done.`);
  state=await wait(state=>state.approvals.some((approval:any)=>approval.turnId===write&&approval.status==='pending')||state.turns.some((turn:any)=>turn.id===write&&['completed','failed','interrupted'].includes(turn.status)));
  const approval=state.approvals.find((approval:any)=>approval.turnId===write&&approval.status==='pending');assert.ok(approval,'Expected a file approval');assert.match(JSON.stringify(approval.params),/write_file/);assert.ok(JSON.stringify(approval.params).includes(relative));
  await call('approve',{id:approval.id,choice:'once'});await done(write);assert.equal((await fs.readFile(target,'utf8')).trim(),'gpt-live-ok');
  console.log('PASS real GPT tool request, app approval and verified file: '+target);
  const slow=await send('Write a numbered list of 500 short sentences about sorting algorithms. Use no tools.');
  await wait(state=>state.turns.find((turn:any)=>turn.id===slow)?.text.length>40);await call('stop',{chatId});
  await wait(state=>state.turns.find((turn:any)=>turn.id===slow)?.status==='stopped');console.log('PASS cancellation during real GPT streaming');
}finally{await instance.evaluate(({app})=>app.quit());await instance.close();}
