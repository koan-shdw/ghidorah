import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Store} from '../app/store';
import {WorkCoordination,diagnosticCommand,commandParts} from '../app/work-coordination';
import {createParallel} from '../app/parallel';
import {spawnSync} from 'node:child_process';
import type {Turn} from '../app/types';
import {backgroundProcess,BackgroundWork,type BackgroundProcess} from '../app/background-work';
import {NativeSessions} from '../app/native-sessions';

test('late completion uses the original owner and interrupted writes keep real results',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-completion-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const lease=(await work.begin('turn','turn',directory,'terminal',{command:'build'},signal))!;
 store.update<any>('work-action',lease,{owner:{generation:'old-backend',sessionId:'old-session',chatId:'chat',profile:'profile'}});
 work.interrupt('turn');assert.equal(work.pending().length,1);
 assert.throws(()=>work.completionOwner(lease,'new-backend','old-session'),/original session/);
 assert.throws(()=>work.completionOwner(lease,'old-backend','new-session'),/original session/);
 const original=work.completionOwner(lease,'old-backend','old-session');assert.equal(original.job,'turn');
 await assert.rejects(work.finish(lease,'new-turn',{exit_code:0}),/another job/);
 await work.finish(lease,'turn',{exit_code:1,output:'Tests failed',error:null},true);
 assert.equal(work.pending().length,0);assert.equal(store.get<any>('work-action',lease).status,'failed');
 await work.finish(lease,'turn','duplicate');assert.equal(store.get<any>('work-action',lease).result.exit_code,1);
 const missing=(await work.begin('other','other',directory,'terminal',{command:'unknown write'},signal))!;work.interrupt('other');
 await work.finish(missing,'other',{output:'[Command interrupted]',exit_code:130,error:null},false);assert.equal(work.pending().length,1,'Cancellation with error:null is still an uncertain write');store.db.close();
});

test('safe diagnostics and inspected read-only commands survive another chat’s unresolved write',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-inspection-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const command={command:'generate map'};await work.inspectAction('old',directory,{tool:'terminal',arguments:command,summary:'Writes the generated map directory.',evidence:[],resources:[{kind:'path',value:path.join(directory,'.repo-map'),access:'write'}]});
 await work.begin('old','old',directory,'terminal',command,signal);work.interrupt('old');
 const check=await work.begin('new','new',directory,'terminal',{command:'git status --short && git branch --show-current'},signal);await work.finish(check,'new',{exit_code:0});
 const powershell=await work.begin('new','new',directory,'terminal',{command:'git status --short; git branch --show-current'},signal);await work.finish(powershell,'new',{exit_code:0});
 for(const command of ['git status --short > stolen.txt','git status --short; rm file','git status --short && touch bad','git status $(evil)','git branch --delete main'])await assert.rejects(work.begin('new','new',directory,'terminal',{command},signal),/uncertain outcome/);
 const inspect={command:'powershell.exe -NoProfile -Command Get-Process'};
 await work.inspectAction('new',directory,{tool:'terminal',arguments:inspect,summary:'Inspect process state without changing anything.',evidence:[],resources:[]});
 const read=await work.begin('new','new',directory,'terminal',inspect,signal);work.interrupt('new');assert.equal(store.get<any>('work-action',read!).status,'blocked');assert.equal(work.pending().length,1);
 const unrelated={command:'build another project'};await work.inspectAction('new',directory,{tool:'terminal',arguments:unrelated,summary:'Only writes another project folder.',evidence:[],resources:[{kind:'path',value:path.join(directory,'other'),access:'write'}]});
 const write=await work.begin('new','new',directory,'terminal',unrelated,signal);await work.finish(write,'new',{exit_code:0});assert.equal(work.pending().length,1);
 const appArgs={name:'A new app',register_only:true};await work.inspectAction('new',directory,{tool:'create_app',arguments:appArgs,summary:'An incorrect model assertion of no effects.',evidence:[],resources:[]});
 const app=await work.begin('new','new',directory,'create_app',appArgs,signal);assert.equal(store.get<any>('work-action',app!).access,'unknown','Built-in mutation scopes override model inspection');await work.finish(app,'new',{created:true});
 await assert.rejects(work.begin('new','new',directory,'terminal',command,signal),/uncertain outcome/);store.db.close();
});

test('restart consumes only matching durable completion receipts and never reruns commands',async()=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'tris-receipts-')),store=new Store(':memory:'),project=store.project(data),chat=store.chat(project.id),work=new WorkCoordination(store),signal=new AbortController().signal;
 const lease=(await work.begin('old','old',data,'terminal',{command:'build'},signal))!,owner={generation:'old',sessionId:'old-session',chatId:chat.id,profile:project.profile};store.update<any>('work-action',lease,{owner,toolId:'old:call'});store.put('tool',{id:'old:call',turnId:'old',name:'terminal',args:{command:'build'},status:'uncertain',result:null});work.interrupt();
 const directory=path.join(data,'hermes','profiles',project.profile,'desktop','work-results');await fs.mkdir(directory,{recursive:true});const file=path.join(directory,lease+'.json');
 const backend={dataRoot:data,generation:'new',scrubber:{value:(v:any)=>v}} as any,background=new BackgroundWork(store,backend,work,()=>{});
 await fs.writeFile(file,JSON.stringify({lease,session_id:'foreign',result:{exit_code:0},uncertain:false,refused:false}));await background.recoverReceipts();assert.equal(work.pending().length,1);
 await fs.writeFile(file,JSON.stringify({lease,session_id:owner.sessionId,result:{exit_code:0,output:'done'},uncertain:false,refused:false}));await background.recoverReceipts();assert.equal(work.pending().length,0);assert.equal(store.get<any>('work-action',lease).result.output,'done');await assert.rejects(fs.stat(file),{code:'ENOENT'});
 await background.recoverReceipts();assert.equal(store.all('work-action').length,1);assert.equal(store.get<any>('tool','old:call').status,'completed');assert.equal(store.get<any>('tool','old:call').result.output,'done');store.db.close();
});

