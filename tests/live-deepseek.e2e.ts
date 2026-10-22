// Explicitly requested live smoke test. Uses the saved Windows credential; makes paid model calls.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend} from '../app/backend';
if(process.env.TRISMEGISTUS_LIVE_TEST!=='1')throw Error('Set TRISMEGISTUS_LIVE_TEST=1 only for an authorized live test');
const root=path.resolve('.'),stamp=Date.now(),data=path.join(root,'work','live-deepseek-'+stamp),folder=path.join(root,'work','live-project-'+stamp);
await fs.mkdir(folder,{recursive:true});
const saved=new Backend(root,data,'Trismegistus',()=>{});
const temporary=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
const credential=await saved.host('read_key');assert.ok(credential.key,'No saved credential');
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
env.TRISMEGISTUS_TEST_DATA=data;delete env.TRISMEGISTUS_TEST_PROVIDER_URL;
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env});
try{
 const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(fn:(s:any)=>boolean,label:string)=>{const until=Date.now()+120000;while(Date.now()<until){const s=await call('state');if(fn(s))return s;const failed=s.turns.find((t:any)=>['failed','interrupted'].includes(t.status));if(failed)throw Error(label+': '+failed.error);await page.waitForTimeout(100);}throw Error(label+' timed out');};
 await wait(s=>s.backend==='ready','startup');await call('saveKey',{key:credential.key});credential.key=null;
 await wait(s=>s.providerStatus==='Connected','free account check');console.log('PASS live free account check');
 const chatId=await call('addProject',{folder});await call('effort',{chatId,effort:'none'});
 const reply=crypto.randomUUID();await call('submit',{id:reply,chatId,text:'Reply exactly: DeepSeek is connected.',selected:true});
 const response=await wait(s=>s.turns.find((t:any)=>t.id===reply)?.status==='completed','live reply');
 assert.match(response.turns.find((t:any)=>t.id===reply).text,/DeepSeek is connected/i);console.log('PASS live DeepSeek streaming reply');
 const write=crypto.randomUUID();await call('submit',{id:write,chatId,text:'Use write_file to create live-check.txt in the current project folder containing exactly live-ok. Then reply done. Do not use terminal or any other tool.',selected:true});
 const approvalState=await wait(s=>s.approvals.some((a:any)=>a.turnId===write&&a.status==='pending'),'live tool approval');
 const approval=approvalState.approvals.find((a:any)=>a.turnId===write&&a.status==='pending');
 assert.match(approval.params.command,/<write_file>/);
 await call('approve',{id:approval.id,choice:'once'});await wait(s=>s.turns.find((t:any)=>t.id===write)?.status==='completed','live tool result');
 assert.equal((await fs.readFile(path.join(folder,'live-check.txt'),'utf8')).trim(),'live-ok');console.log('PASS live tool request, approval and file result');
 const stop=crypto.randomUUID();await call('submit',{id:stop,chatId,text:'Write a long numbered list from 1 to 1000 with one sentence describing each number. Use no tools.',selected:true});
 await wait(s=>(s.turns.find((t:any)=>t.id===stop)?.text.length||0)>30,'live stream before Stop');await call('stop',{chatId});
 await wait(s=>s.turns.find((t:any)=>t.id===stop)?.status==='stopped','live Stop');console.log('PASS live streaming cancellation');
}finally{credential.key=null;await instance.evaluate(({app})=>app.quit());await instance.close();await temporary.host('delete_key');}
