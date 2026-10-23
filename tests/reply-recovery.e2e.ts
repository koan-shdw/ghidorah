import {mainSource} from './fixtures/main-source';
// Drop a real Hermes completion at the client, then recover through its actual replay RPC.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {Backend,PYTHON} from '../app/backend';
import {Store} from '../app/store';
import {busyHermesRows} from '../app/turn-joins';

const root=process.cwd(),backendRoot=process.env.TRISMEGISTUS_EXE?path.join(path.dirname(process.env.TRISMEGISTUS_EXE),'resources'):root,data=await fs.mkdtemp(path.join(root,'work/reply-recovery-')),host=new Backend(backendRoot,data,'Trismegistus/Test/'+path.basename(data),()=>{});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
process.env.TRISMEGISTUS_TEST_PROVIDER_URL=JSON.parse(line).url;
const home=path.join(data,'hermes');await fs.mkdir(home,{recursive:true});
await fs.cp(path.join(backendRoot,'plugins/trismegistus-permissions'),path.join(home,'plugins/trismegistus-permissions'),{recursive:true});
await fs.writeFile(path.join(home,'config.yaml'),JSON.stringify({model:{default:'deepseek-flash',provider:'deepseek',base_url:process.env.TRISMEGISTUS_TEST_PROVIDER_URL},plugins:{enabled:['trismegistus-permissions']},security:{redact_secrets:true,allow_lazy_installs:false},desktop:{auto_continue:{enabled:false}},terminal:{cwd:data}}));
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const store=new Store(path.join(data,'chat.sqlite'));
try{
 await host.start('synthetic-deepseek-regression-credential');
 const project=store.project(data),chat=store.chat(project.id),turn=store.accept('turn',chat.id,'Return a short reply');
 const session:any=await host.rpc.request('session.create',{cwd:data,model:'deepseek-flash',provider:'deepseek',close_on_disconnect:false});
 store.update<any>('chat',chat.id,{runtimeId:session.session_id});store.update<any>('turn',turn.id,{status:'running'});
 const hermesTurns=new Map([[chat.id,turn.id]]),hermesEvents=new Map<string,{seq:number;at:number}>();let complete:any;
 host.rpc.onAny(event=>{if(event.session_id!==session.session_id||complete)return;if(event.type==='message.complete')complete=event;else hermesEvents.set(session.session_id,{seq:event.seq||0,at:Date.now()});});
 await host.rpc.request('prompt.submit',{session_id:session.session_id,text:'Return a short reply'});
 for(const end=Date.now()+30000;!complete&&Date.now()<end;)await new Promise(r=>setTimeout(r,50));assert.ok(complete,'Backend must actually finish');
 assert.equal(store.get<any>('turn',turn.id).status,'running','Completion was deliberately dropped');
 hermesEvents.set(session.session_id,{seq:0,at:Date.now()-20000});
 const source=mainSource(),node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reconcileReplies')!;
 const env={quitting:false,backend:host,store,hermesTurns,hermesEvents,hermesErrors:new Map(),checkingReplies:new Set(),hermesSent:new Map(),waitingFor:()=>new Set(),hermesWaiting:()=>0,preparing:new Map(),commandTurns:new Map(),hermesStarted:new Set(),busyHermesRows,wake:()=>{},emit:()=>{},projectFor:()=>({profile:undefined}),receive:(event:any)=>{if(event.type==='message.complete'){store.update<any>('turn',turn.id,{status:'completed',text:event.payload.text});hermesTurns.delete(chat.id);}}};
 const reconcile=new Function(...Object.keys(env),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return reconcileReplies;')(...Object.values(env));
 await reconcile();assert.equal(host.status,'ready');assert.equal(store.get<any>('turn',turn.id).status,'completed');assert.equal(store.get<any>('turn',turn.id).text,complete.payload.text);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({droppedCompletionRecovered:true,actualHermesReplay:true,noPromptResubmission:true,packagedBackend:backendRoot!==root},null,2));console.log('PASS dropped completion recovered from real Hermes replay; no prompt resubmission. '+data);
}finally{await host.stop();store.db.close();fake.stdin.end();lines.close();await host.host('delete_key');}