test('a live preview allows an observed multi-file patch and retained chat jobs can be stopped',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-preview-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const site=path.join(directory,'site');await fs.mkdir(site);const files=['index.html','style.css','app.js'].map(name=>path.join(site,name));
 for(const file of files)await fs.writeFile(file,'old');
 const project=store.project(directory),chat=store.chat(project.id),foreign=store.chat(project.id);store.update<any>('project',project.id,{mode:'bypass'});
 const command={command:'python serve.py',background:true};
 await owner.inspectAction('launch',directory,{tool:'terminal',arguments:command,summary:'Static server observes the site and owns its loopback listener.',evidence:[],resources:[{kind:'path',value:site,access:'observe'},{kind:'port',value:'tcp:8795',access:'write'}]});
 const server=await owner.begin('launch','launch',directory,'terminal',command,signal);owner.holdBackground(server!,'launch',{session_id:'old-process'});
 for(const file of files){const read=await owner.begin('edit','edit',directory,'read_file',{path:file},signal);await owner.finish(read,'edit','old');}
 const args={mode:'patch',patch:files.map(file=>'*** Delete File: '+file).join('\n')};
 const lease=await owner.begin('edit','edit',directory,'patch',args,signal,files);assert.equal(store.get<any>('work-action',lease!).scope.length,3);
 await fs.writeFile(files[0],'changed externally');await assert.rejects(owner.checkApproval('edit','patch: '+JSON.stringify(args)),/patch target changed/);
 await owner.finish(lease,'edit','denied',false,true);
 const read=await owner.begin('edit','edit',directory,'read_file',{path:files[0]},signal);await owner.finish(read,'edit','changed externally');
 const retry=await owner.begin('edit','edit',directory,'patch',args,signal,files);for(const file of files)await fs.unlink(file);await owner.finish(retry,'edit',{success:true});
 assert.ok(store.get<any>('work-action',retry!).files.every((file:any)=>file.after===null));assert.equal(owner.pending().length,0);
 const row:BackgroundProcess={id:'retained-job',chatId:chat.id,turnId:'launch',actionId:server,generation:'owner',sessionId:'old-session',profile:project.profile,processId:'old-process',command:command.command,output:'preview',status:'running',created:1,updated:1};store.put('background',row);
 const stopped:string[]=[],stop=async(id:string)=>{stopped.push(id);await owner.finishBackground(server!,{status:'killed'},true);store.update<BackgroundProcess>('background',id,{status:'stopped'});};
 const list=await backgroundProcess(store,chat,{action:'list'},async()=>{},stop);assert.equal(list.processes[0].id,row.id);
 await assert.rejects(backgroundProcess(store,foreign,{action:'stop',id:row.id},async()=>{},stop),/unavailable in this chat/);assert.deepEqual(stopped,[]);
 store.update<any>('project',project.id,{mode:'plan'});await assert.rejects(backgroundProcess(store,chat,{action:'stop',id:row.id},async()=>{},stop),/Plan mode/);
 store.update<any>('project',project.id,{mode:'bypass'});
 const control=await owner.begin('new','new',directory,'background_process',{action:'stop',id:row.id},signal);
 await backgroundProcess(store,chat,{action:'stop',id:row.id},async()=>{},stop);await owner.finish(control,'new',{stopped:true});
 assert.deepEqual(stopped,[row.id]);assert.equal(owner.pending().length,0);
 store.update<any>('work-action',server!,{status:'uncertain'});assert.equal(new WorkCoordination(store).pending().length,0,'Repairs old confirmed Stop receipts');
 const writer=await owner.begin('writer','writer',directory,'terminal',{command:'unknown writer'},signal);owner.holdBackground(writer!,'writer',{});await owner.finishBackground(writer!,{status:'killed'},true);assert.equal(owner.pending().length,1);store.db.close();
});

test('lost observers recover only after their ports are free; writers retain review',async()=>{
 const store=new Store(':memory:'),owner=new WorkCoordination(store),listener=net.createServer();
 await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=(listener.address() as net.AddressInfo).port;
 const record={id:'preview',group:'old',job:'old',name:'terminal',args:{command:'python serve.py'},resource:'*',access:'unknown',signature:'old',before:null,status:'uncertain',scope:[{kind:'path',value:process.cwd(),access:'observe'},{kind:'port',value:'tcp:'+port,access:'write'}],result:{status:'lost',process_id:'old-process'}};
 store.put('work-action',record);store.put('background',{id:'job',actionId:record.id,status:'lost'});
 await owner.reconcileObservers();assert.equal(owner.pending().length,1,'An occupied port must keep its hold');
 await new Promise<void>(resolve=>listener.close(()=>resolve()));
 for(const [id,scope] of Object.entries({writer:[{kind:'path',value:process.cwd(),access:'write'}],unknown:undefined,udp:[{kind:'port',value:'udp:'+port,access:'write'}]})){store.put('work-action',{...record,id,scope});store.put('background',{id,actionId:id,status:'lost'});}
 await owner.reconcileObservers();assert.deepEqual(owner.pending().map(row=>row.id).sort(),['udp','unknown','writer']);assert.equal(store.get<any>('work-action',record.id).status,'inspected');store.db.close();
});

test('rejected patch validation releases the hold, preserves unchanged reads and repairs old holds',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-patch-rejection-')),file=path.join(directory,'plot.js'),store=new Store(':memory:'),signal=new AbortController().signal;
 try{
  await fs.writeFile(file,'original');let owner=new WorkCoordination(store);
  const read=await owner.begin('job','job',directory,'read_file',{path:file},signal);await owner.finish(read,'job','original');
  const args={mode:'patch',patch:'*** Begin Patch\n*** Delete File: '+file+'\n*** End Patch'};
  const rejected=(await owner.begin('job','job',directory,'patch',args,signal,[file]))!;
  const result=JSON.stringify({success:false,error:'Patch validation failed (no files were modified):\n  • hunk 1 not found',_warning:'Earlier read used pagination.'});
  await owner.finish(rejected,'job',result,true);
  assert.equal(owner.pending().length,0);assert.equal(store.get<any>('work-action',rejected).status,'failed');assert.equal(await fs.readFile(file,'utf8'),'original');
  const diagnostic=await owner.begin('other','other',directory,'terminal',{command:'check listening port'},signal);await owner.finish(diagnostic,'other',{exit_code:0});
  const retry=(await owner.begin('job','job',directory,'patch',args,signal,[file]))!;
  await fs.writeFile(file,'external change');await owner.finish(retry,'job',result,true);
  await assert.rejects(owner.begin('job','job',directory,'patch',args,signal,[file]),/changed or has not been read/);
  store.update<any>('work-action',rejected,{status:'uncertain'});
  const old=store.get<any>('work-action',rejected);
  for(const [id,change] of Object.entries({lost:{result:undefined},wrongTool:{name:'terminal'},wrongMode:{args:{mode:'replace'}},applyFailure:{result:{success:false,error:'Apply phase failed (state may be inconsistent — run `git diff` to assess):\n  • disk error'}}}))store.put('work-action',{...old,...change,id});
  owner=new WorkCoordination(store);
  assert.equal(store.get<any>('work-action',rejected).status,'failed');assert.equal(store.get<any>('work-action',rejected).result,result);
  assert.deepEqual(owner.pending().map(row=>row.id).sort(),['applyFailure','lost','wrongMode','wrongTool']);
 }finally{store.db.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('a confirmed stale-read refusal does not hold other work or authorize another overwrite',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-stale-refusal-')),file=path.join(directory,'map.html'),store=new Store(':memory:'),signal=new AbortController().signal;
 await fs.writeFile(file,'Keep the current file.');let owner=new WorkCoordination(store);
 const read=await owner.begin('group','job',directory,'read_file',{path:file,offset:1,limit:1},signal);await owner.finish(read,'job','partial contents');
 const write=await owner.begin('group','job',directory,'write_file',{path:file,content:'replacement'},signal);
 const result=JSON.stringify({error:'Refusing to overwrite: partial view. The file was NOT modified. Reload it.',stale_write_blocked:true,path:file,resolved_path:file});await owner.finish(write,'job',result,true);
 assert.equal(owner.pending().length,0);assert.equal(store.get<any>('work-action',write!).status,'blocked');assert.equal(await fs.readFile(file,'utf8'),'Keep the current file.');
 await assert.rejects(owner.begin('group','job',directory,'write_file',{path:file,content:'again'},signal),/has not been read/);
 const next=await owner.begin('other-chat','other',directory,'terminal',{command:'git status'},signal);await owner.finish(next,'other',{exit_code:0});
 // The exact old envelope is also repairable after restart; different targets,
 // tools, missing results and ordinary disk errors are not definite refusals.
 const old=store.get<any>('work-action',write!);store.update<any>('work-action',write!,{status:'uncertain'});owner=new WorkCoordination(store);assert.equal(owner.pending().length,0);
 for(const [id,change] of Object.entries({lost:{result:undefined},wrongTool:{name:'terminal'},wrongTarget:{resource:path.join(directory,'other.txt')},io:{result:JSON.stringify({error:'Disk write failed',stale_write_blocked:false})}}))store.put('work-action',{...old,...change,id,status:'uncertain'});
 owner=new WorkCoordination(store);assert.deepEqual(owner.pending().map(row=>row.id).sort(),['io','lost','wrongTarget','wrongTool']);store.db.close();
});

test('restart clears only proven app-path refusals and preserves unconfirmed mutations',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-app-refusal-')),store=new Store(':memory:');
 const refused={id:'refused',group:'old',job:'old',name:'create_app',args:{name:'App',register_only:true,repositories:['I:\\DEV\\app']},resource:'*',access:'unknown',signature:'legacy',before:null,status:'uncertain',result:JSON.stringify({error:'Error: Choose a path inside the working folder.'})};
 store.put('work-action',refused);let owner=new WorkCoordination(store);
 assert.equal(owner.pending().length,0);assert.equal(store.get<any>('work-action','refused').status,'blocked');assert.equal(store.get<any>('work-action','refused').result,refused.result);
 const signal=new AbortController().signal,lease=await owner.begin('next','job',directory,'write_file',{path:'logo.svg',content:'logo'},signal);await fs.writeFile(path.join(directory,'logo.svg'),'logo');await owner.finish(lease,'job','written');
 for(const [id,change] of Object.entries({lost:{result:'No tool result received'},postWrite:{args:{name:'New app'}},otherTool:{name:'write_file'},otherError:{result:JSON.stringify({error:'Disk error after saving'})}}))store.put('work-action',{...refused,...change,id});
 owner=new WorkCoordination(store);assert.deepEqual(owner.pending().map(row=>row.id).sort(),['lost','otherError','otherTool','postWrite']);
 await assert.rejects(owner.begin('next','job',directory,'terminal',{command:'uninspected operation'},signal),error=>{assert.match(String(error),/earlier create_app action/);assert.match(String(error),/Work review ID lost/);assert.match(String(error),/did not run and did not create a new hold/);assert.doesNotMatch(String(error),/I:\\DEV|Disk error/);return true;});store.db.close();
});

