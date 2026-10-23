import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {Store} from '../app/store';
import {busyHermesRows} from '../app/turn-joins';
import {mainSource} from './fixtures/main-source';

test('a missing completion is replayed once without resubmission; a slow check does not stop work',async()=>{
 const source=mainSource();
 const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reconcileReplies')!;
 for(const broken of [false,true]){
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),turn=store.accept('turn',chat.id,'Do the work');
  store.update<any>('chat',chat.id,{runtimeId:'session'});store.update<any>('turn',turn.id,{status:'running'});
  const hermesTurns=new Map([[chat.id,turn.id]]),seen=new Map([['session',{seq:1516,at:Date.now()-20000}]]),calls:string[]=[],failures:string[]=[];
  const environment={quitting:false,store,hermesTurns,hermesEvents:seen,hermesErrors:new Map(),checkingReplies:new Set(),hermesSent:new Map(),waitingFor:()=>new Set(),hermesWaiting:()=>0,preparing:new Map(),commandTurns:new Map(),hermesStarted:new Set(),busyHermesRows,wake:()=>{},emit:()=>{},projectFor:()=>project,
   backend:{status:'ready',generation:'g',scrubber:{text:(s:string)=>s},rpc:{request:async(method:string,args:any)=>{calls.push(method);assert.equal(args.last_seen,1516);if(broken)throw Error('request timed out');return {events:[{type:'message.complete',session_id:'session',seq:1517,payload:{text:'Finished on the backend',status:'complete'}}]};},invalidate:(s:string)=>failures.push(s)}},
   receive:(event:any)=>{assert.equal(event.type,'message.complete');store.update<any>('turn',turn.id,{text:event.payload.text,status:'completed'});hermesTurns.delete(chat.id);}};
  const check=new Function(...Object.keys(environment),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return reconcileReplies;')(...Object.values(environment));
  await check();
  if(broken){assert.equal(failures.length,0);assert.match(store.get<any>('connection-check',turn.id).error,/request timed out/);assert.equal(hermesTurns.get(chat.id),turn.id);await check();assert.equal(calls.length,1);}
  else{await check();assert.equal(store.get<any>('turn',turn.id).status,'completed');assert.equal(calls.length,1);}
  assert.deepEqual(calls,['session.events.since']);store.db.close();
 }
});

test('late replay results cannot complete a replacement turn or cross a backend restart',async()=>{
 const source=mainSource();
 const code=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reconcileReplies')!.getText(source);
 for(const replaced of ['turn','backend']){
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),turn=store.accept('old',chat.id,'Work');
  store.update<any>('chat',chat.id,{runtimeId:'session'});store.update<any>('turn',turn.id,{status:'running'});
  const hermesTurns=new Map([[chat.id,turn.id]]),checkingReplies=new Set(),hermesEvents=new Map([['session',{seq:1,at:0}]]);let delivered=0;
  const backend={status:'ready',generation:'before',rpc:{request:async()=>{if(replaced==='turn')hermesTurns.set(chat.id,'new');else backend.generation='after';return {events:[{type:'message.complete',session_id:'session',seq:2}]};}}};
  const env={quitting:false,store,hermesTurns,checkingReplies,hermesEvents,hermesErrors:new Map(),hermesSent:new Map(),waitingFor:()=>new Set(),hermesWaiting:()=>0,preparing:new Map(),commandTurns:new Map(),hermesStarted:new Set(),busyHermesRows,wake:()=>{},emit:()=>{},backend,projectFor:()=>project,receive:()=>delivered++};
  await new Function(...Object.keys(env),ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return reconcileReplies;')(...Object.values(env))();
  assert.equal(delivered,0);assert.equal(checkingReplies.size,0);assert.equal(store.get<any>('turn',turn.id).status,'running');store.db.close();
 }
});

test('a Hermes turn that ended with only an error event is closed once its session is idle (audit 3.4)',async()=>{
 const source=mainSource();
 const code=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reconcileReplies')!.getText(source);
 for(const status of ['idle','working']){
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),turn=store.accept('turn',chat.id,'Read @huge.log');
  store.update<any>('chat',chat.id,{runtimeId:'session'});store.update<any>('turn',turn.id,{status:'running'});
  const hermesTurns=new Map([[chat.id,turn.id]]),received:any[]=[],hermesErrors=new Map([['session','Context injection refused.']]);
  const backend={status:'ready',generation:'g',rpc:{request:async(method:string)=>method==='session.events.since'?{events:[]}:{sessions:[{id:'session',status}]}}};
  const env={quitting:false,store,hermesTurns,checkingReplies:new Set(),hermesEvents:new Map([['session',{seq:3,at:0}]]),hermesErrors,hermesSent:new Map(),waitingFor:()=>new Set(),hermesWaiting:()=>0,preparing:new Map(),commandTurns:new Map(),hermesStarted:new Set(),busyHermesRows,wake:()=>{},emit:()=>{},backend,projectFor:()=>project,receive:(event:any)=>received.push(event)};
  await new Function(...Object.keys(env),ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return reconcileReplies;')(...Object.values(env))();
  if(status==='idle')assert.deepEqual(received,[{type:'message.complete',session_id:'session',payload:{status:'error',error:'Context injection refused.'}}]);
  else assert.deepEqual(received,[],'a session still working (e.g. after a failed compression) keeps its turn');
  store.db.close();
 }
});

