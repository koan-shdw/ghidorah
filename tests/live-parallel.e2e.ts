import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.env.TRISMEGISTUS_LIVE_PARALLEL!=='1'||!process.env.TRISMEGISTUS_EXE||process.env.TRISMEGISTUS_TEST_DATA)throw Error('Explicit live packaged parallel check required in the canonical account home.');
const data=await fs.mkdtemp(path.resolve('work/live-parallel-')),folder=path.join(data,'files');await fs.mkdir(folder);
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[],timeout:30000});let chatId:string|undefined;
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const end=Date.now()+240000;const ready=async()=>{while(Date.now()<end){const s=await call('state');if(s.backend==='ready'&&s.claude?.models?.length&&s.codex?.models?.length)return s;await page.waitForTimeout(150);}throw Error('Connection check timed out.');};
 let state=await ready();assert.ok(!state.turns.some((t:any)=>['running','waiting','queued','dispatching','stopping'].includes(t.status)),'User work is active.');assert.ok(state.defaultFolder,'The working root must already be configured.');assert.equal(state.jev.connected,false);
 const native=state.claude.models.find((m:any)=>m.id==='claude-code:haiku')||state.claude.models.find((m:any)=>m.id==='claude-code:claude-haiku-4-5');assert.ok(native);
 const models=['deepseek-flash','gpt-6-luna',native.id],files=Object.fromEntries(models.map((model,index)=>[model,path.join(folder,['deepseek.txt','gpt.txt','claude.txt'][index])])),marker='parallel-'+crypto.randomUUID();
 assert.ok(models.every(model=>state.availableModels.includes(model)),'All three accounts must be available.');
 chatId=await call('addProject');for(const model of models){await call('addModel',{chatId,model});await call('effort',{chatId,model,effort:model==='deepseek-flash'?'none':'low'});}
 const id=crypto.randomUUID();await call('submit',{id,chatId,models,text:'Parallel check. Use parallel_work to publish a note containing '+marker+' and your model name. Claim only the file assigned to your model below, then create it with exactly '+marker+'. Use only collaboration, file and tool-discovery tools. Preserve existing files. Return the marker when finished. Assignments: '+JSON.stringify(files)});
 let finished=false,denied=0;
 while(Date.now()<end){
  state=await call('state');const parent=state.turns.find((t:any)=>t.id===id),jobs=parent?.jobs||[];
  for(const a of state.approvals.filter((a:any)=>jobs.includes(a.turnId)&&a.status==='pending')){
   const turn=state.turns.find((t:any)=>t.id===a.turnId),tool=state.tools.filter((t:any)=>t.turnId===turn.id&&t.status==='running').at(-1);
   let name=tool?.name,args=tool?.args;try{if(typeof args==='string')args=JSON.parse(args);}catch{}
   // Hermes asks permission before publishing tool-start. Match the exact approval payload.
   const description=a.params?.description;if(typeof description==='string'&&description.startsWith('write_file: ')){name='write_file';try{args=JSON.parse(description.slice('write_file: '.length));}catch{args=null;}}
   const target=args?.file_path||args?.path,content=args?.content;
   const allowed=['Write','write_file'].includes(name)&&typeof target==='string'&&path.resolve(state.defaultFolder,target).toLowerCase()===files[turn.model].toLowerCase()&&typeof content==='string'&&content.trim()===marker;
   if(!allowed)denied++;await call('approve',{id:a.id,choice:allowed?'once':'deny'});
  }
  if(parent&&['completed','partial','failed','interrupted','stopped','needs-model'].includes(parent.status)){finished=true;assert.equal(parent.status,'completed',parent.error);break;}
  await page.waitForTimeout(150);
 }
 assert.ok(finished,'Live parallel work timed out.');const parent=state.turns.find((t:any)=>t.id===id),jobs=parent.jobs.map((id:string)=>state.turns.find((t:any)=>t.id===id));assert.equal(jobs.length,3);
 for(const job of jobs){assert.equal(job.status,'completed',job.error);assert.ok(job.text.includes(marker));assert.equal((await fs.readFile(files[job.model],'utf8')).trim(),marker);assert.ok(state.tools.some((t:any)=>t.turnId===job.id&&t.name.includes('parallel_work')&&JSON.stringify(t.result).includes(marker)),'No confirmed board outcome for '+job.model);}
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({chatId,turnId:id,denied,results:jobs.map((job:any)=>({model:job.model,status:job.status,board:true,file:files[job.model]}))},null,2));console.log('PASS real DeepSeek, GPT Luna and native Claude: shared board, distinct claimed files, approvals and parallel results\nEvidence: '+data);
}finally{if(chatId)await (await instance.firstWindow()).evaluate(chatId=>window.desktop.invoke('stop',{chatId}),chatId).catch(()=>{});await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