test('a completed cleanup with a failing follow-up check does not block the next edit',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-cleanup-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 await fs.writeFile(path.join(directory,'temporary.png'),'temporary');
 const lease=await owner.begin('turn','native',directory,'Bash',{command:'remove temporary.png then check it'},signal);
 const command=spawnSync(process.execPath,['-e',"const fs=require('fs');fs.unlinkSync('temporary.png');fs.statSync('temporary.png')"],{cwd:directory,encoding:'utf8',windowsHide:true});
 assert.equal(command.status,1);assert.match(command.stderr,/ENOENT/);
 await owner.finish(lease,'native','Exit code 1\n'+command.stderr,true);
 assert.equal(owner.records('turn')[0].status,'failed');assert.equal(owner.pending().length,0);
 const edit=await owner.begin('next','hermes',directory,'write_file',{path:'icon.png',content:'replacement'},signal);await fs.writeFile(path.join(directory,'icon.png'),'replacement');await owner.finish(edit,'hermes','written');
 assert.equal(await fs.readFile(path.join(directory,'icon.png'),'utf8'),'replacement');store.db.close();
});

test('foreground and background process failures settle; lost, timed-out and external actions still need inspection',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-exit-')),signal=new AbortController().signal;
 for(const [name,result,expected] of [
  ['Bash','Exit code 2\nls: file does not exist','failed'],
  ['terminal',JSON.stringify({exit_code:1,output:'test failed',error:null}),'failed'],
  ['terminal',{exit_code:2,status:'exited',completion_reason:'exited'},'failed'],
  ['terminal',{exit_code:0,status:'exited',completion_reason:'lost'},'uncertain'],
  ['terminal',{exit_code:124,error:'Command timed out'},'uncertain'],
  ['Bash','Exit code 130\nInterrupted','uncertain'],
  ['Bash','The tool did not return a confirmed result.','uncertain'],
  ['external_publish',{exit_code:2},'uncertain'],
 ] as const){
  const store=new Store(':memory:'),owner=new WorkCoordination(store),lease=await owner.begin('group','job',directory,name,{command:'build'},signal);
  if(typeof result==='object'&&'status' in result){owner.holdBackground(lease!,'job',{session_id:'process'});await owner.finishBackground(lease!,result,true);}else await owner.finish(lease,'job',result,true);
  assert.equal(owner.records('group')[0].status,expected,JSON.stringify(result));assert.equal(owner.pending().length,expected==='uncertain'?1:0);store.db.close();
 }
});

test('restart repairs old process-exit holds without releasing lost actions or replaying commands',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-exit-migration-')),db=path.join(directory,'state.sqlite'),signal=new AbortController().signal;
 let store=new Store(db),owner=new WorkCoordination(store);
 const settled=await owner.begin('group','job',directory,'Bash',{command:'rm temporary.png && ls temporary.png'},signal);await owner.finish(settled,'job','Exit code 2\nls: file does not exist',true);
 // An old build stored this definite exit as uncertain.
 store.update<any>('work-action',settled!,{status:'uncertain'});
 const record=store.get<any>('work-action',settled!);store.put('work-action',{...record,id:'lost',result:'The tool did not return a confirmed result.'});store.db.close();
 store=new Store(db);owner=new WorkCoordination(store);
 assert.equal(store.get<any>('work-action',settled!).status,'failed');assert.equal(store.get<any>('work-action',settled!).result,record.result);assert.deepEqual(owner.pending().map(row=>row.id),['lost']);
 await assert.rejects(owner.begin('next','other',directory,'Bash',record.args,signal),/uncertain outcome/);store.db.close();
});