test('a Hermes Stop with no answer ends locally after its deadline and drops the session (audit 3.5)',async()=>{
 const source=mainSource();
 const code=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='stopDeadline')!.getText(source);
 for(const answered of [false,true]){
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),turn=store.accept('turn',chat.id,'Work');
  store.update<any>('chat',chat.id,{runtimeId:'session',storedId:'stored'});store.update<any>('turn',turn.id,{status:answered?'stopped':'stopping'});
  const hermesTurns=new Map([[chat.id,turn.id]]),received:any[]=[],calls:string[]=[];
  const env={quitting:false,store,hermesTurns,projectFor:()=>project,emit:()=>{},backend:{rpc:{request:async(method:string)=>{calls.push(method);}}},receive:(event:any)=>{received.push(event);store.update<any>('turn',turn.id,{status:'stopped'});hermesTurns.delete(chat.id);}};
  new Function(...Object.keys(env),ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return stopDeadline;')(...Object.values(env))(chat.id,turn.id,'session');
  if(answered){assert.deepEqual(received,[]);assert.equal(store.get<any>('chat',chat.id).runtimeId,'session');}
  else{assert.equal(received[0].payload.status,'interrupted');assert.equal(store.get<any>('chat',chat.id).runtimeId,null);assert.equal(store.get<any>('chat',chat.id).storedId,null);assert.deepEqual(calls,['session.close']);}
  store.db.close();
 }
});

test('a failed send counts as accepted only when Hermes reports the session busy (audit 3.6)',async()=>{
 const source=mainSource();
 const code=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='hermesAccepted')!.getText(source);
 const check=(answer:()=>Promise<any>)=>new Function('backend',ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return hermesAccepted;')({rpc:{request:answer}})('default','session');
 assert.equal(await check(async()=>({sessions:[{id:'session',status:'working'}]})),true,'accepted: keep watching');
 assert.equal(await check(async()=>({sessions:[{id:'session',status:'idle'}]})),false);
 assert.equal(await check(async()=>({sessions:[]})),false);
 assert.equal(await check(async()=>{throw Error('down');}),false);
});

test('a lost completion holds the event watermark so the replay returns it, even after a later title event (audit 3.11)',()=>{
 const source=mainSource();
 const code=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='nextWatermark')!.getText(source);
 const next=new Function(ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return nextWatermark;')();
 let mark:number|undefined;for(const seq of [1,2,4,5])mark=next(mark,seq);
 assert.equal(mark,2,'event 3 (the completion) was lost: the replay must start after 2');
 for(const seq of [3,4,5])mark=next(mark,seq);assert.equal(mark,5,'the replay fills the gap');
 assert.equal(next(5,5),5,'a duplicate changes nothing');assert.equal(next(undefined,7),7,'first event seen');
});

// 10-19: rows Hermes never closed (a crashed reply's joined messages, a second start's row) held the chat and Fork
// said "Wait for queued work to finish." until a restart. With nothing tracked and Hermes idle for 15 s they close.
test('a busy Hermes row nothing tracks closes once the chat is quiet and Hermes idle',async()=>{
 const source=mainSource();
 const code=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reconcileReplies')!.getText(source);
 for(const [status,eventAge,expected] of [['idle',60000,'failed'],['working',60000,'running'],['idle',5000,'running']] as const){
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id);
  for(const id of ['ghost','joined']){store.accept(id,chat.id,id,'gpt-6');store.update<any>('turn',id,{status:'running'});}
  store.update<any>('chat',chat.id,{runtimeId:'session'});
  // A minute later: the rows have not changed since; Hermes's last event was eventAge ago.
  const later=Date.now()+60000,clock={now:()=>later},backend={status:'ready',generation:'g',rpc:{request:async()=>({sessions:[{id:'session',status}]})}};
  const env={quitting:false,store,hermesTurns:new Map(),checkingReplies:new Set(),hermesEvents:new Map([['session',{seq:3,at:later-eventAge}]]),hermesErrors:new Map(),hermesSent:new Map(),waitingFor:()=>new Set(),hermesWaiting:()=>0,preparing:new Map(),commandTurns:new Map(),hermesStarted:new Set(),busyHermesRows,wake:()=>{},emit:()=>{},backend,projectFor:()=>project,receive:()=>{},Date:clock};
  await new Function(...Object.keys(env),ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return reconcileReplies;')(...Object.values(env))();
  assert.deepEqual(['ghost','joined'].map(id=>store.get<any>('turn',id).status),[expected,expected],status+' after '+eventAge+' ms');
  store.db.close();
 }
});
