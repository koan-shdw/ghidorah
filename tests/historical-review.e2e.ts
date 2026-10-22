import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {Store} from '../app/store';
import {WorkCoordination} from '../app/work-coordination';
import {launchPackaged} from './fixtures/launch-packaged';
import {pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/historical-review-')),oldFolder=path.join(data,'old-repository'),folder=await fs.mkdtemp(path.join(root,'work/historical-review-files-'));await fs.mkdir(oldFolder);
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const db=new Store(path.join(data,'chat.sqlite')),project=db.project(folder),oldChat=db.chat(project.id),turn=db.accept('historical',oldChat.id,'Old build');db.put('settings',{id:'working-folder',folder});db.update<any>('turn',turn.id,{status:'interrupted'});
const work=new WorkCoordination(db),hold=await work.begin(turn.id,turn.id,oldFolder,'terminal',{command:'node scripts/build.mjs && node --import tsx tests/repo-map-app.e2e.ts'},new AbortController().signal);work.interrupt(turn.id);db.db.close();
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};let app=await launchPackaged(env);console.log('Historical review evidence: '+data);
try{
 for(let restart=0;restart<2;restart++){
  if(restart){await app.close();app=await launchPackaged(env);}
  const page=app.page,call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
  await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);await call('wizardFinish');
  for(const model of ['deepseek-flash','claude-code:haiku']){
   const chatId=await call('newChat');await call('addModel',{chatId,model});const p=(await call('state')).chats.find((c:any)=>c.id===chatId).projectId;await call('mode',{projectId:p,mode:'bypass'});
   const target=path.join(folder,model.startsWith('claude')?'native-'+restart+'.txt':'slice-result.txt');if(restart&&model==='deepseek-flash')await fs.unlink(target);
   const text=model.startsWith('claude')?JSON.stringify({action:'write',path:target,content:'Native independent work'}):'WRITE_FIXTURE',id=crypto.randomUUID();
   await call('submit',{id,chatId,text,models:[model]});const state=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed','interrupted','stopped'].includes(t.status)));
   assert.equal(state.turns.find(t=>t.id===id)!.status,'completed');assert.ok((await fs.readFile(target,'utf8')).length>0,'Independent write must actually happen');assert.ok(state.workReview?.some(a=>a.id===hold&&a.status==='uncertain'),'Historical uncertainty must remain visible');assert.equal(state.approvals.filter(a=>a.turnId===id&&a.status==='pending').length,0);
  }
 }
 const result={packaged:true,bothEngines:true,independentWrites:true,restart:true,originalHoldRetained:true,bypass:true};await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(result,null,2));console.log('PASS '+JSON.stringify(result));
}finally{await app.close();fake.stdin.end();lines.close();await host.host('delete_key');}