test('old unscoped outcomes permit current file baselines and inspected work, but never blind repeats or known conflicts',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-historical-')),store=new Store(':memory:'),signal=new AbortController().signal;let owner=new WorkCoordination(store);
 const command={command:'node scripts/build.mjs && node --import tsx tests/repo-map-app.e2e.ts'},old=await owner.begin('old','old',directory,'terminal',command,signal);owner.interrupt('old');owner=new WorkCoordination(store);
 await assert.rejects(owner.begin('new','new',directory,'terminal',{command:'uninspected build'},signal),/uncertain outcome/);
 await owner.inspectAction('new',directory,{tool:'terminal',arguments:command,summary:'The same command now declares a path.',evidence:[],resources:[{kind:'path',value:'.',access:'write'}]});
 await assert.rejects(owner.begin('new','new',directory,'terminal',command,signal),/uncertain outcome/,'Adding scope must not hide an exact repeat');
 await owner.inspectAction('new',directory,{tool:'terminal',arguments:command,summary:'Claiming no writes is not a completion receipt.',evidence:[],resources:[]});await assert.rejects(owner.begin('new','new',directory,'terminal',command,signal),/uncertain outcome/);
 const target=path.join(directory,'current.txt');await fs.writeFile(target,'User changes');
 await assert.rejects(owner.begin('new','new',directory,'Write',{file_path:target,content:'Replacement'},signal),/has not been read/);
 const read=await owner.begin('new','new',directory,'Read',{file_path:target},signal);await owner.finish(read,'new','User changes');
 const write=await owner.begin('new','new',directory,'Write',{file_path:target,content:'Reconciled'},signal);await fs.writeFile(target,'Reconciled');await owner.finish(write,'new','done');
 const next={command:'build another project'};await owner.inspectAction('new',directory,{tool:'terminal',arguments:next,summary:'Inspected independent output and service.',evidence:[],resources:[{kind:'path',value:'other',access:'write'},{kind:'port',value:'tcp:12345',access:'write'}]});
 const independent=await owner.begin('new','new',directory,'terminal',next,signal);owner.interrupt('new');
 assert.equal(store.get<any>('work-action',old!).status,'uncertain');assert.equal(store.get<any>('work-action',old!).result,undefined);
 await assert.rejects(owner.begin('later','later',directory,'Write',{file_path:'other/output.txt',content:'collision'},signal),/uncertain outcome/);
 const port={command:'start listener'};await owner.inspectAction('later',directory,{tool:'terminal',arguments:port,summary:'Claims the same unresolved TCP listener.',evidence:[],resources:[{kind:'port',value:'tcp:12345',access:'write'}]});await assert.rejects(owner.begin('later','later',directory,'terminal',port,signal),/uncertain outcome/);
 assert.equal(owner.pending().length,2);assert.ok(independent);store.db.close();
});

test('both engines receive current review state rather than only historical warnings',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-review-context-')),store=new Store(':memory:'),work=new WorkCoordination(store),chat=store.chat(store.project().id),background=new BackgroundWork(store,{} as any,work,()=>{});
 assert.doesNotMatch(background.context(chat),/Work review/);assert.match(background.context(chat),/never call inspect_action/);
 const id=await work.begin('old','old',directory,'terminal',{command:'unknown'},new AbortController().signal);work.interrupt('old');assert.doesNotMatch(background.context(chat),/Work review/);
 work.inspect(id!,'Inspected in this disposable fixture.');assert.doesNotMatch(background.context(chat),/Work review/);assert.match(background.context(chat),/never call inspect_action/);store.db.close();
});

test('identical commands in different working directories have distinct execution and inspection identities',async()=>{
 const root=await fs.mkdtemp(path.resolve('work','command-cwd-')),a=path.join(root,'one'),b=path.join(root,'two');await fs.mkdir(a);await fs.mkdir(b);
 const store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal,args={command:'npm test'};
 await owner.inspectAction('job',a,{tool:'Bash',arguments:args,summary:'Tests in the first checkout write only to its local output.',evidence:[],resources:[{kind:'path',value:'.',access:'write'}]});
 const first=await owner.begin('group','job',a,'Bash',args,signal);await owner.finish(first,'job','one result');
 const moved=await owner.begin('group','job',b,'Bash',args,signal);assert.equal(store.all<any>('work-action').find(row=>row.id===moved).scope,undefined);await owner.finish(moved,'job','two result',false,true);
 const second=await owner.begin('group','other',b,'Bash',args,signal);assert.ok(second);assert.equal(store.all<any>('work-action').find(row=>row.id===second).scope,undefined);await owner.finish(second,'other','two result');
 await assert.rejects(owner.begin('group','third',a,'Bash',args,signal),/already completed/);store.db.close();
});

test('cross-engine file leases preserve intervening edits and allow independent targets',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const file=path.join(directory,'shared.txt');await fs.writeFile(file,'user content');
 const read=await owner.begin('group','hermes',directory,'read_file',{path:'shared.txt'},signal);await owner.finish(read,'hermes','user content');
 const nativeRead=await owner.begin('group','native',directory,'Read',{file_path:file},signal);await owner.finish(nativeRead,'native','user content');
 await fs.writeFile(file,'user changed this');
 await assert.rejects(owner.begin('group','hermes',directory,'write_file',{path:'shared.txt',content:'old'},signal),/changed/);
 await assert.rejects(owner.begin('group','native',directory,'Write',{file_path:file,content:'old'},signal),/changed/);assert.equal(await fs.readFile(file,'utf8'),'user changed this');
 const fresh=await owner.begin('group','native',directory,'Read',{file_path:file},signal);await owner.finish(fresh,'native','user changed this');
 const edit=await owner.begin('group','native',directory,'Write',{file_path:file,content:'reconciled'},signal);
 const independent=await owner.begin('group','hermes',directory,'write_file',{path:'independent.txt',content:'independent'},signal);assert.ok(independent);
 await fs.writeFile(file,'user changed this\nreconciled');await owner.finish(edit,'native','done');await owner.finish(independent,'hermes','done');
 await assert.rejects(owner.begin('group','native',directory,'Write',{file_path:file,content:'unread next edit'},signal),/changed or has not been read/);
 await assert.rejects(owner.begin('group','hermes',directory,'patch',{path:'shared.txt',old_string:'user content',new_string:'old'},signal),/changed/);
 assert.equal(await fs.readFile(file,'utf8'),'user changed this\nreconciled');store.db.close();
});

test('a stable fresh read reconciles a known file after an interrupted write',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const file=path.join(directory,'result.txt'),action=await owner.begin('group','a',directory,'Write',{file_path:file,content:'partial'},signal);
 await fs.writeFile(file,'partial');owner.interrupt('a');
 await assert.rejects(owner.begin('group','b',directory,'Write',{file_path:file,content:'replacement'},signal),/uncertain outcome/);
 const read=await owner.begin('group','b',directory,'Read',{file_path:file},signal);await owner.finish(read,'b','partial');
 assert.equal(owner.records('group').find(row=>row.id===action)?.status,'inspected');
 const edit=await owner.begin('group','b',directory,'Write',{file_path:file,content:'partial\nreconciled'},signal);await fs.writeFile(file,'partial\nreconciled');await owner.finish(edit,'b','done');store.db.close();
});

test('verified own writes and edits remain current without hiding outside changes',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-own-edit-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal,file=path.join(directory,'app.txt');
 for(const [name,args,content] of [
  ['Write',{file_path:file,content:'first\nvalue\n'},'first\nvalue\n'],
  ['Edit',{file_path:file,old_string:'first',new_string:'second'},'second\nvalue\n'],
  ['patch',{path:file,old_string:'value',new_string:'updated'},'second\nupdated\n'],
  ['write_file',{path:file,content:'final\n'},'final\n'],
 ] as const){const action=await owner.begin('group','job',directory,name,args,signal);await fs.writeFile(file,content);await owner.finish(action,'job','written');}
 await owner.inspectAction('job',directory,{tool:'Bash',arguments:{command:'build'},summary:'Build the verified script just written by this job.',evidence:[file],resources:[]});
 await fs.writeFile(file,'outside change');await assert.rejects(owner.begin('group','job',directory,'Edit',{file_path:file,old_string:'final',new_string:'oops'},signal),/changed/);
 const fresh=await owner.begin('group','job',directory,'Read',{file_path:file},signal);await owner.finish(fresh,'job','outside change');
 const own=await owner.begin('group','job',directory,'Write',{file_path:file,content:'expected'},signal);await fs.writeFile(file,'expected plus outside change');await owner.finish(own,'job','written');
 await assert.rejects(owner.begin('group','job',directory,'Write',{file_path:file,content:'overwrite'},signal),/has not been read/);assert.equal(await fs.readFile(file,'utf8'),'expected plus outside change');store.db.close();
});

test('a read of a missing file does not poison a subsequent creation',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const read=await owner.begin('group','a',directory,'read_file',{path:'new.txt'},signal);await owner.finish(read,'a',{error:'File not found'},true);
 const write=await owner.begin('group','a',directory,'write_file',{path:'new.txt',content:'new'},signal);assert.ok(write);await fs.writeFile(path.join(directory,'new.txt'),'new');await owner.finish(write,'a','done');store.db.close();
});

test('inspection distinguishes malformed evidence from unread files and preserves source checks',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-inspection-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const file=path.join(directory,'verify (local).mjs');await fs.writeFile(file,'console.log("ok");');
 const args={tool:'Bash',arguments:{command:'node verify.mjs'},summary:'Run the local verification script.',evidence:[file],resources:[{kind:'path',value:directory,access:'read'}]};
 for(const evidence of [[file+' (read in full)'],[file+', other.mjs'],[directory],['missing.mjs']])await assert.rejects(owner.inspectAction('job',directory,{...args,evidence}),/not an existing file.*one exact file path/s);
 assert.equal(store.all('work-inspection').length,0);
 await assert.rejects(owner.inspectAction('job',directory,args),/Read the current file with Read\/read_file/);
 const read=await owner.begin('group','job',directory,'Read',{file_path:file},signal);await owner.finish(read,'job','console.log("ok");');
 assert.equal((await owner.inspectAction('job',directory,args)).recorded,true);
 const run=await owner.begin('group','job',directory,'Bash',args.arguments,signal);await owner.finish(run,'job','ok');
 await fs.writeFile(file,'console.log("changed");');
 await assert.rejects(owner.begin('group','job',directory,'Bash',args.arguments,signal),/Inspected command source changed/);
 await assert.rejects(owner.inspectAction('job',directory,args),/Read the current file/);
 assert.equal(owner.pending().length,0);store.db.close();
});

test('a failed read of an existing file cannot authorize a write',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 await fs.writeFile(path.join(directory,'existing.txt'),'retain this');
 const read=await owner.begin('group','a',directory,'read_file',{path:'existing.txt'},signal);await owner.finish(read,'a',{error:'Read denied'},true);
 await assert.rejects(owner.begin('group','a',directory,'write_file',{path:'existing.txt',content:'replacement'},signal),/has not been read/);store.db.close();
});

test('opaque actions coordinate, cancellation releases waiters and uncertainty survives restart',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),db=path.join(directory,'state.sqlite');let store=new Store(db),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const first=await owner.begin('group','a',directory,'terminal',{command:'external-action'},signal);
 const cancelled=new AbortController(),blocked=owner.begin('group','b',directory,'Write',{file_path:'new.txt',content:'b'},cancelled.signal);
 cancelled.abort();await assert.rejects(blocked);await owner.finish(first,'a',{effect:'done'});
 await assert.rejects(owner.begin('group','b',directory,'terminal',{command:'external-action'},signal),/already completed/);
 const uncertain=await owner.begin('group','a',directory,'terminal',{command:'unknown-outcome'},signal);assert.ok(uncertain);store.db.close();
 store=new Store(db);owner=new WorkCoordination(store);owner.interrupt();
 await assert.rejects(owner.begin('group','b',directory,'terminal',{command:'unknown-outcome'},signal),/uncertain outcome/);
 assert.equal(owner.records('group').find(row=>row.id===uncertain)?.status,'uncertain');store.db.close();
});

test('the shared board binds claims, findings and reviewer access to the owning group',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const chat=store.chat(store.project().id),parent=store.accept('group',chat.id,'Review this implementation');
 store.update<Turn>('turn',parent.id,{collaboration:{strategy:'review',lead:'a'}});const [a,b]=createParallel(store,parent,['a','b']);
 const claim:any=await owner.board(parent.id,a.id,directory,{operation:'claim',task:'implementation',path:'result.txt'});
 await assert.rejects(owner.board(parent.id,b.id,directory,{operation:'release',claim:claim.id}),/owning job/);
 await assert.rejects(owner.begin(parent.id,b.id,directory,'Write',{file_path:'other.txt',content:'no'},signal),/reviewing/);
 await owner.board(parent.id,b.id,directory,{operation:'note',text:'Review finding: retain user edits.'});
 assert.match(JSON.stringify(await owner.board(parent.id,a.id,directory,{operation:'status'})),/retain user edits/);
 await assert.rejects(owner.board(parent.id,'foreign',directory,{operation:'status'}),/does not belong/);
 owner.interrupt(a.id);assert.equal((await owner.board(parent.id,b.id,directory,{operation:'status'}) as any).claims[0].status,'released');store.db.close();
});

test('ordinary and parallel groups share ownership without exposing another chat',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const write=await owner.begin('ordinary','one',directory,'write_file',{path:'shared.txt',content:'private chat text'},signal);
 let settled=false;const collision=owner.begin('parallel','two',directory,'Write',{file_path:'shared.txt',content:'collision'},signal).finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,15));assert.equal(settled,false);
 await fs.writeFile(path.join(directory,'shared.txt'),'private chat text');await owner.finish(write,'one','private chat result');
 await assert.rejects(collision,error=>{assert.doesNotMatch(String(error),/private chat/);return /has not been read/.test(String(error));});
 owner.interrupt('one');const read=await owner.begin('parallel','two',directory,'Read',{file_path:'shared.txt'},signal);await owner.finish(read,'two','private chat text');
 const next=await owner.begin('parallel','two',directory,'Write',{file_path:'shared.txt',content:'reconciled'},signal);assert.ok(next);await owner.finish(next,'two','done');store.db.close();
});

test('overlapping duplicate commands are refused across chats; later intentional runs remain possible',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const first=await owner.begin('chat-one','one',directory,'terminal',{command:'publish'},signal);
 const second=owner.begin('chat-two','two',directory,'terminal',{command:'publish'},signal);
 await new Promise(resolve=>setTimeout(resolve,15));await owner.finish(first,'one','private result');
 await assert.rejects(second,error=>{assert.doesNotMatch(String(error),/private result/);return /Another chat completed/.test(String(error));});
 const later=await owner.begin('chat-three','three',directory,'terminal',{command:'publish'},signal);await owner.finish(later,'three','done');store.db.close();
});

test('uncertain outcomes survive chat boundaries without making an unscoped history record a global lease',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const file=await owner.begin('first','one',directory,'Write',{file_path:'result.txt',content:'maybe'},signal);owner.interrupt('one');
 await assert.rejects(owner.begin('next','two',directory,'Write',{file_path:'result.txt',content:'again'},signal),/uncertain outcome/);
 const read=await owner.begin('next','two',directory,'Read',{file_path:'result.txt'},signal);await owner.finish(read,'two',{error:'not found'},true);assert.equal(owner.records('first')[0].status,'inspected');
 const external=await owner.begin('next','two',directory,'terminal',{command:'external'},signal);owner.interrupt('two');
 const independent=await owner.begin('third','three',directory,'Write',{file_path:'other.txt',content:'value'},signal);await owner.finish(independent,'three','done');
 await assert.rejects(owner.begin('third','three',directory,'terminal',{command:'external'},signal),/Work review/);
 assert.equal(owner.pending().length,1,'The original missing result stays unresolved');
 assert.throws(()=>owner.inspect(external!,'ok'),/Describe/);owner.inspect(external!,'Checked the target: no operation occurred.');assert.equal(owner.pending().length,0);
 const final=await owner.begin('third','three',directory,'Write',{file_path:'other.txt',content:'value'},signal);await owner.finish(final,'three','done');store.db.close();
});

test('an explicit matching denial is recorded as blocked rather than an uncertain effect',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const args={command:'effect'},lease=await owner.begin('first','one',directory,'terminal',args,signal);
 owner.denied('foreign','terminal: '+JSON.stringify(args));assert.equal(owner.records('first')[0].status,'running');
 owner.denied('one','terminal: '+JSON.stringify(args));await owner.finish(lease,'one',{error:'denied'},true);assert.equal(owner.records('first')[0].status,'blocked');assert.equal(owner.pending().length,0);
 const later=await owner.begin('second','two',directory,'terminal',args,signal);await owner.finish(later,'two','done');store.db.close();
});

test('generic protected approval matches only one pending tool owned by the same job',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const one=await owner.begin('first','one',directory,'write_file',{path:'one.txt',content:'one'},signal),two=await owner.begin('first','one',directory,'write_file',{path:'two.txt',content:'two'},signal);
 await assert.rejects(owner.checkApproval('one','Protected credentials approval','<write_file> (plugin approval rule)'),/cannot identify a single/);
 owner.denied('one','Protected credentials approval','<write_file> (plugin approval rule)');assert.ok(owner.records('first').every(a=>a.status==='running'));
 await owner.finish(one,'one','done');owner.denied('one','Protected credentials approval','<write_file> (plugin approval rule)');assert.equal(owner.records('first').find(a=>a.id===two)?.status,'blocked');store.db.close();
});

test('approval rechecks the exact target after an intervening user edit',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const args={file_path:path.join(directory,'new.txt'),content:'model change'};await owner.begin('first','one',directory,'Write',args,signal);
 await fs.writeFile(args.file_path,'user change while waiting');await assert.rejects(owner.checkApproval('one','Write\n'+JSON.stringify(args)),/changed while approval/);
 owner.denied('one','Write\n'+JSON.stringify(args));assert.equal(await fs.readFile(args.file_path,'utf8'),'user change while waiting');assert.equal(owner.pending().length,0);store.db.close();
});

test('confirmed skill-batch rollbacks release holds; failed or unknown rollbacks remain held',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-work-')),store=new Store(':memory:'),owner=new WorkCoordination(store),signal=new AbortController().signal;
 const result={success:false,error:"operations[0] (create on 'test') failed: invalid description — batch aborted, all touched skills rolled back.",failed_index:0,completed_before_failure:0};
 const lease=await owner.begin('group','one',directory,'skill_manage',{operations:[{action:'create',name:'test'}]},signal);await owner.finish(lease,'one',JSON.stringify(result),true);assert.equal(owner.pending().length,0);assert.equal(owner.records('group')[0].status,'failed');
 store.update<any>('work-action',lease!,{status:'uncertain'});const restored=new WorkCoordination(store);assert.equal(restored.pending().length,0);assert.equal(restored.records('group')[0].status,'failed');
 for(const [name,body] of [['skill_manage',{...result,error:result.error.replace('all touched skills rolled back','ROLLBACK FAILED')}],['skill_manage',{error:result.error}],['external_tool',result]] as const){const id=await restored.begin('group','two',directory,name,{},signal);await restored.finish(id,'two',body,true);assert.equal(restored.pending().length,1);restored.inspect(id!,'Test fixture inspected: no real external mutation.');}
 store.db.close();
});

test('a background command that exited with a failure code is a known outcome, not an uncertain hold (Work review 623176b5)',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-exit-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const deploy=(await work.begin('turn','turn',directory,'Bash',{command:'node --check web/picker-live.js && npm --prefix desktop run build:web'},signal))!;
 work.holdBackground(deploy,'turn',{task_id:'b5k0l5bj7'});
 // Same call native-sessions makes when a Claude task ends with status "failed" (exit 1).
 const sessions:any=new NativeSessions(store,work,()=>{}),row:any={id:'rt:b5k0l5bj7',actionId:deploy,processId:'b5k0l5bj7',engine:'claude',status:'running'};store.put('background',row);
 await sessions.settle(row,'exited','The native task failed. Inspect its effects.',1);
 assert.equal(work.pending().length,0,'it ran to completion and its result is known');
 const lost=(await work.begin('turn2','turn2',directory,'Bash',{command:'unknown writer'},signal))!;
 work.holdBackground(lost,'turn2',{task_id:'lost'});
 await work.finishBackground(lost,{task_id:'lost',status:'lost',error:'The native worker ended. Inspect effects before continuing.'},true);
 assert.equal(work.pending().length,1,'a command cut off mid-run stays uncertain');
 store.db.close();
});

test('with autoResolve an uncertain earlier action settles itself instead of blocking (Work review 206c6c89)',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-auto-')),signal=new AbortController().signal;
 const rejected={id:'206c6c89',group:'old',job:'old',name:'Bash',args:{command:'cp web/picker-live.js desktop/out/web/live.js && node verify-video-hover.cjs'},resource:'*',access:'unknown',signature:'s1',status:'uncertain',result:"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."};
 const cutOff={id:'cut',group:'old',job:'old',name:'Bash',args:{command:'npm run build'},resource:'*',access:'unknown',signature:'s2',status:'uncertain'};
 // Without the switch: the old hold blocks, which is what Koan kept seeing.
 let store=new Store(':memory:');store.put('work-action',rejected);
 await assert.rejects(new WorkCoordination(store).begin('new','new',directory,'Bash',{command:'npm --prefix desktop run build:web'},signal),/uncertain outcome/);store.db.close();
 // With the switch: it settles from the facts and the new command runs.
 store=new Store(':memory:');store.put('work-action',rejected);store.put('work-action',cutOff);store.put('tool',{id:'old:t',turnId:'old',name:'Bash',args:{},result:null,status:'uncertain'});store.update<any>('work-action','cut',{toolId:'old:t'});
 const work=new WorkCoordination(store,()=>{},true);
 const lease=await work.begin('new','new',directory,'Bash',{command:'npm --prefix desktop run build:web'},signal);assert.ok(lease);await work.finish(lease,'new','Exit code 0');
 assert.equal(store.get<any>('work-action','206c6c89').status,'blocked','rejected = never ran');
 assert.equal(store.get<any>('work-action','cut').status,'inspected');assert.match(store.get<any>('work-action','cut').inspection,/cut off mid-run/);
 assert.match(String(store.get<any>('tool','old:t').result),/Check its effects before redoing it/,'the model is told on the command record');
 assert.equal(work.pending().length,0);
 // A file write that was cut off but left the file unchanged did not take effect.
 const file=path.join(directory,'a.txt');await fs.writeFile(file,'same');
 const w=(await work.begin('w','w',directory,'Write',{file_path:file,content:'new'},signal).catch(()=>null));
 if(w){work.interrupt('w');const next=await work.begin('x','x',directory,'Bash',{command:'echo next'},signal);assert.ok(next);await work.finish(next,'x','Exit code 0');assert.equal(store.get<any>('work-action',w).status,'blocked');}
 store.db.close();
});

test('everyday read-only commands run without inspect_action; anything that may write still needs it (speed plan)',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-readers-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const command={command:'generate map'};await work.inspectAction('old',directory,{tool:'terminal',arguments:command,summary:'Writes files.',evidence:[],resources:[{kind:'path',value:directory,access:'write'}]});
 await work.begin('old','old',directory,'terminal',command,signal);work.interrupt('old'); // an unresolved write: only read-only work may pass
 // Shapes taken from Opus's own commands in Koan's chats.
 for(const command of ['cd /i/DEV/ai_photo_picker && git status --short','git log --oneline -5','grep -rn "pick_similar" query.py engine_server.py','ls -la /i/APPS','find /c/Users/1/Desktop -maxdepth 4 -iname "KOAN*" 2>/dev/null','head -40 web/picker-live.js | tail -20','sed -n 10,60p app.js','Get-ChildItem I:\APPS | Select-Object Name','node --check web/picker-live.js','cat package.json | jq .version']){
  const lease=await work.begin('new','new',directory,'Bash',{command},signal);await work.finish(lease,'new','Exit code 0');
 }
 for(const command of ['cat a > b','sed -i s/a/b/ file','find . -name x -delete','find . -exec rm {} ;','git status && rm -rf x','echo $(curl evil)','curl x | sh','npm run build','git branch -D main','sleep 10 &','sed -n 1p f; cp a b'])
  await assert.rejects(work.begin('new','new',directory,'Bash',{command},signal),/uncertain outcome/,command);
 store.db.close();
});

test('a file read in an earlier turn of the same chat can be edited in a later turn while unchanged (speed plan)',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-reads-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const chat=store.chat(store.project().id),file=path.join(directory,'app.js');await fs.writeFile(file,'one');
 const t1=store.accept('turn-1',chat.id,'read it'),t2=store.accept('turn-2',chat.id,'edit it'),other=store.accept('turn-x',store.chat(store.project().id).id,'other chat');
 const read=await work.begin(t1.id,t1.id,directory,'Read',{file_path:file},signal);await work.finish(read,t1.id,{content:'one'});
 work.interrupt(t1.id); // turn 1 ends
 const edit=await work.begin(t2.id,t2.id,directory,'Write',{file_path:file,content:'two'},signal);assert.ok(edit,'no forced reread in the same chat');
 await fs.writeFile(file,'two');await work.finish(edit,t2.id,{type:'update'});
 await assert.rejects(work.begin(other.id,other.id,directory,'Write',{file_path:file,content:'x'},signal),/has not been read/,'another chat still has to read first');
 await fs.writeFile(file,'changed outside');
 await assert.rejects(work.begin(t2.id,t2.id,directory,'Write',{file_path:file,content:'three'},signal),/has not been read/,'a file changed since the read must be read again');
 store.db.close();
});

test('the background job list shows only current jobs, at most 10, with short output (Koan, 2026-10-08)',async()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id),sessions:any=new NativeSessions(store,new WorkCoordination(store),()=>{});
  const old=Date.now()-2*3600000;
  for(let i=0;i<15;i++)store.put('background',{id:'old'+i,engine:'claude',chatId:chat.id,turnId:'t',actionId:null,generation:'g',sessionId:'s',profile:'',processId:'p'+i,command:'old job '+i,status:'exited',output:'x'.repeat(4000),created:old,updated:old});
  store.put('background',{id:'live',engine:'claude',chatId:chat.id,turnId:'t',actionId:null,generation:'g',sessionId:'s',profile:'',processId:'live',command:'running job',status:'running',output:'y'.repeat(4000),created:Date.now(),updated:Date.now()});
  const text=sessions.context(chat);
  assert.match(text,/running job/);assert.doesNotMatch(text,/old job/);assert.ok(!text.includes('y'.repeat(1001)));
  store.db.close();
});

test('a multi-line Edit on a CRLF file keeps the read, as Claude Code writes CRLF (16 refusals on 2026-10-08)',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-crlf-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal,file=path.join(directory,'app.py');
 await fs.writeFile(file,'def a():\r\n    return 1\r\n\r\ndef b():\r\n    return 2\r\n');
 const read=(await work.begin('turn','turn',directory,'Read',{file_path:file},signal))!;await work.finish(read,'turn',{ok:true});
 // The model sends LF text; Claude Code matches it against CRLF and writes CRLF.
 const edit={file_path:file,old_string:'def a():\n    return 1',new_string:'def a():\n    return 10\n\n# note'};
 const lease=(await work.begin('turn','turn',directory,'Edit',edit,signal))!;
 await fs.writeFile(file,'def a():\r\n    return 10\r\n\r\n# note\r\n\r\ndef b():\r\n    return 2\r\n');await work.finish(lease,'turn',{ok:true});
 const next={file_path:file,old_string:'return 2',new_string:'return 20'};
 const second=(await work.begin('turn','turn',directory,'Edit',next,signal))!;assert.ok(second,'the next edit is not refused');
 await fs.writeFile(file,'def a():\r\n    return 10\r\n\r\n# note\r\n\r\ndef b():\r\n    return 20\r\n');await work.finish(second,'turn',{ok:true});
 assert.equal(store.get<any>('work-action',second).status,'completed');store.db.close();
});

test('a command waiting for Allow holds no lock; Allow takes it back (Koan 2026-10-15)',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-allow-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const later=(ms:number)=>new Promise(resolve=>setTimeout(()=>resolve('waiting'),ms));
 const command={command:'python build.py'},description='Bash\n'+JSON.stringify(command,null,2);
 const asked=(await work.begin('a','a',directory,'Bash',command,signal))!;
 work.ask('a',description);
 // Another chat's command runs at once while the first waits for Allow (it waited ten minutes before).
 const other=await Promise.race([work.begin('b','b',directory,'Bash',{command:'npm run build'},signal),later(200)]);
 assert.notEqual(other,'waiting','the other chat waits behind a question');
 // Allow waits for that command, says so, and then holds the lock again.
 let waited=false,allowedDone=false;const allowed=work.checkApproval('a',description,undefined,()=>{waited=true;}).then(()=>{allowedDone=true;});
 await later(50);assert.equal(waited,true);assert.equal(allowedDone,false);
 await work.finish(other as string,'b',{exit_code:0});await allowed;
 const third=work.begin('c','c',directory,'Bash',{command:'make'},signal);
 assert.equal(await Promise.race([third,later(100)]),'waiting','after Allow the command holds the lock');
 await work.finish(asked,'a',{exit_code:0});await work.finish((await third)!,'c',{exit_code:0});
 // Stop while Allow waits for another command cancels it; Deny releases a waiting command.
 const first=(await work.begin('d','d',directory,'Bash',command,signal))!;work.ask('d',description);
 const busy=(await work.begin('e','e',directory,'Bash',{command:'npm test'},signal))!;
 const stopped=work.checkApproval('d',description);await later(20);work.interrupt('d');
 await assert.rejects(stopped,/cancelled/);
 await work.finish(busy,'e',{exit_code:0});await work.finish(first,'d',{exit_code:0});
 await work.begin('f','f',directory,'Bash',command,signal);work.ask('f',description);work.denied('f',description);
 const free=await Promise.race([work.begin('g','g',directory,'Bash',{command:'npm run lint'},signal),later(200)]);
 assert.notEqual(free,'waiting');store.db.close();
});

// 10-19: job output in this list changed every few seconds and resent the whole fixed text with each of his messages.
test('the job list a model is given names each job and its status, never its output',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),background=new BackgroundWork(store,{} as any,new WorkCoordination(store),()=>{});
 store.put('background',{id:'job',engine:'hermes',chatId:chat.id,turnId:'t',command:'npm run build',status:'running',output:'compiling 1 of 900',created:Date.now(),updated:Date.now()});
 const text=background.context(chat);assert.match(text,/npm run build/);assert.match(text,/running/);assert.doesNotMatch(text,/compiling 1 of 900/);store.db.close();
});

test('batch 3: an unknown command locks only its own chat; a waiting approval releases its lock (Koan, 2026-10-08)',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-locks-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const project=store.project(directory),a=store.chat(project.id),b=store.chat(project.id),ta=store.accept(crypto.randomUUID(),a.id,'build'),tb=store.accept(crypto.randomUUID(),b.id,'read'),ta2=store.accept(crypto.randomUUID(),a.id,'more');
 const file=path.join(directory,'shared.txt');await fs.writeFile(file,'one\n');
 const settled=(promise:Promise<unknown>)=>Promise.race([promise.then(()=>true,()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),300))]);
 // 4a: chat A's unknown command does not hold chat B's read; it still holds chat A's next unknown command.
 const build=(await work.begin(ta.id,ta.id,directory,'Bash',{command:'npm test'},signal))!;
 assert.equal(await settled(work.begin(tb.id,tb.id,directory,'Read',{file_path:file},signal).then(id=>work.finish(id,tb.id,{ok:true}))),true,'another chat reads at once');
 const next=work.begin(ta2.id,ta2.id,directory,'Bash',{command:'npm run build'},signal);
 assert.equal(await settled(next),false,'the same chat waits');
 await work.finish(build,ta.id,{exit_code:0});await work.finish((await next)!,ta2.id,{exit_code:0});
 // 4b: a write waiting on approval no longer holds the file for other chats' reads (its turn keeps its edit claim),
 // and it is refused if the file changed meanwhile.
 const readA=(await work.begin(ta.id,ta.id,directory,'Read',{file_path:file},signal))!;await work.finish(readA,ta.id,{ok:true});
 const write={file_path:file,content:'from A\n'},waiting=(await work.begin(ta.id,ta.id,directory,'Write',write,signal))!;
 work.ask(ta.id,'Write\n'+JSON.stringify(write,null,2));
 const readB=work.begin(tb.id,tb.id,directory,'Read',{file_path:file},signal);
 assert.equal(await settled(readB),true,'chat B reads while chat A waits on its approval');await work.finish((await readB)!,tb.id,{ok:true});
 await fs.writeFile(file,'edited meanwhile\n');
 await assert.rejects(work.checkApproval(ta.id,'Write\n'+JSON.stringify(write,null,2)),/changed while approval was pending/);
 work.denied(ta.id,'Write\n'+JSON.stringify(write,null,2));assert.equal(store.get<any>('work-action',waiting).status,'blocked');
 store.db.close();
});

test('batch 3: chained readers with quoted pipes are reads; hidden writers are not',()=>{
 const read=(command:string)=>diagnosticCommand('Bash',{command});
 // The command refused on 2026-10-08 while a backgrounded grep held the lock.
 assert.equal(read(`wc -l backend/host.py && grep -n "app_summary\\|def _summary\\|web_research\\|def op_\\|elif operation\\|operation==\\|OPERATIONS\\|'cron_next'" backend/host.py | head -60`),true);
 assert.deepEqual(commandParts('grep "a|b" x | head'),['grep "a|b" x ',' head']);assert.equal(commandParts('echo "open'),null);
 for(const command of ['sort -o out.txt in.txt','git diff --output=patch.txt','Get-ChildItem | ForEach-Object { Remove-Item $_ }','Get-ChildItem x | ForEach-Object { $_.Delete() }'])assert.equal(read(command),false,command);
});

test('batch 3: web, skill and notebook tools; capped duplicates; MultiEdit keeps its read; restore resets one chat',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-known-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const project=store.project(directory),a=store.chat(project.id),b=store.chat(project.id),ta=store.accept(crypto.randomUUID(),a.id,'a'),tb=store.accept(crypto.randomUUID(),b.id,'b');
 for(const name of ['WebFetch','WebSearch','Skill'])assert.equal(await work.begin(ta.id,ta.id,directory,name,{url:'https://example.org'},signal),null,name);
 const book=path.join(directory,'book.ipynb');await fs.writeFile(book,'{}');
 const readBook=(await work.begin(ta.id,ta.id,directory,'Read',{file_path:book},signal))!;await work.finish(readBook,ta.id,{ok:true});
 const nb=(await work.begin(ta.id,ta.id,directory,'NotebookEdit',{notebook_path:book,new_source:'x'},signal))!;assert.equal(store.get<any>('work-action',nb).access,'write');await work.finish(nb,ta.id,{ok:true});
 // 4h: a refused duplicate quotes at most 4,000 characters of the first result.
 const parent=store.accept(crypto.randomUUID(),a.id,'group');store.update<any>('turn',parent.id,{jobs:['j1','j2']});
 const first=(await work.begin(parent.id,'j1',directory,'Bash',{command:'make data'},signal))!;await work.finish(first,'j1',{exit_code:0,output:'x'.repeat(50000)});
 await assert.rejects(work.begin(parent.id,'j2',directory,'Bash',{command:'make data'},signal),(error:any)=>error.message.length<4300&&/shortened/.test(error.message));
 // 4g: a multi-line MultiEdit on a CRLF file keeps the read.
 const file=path.join(directory,'app.py');await fs.writeFile(file,'a = 1\r\nb = 2\r\nc = 3\r\n');
 const read=(await work.begin(ta.id,ta.id,directory,'Read',{file_path:file},signal))!;await work.finish(read,ta.id,{ok:true});
 const edits={file_path:file,edits:[{old_string:'a = 1\nb = 2',new_string:'a = 10\nb = 20'},{old_string:'c = 3',new_string:'c = 30'}]};
 const multi=(await work.begin(ta.id,ta.id,directory,'MultiEdit',edits,signal))!;await fs.writeFile(file,'a = 10\r\nb = 20\r\nc = 30\r\n');await work.finish(multi,ta.id,{ok:true});
 const again=(await work.begin(ta.id,ta.id,directory,'Edit',{file_path:file,old_string:'c = 30',new_string:'c = 31'},signal))!;assert.ok(again,'the next edit is not refused');await work.finish(again,ta.id,{ok:true},false,true);
 // 4f: restoring chat A's checkpoint leaves chat B's running work held.
 const runningB=(await work.begin(tb.id,tb.id,directory,'Bash',{command:'npm start'},signal))!;
 work.interruptChats(new Set([a.id]));assert.equal(store.get<any>('work-action',runningB).status,'running');
 store.db.close();
});
