import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {Store} from '../app/store';
import {resumeDraft} from '../app/chat-context';
import {mainSource} from './fixtures/main-source';

const source=mainSource();
function sessionFunction(environment:Record<string,unknown>){
 const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='session')!;
 return new Function(...Object.keys(environment),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return session;')(...Object.values(environment));
}
test('Stop cancels a pending session create/resume/setup and never attaches its late result',async()=>{
 for(const stage of ['session.create','session.resume','session.cwd.set']){
  const store=new Store(':memory:'),project=store.project('C:/workspace'),chat=store.chat(project.id),controller=new AbortController();
  if(stage==='session.resume')chat.storedId='saved';
  let release!:(value:any)=>void,entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
  const request=async(method:string,_params:any,_timeout?:number,signal?:AbortSignal)=>{
   if(method!==stage)return {session_id:'fresh',stored_session_id:'saved'};
   entered();return new Promise((resolve,reject)=>{release=resolve;signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
  };
  const session=sessionFunction({store,projectFor:()=>project,workingDirectory:()=>project.folder,wireModel:(m:string)=>m,providerFor:()=> 'deepseek',backend:{rpc:{request}},hermesModels:new Map(),usageBaseline:new Map()});
  const turn=store.accept('current',chat.id,'Run'),preparing=new Map([[chat.id,{turnId:turn.id,controller}]]);store.update<any>('turn',turn.id,{status:'dispatching'});
  let stopNode:ts.MethodDeclaration|undefined;const visit=(node:ts.Node)=>{if(ts.isMethodDeclaration(node)&&node.name.getText(source)==='stop')stopNode=node;ts.forEachChild(node,visit);};visit(source);assert.ok(stopNode);
  const stopEnv={store,preparing,hermesTurns:new Map(),replyRow:(id:string)=>preparing.get(id)?.turnId,goals:{pause:()=>{}},contextJobs:new Map(),pluginControllers:new Map(),jevControllers:new Map(),mcpToolRequests:new Map(),requests:new Map(),background:{stopChat:async()=>{}},native:{stopChat:async()=>{},replyRow:()=>undefined,interrupt:async()=>[]},emit:()=>{}};
  const stop=new Function(...Object.keys(stopEnv),ts.transpile(stopNode.getText(source).replace(/^async stop/,'async function stop'),{target:ts.ScriptTarget.ES2022})+';return stop;')(...Object.values(stopEnv));
  const result=session(chat,'deepseek-flash',controller.signal);await waiting;await stop({chatId:chat.id});
  await assert.rejects(Promise.race([result,new Promise((_,reject)=>setTimeout(()=>reject(Error('Cancellation was ignored: '+stage)),100))]),{name:'AbortError'});
  release({session_id:'late',stored_session_id:'late'});await new Promise(r=>setImmediate(r));
  assert.equal(store.get<any>('chat',chat.id).runtimeId,null);store.db.close();
 }
});

test('automatic compaction has one total deadline and retains the prior context on timeout',async t=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),deadline=new AbortController(),contextJobs=new Map();
 store.update<any>('chat',chat.id,{context:{summary:'Existing summary'}});
 t.mock.method(AbortSignal,'timeout',(ms:number)=>{assert.equal(ms,300000);return deadline.signal;});
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve);
 const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='generateContext')!;
 const environment={store,resumeDraft,apiChanging:false,contextJobs,sidebar:{root:()=>chat},contextSource:()=>({batches:[[{text:'First'}],[{text:'Second'}]],previous:'Existing summary'}),emit:()=>{},randomUUID:()=>crypto.randomUUID(),contextSystem:'Summary',contextCompletion:async(_chat:any,_model:any,_system:any,_prompt:any,signal:AbortSignal)=>{entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
 const generate=new Function(...Object.keys(environment),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return generateContext;')(...Object.values(environment));
 const pending=generate(chat.id,'model',{origin:'automatic'});await waiting;deadline.abort(Error('Summary deadline'));await assert.rejects(pending,/Summary deadline/);
 assert.equal(contextJobs.size,0);assert.equal(store.get<any>('chat',chat.id).context.summary,'Existing summary');assert.equal(store.all('context-draft').length,0);assert.equal(store.all('context-usage').length,1);store.db.close();
});

test('side-job correction cancels preparation while preserving the accepted correction',async()=>{
 const store=new Store(':memory:'),project=store.project(),parentChat=store.chat(project.id),child=store.chat(project.id),parent=store.accept('parent',parentChat.id,'Parallel work'),current=store.accept('current',child.id,'Work');
 store.update<any>('chat',child.id,{parentChatId:parentChat.id,groupTurnId:parent.id});store.update<any>('turn',parent.id,{jobs:[current.id]});store.update<any>('turn',current.id,{parentTurnId:parent.id,status:'dispatching'});
 const controller=new AbortController(),commandTurns=new Map([[parentChat.id,parent.id]]),preparing=new Map([[child.id,{turnId:current.id,controller}]]);let node:ts.MethodDeclaration|undefined;
 const visit=(n:ts.Node)=>{if(ts.isMethodDeclaration(n)&&n.name.getText(source)==='correctJob')node=n;ts.forEachChild(n,visit);};visit(source);assert.ok(node);
 const env={store,commandTurns,preparing,hermesTurns:new Map(),replyRow:(id:string)=>preparing.get(id)?.turnId,native:{replyRow:()=>undefined,interrupt:async()=>[],stopChat:async()=>{}},contextJobs:new Map(),jevControllers:new Map(),mcpToolRequests:new Map(),requests:new Map(),backend:{scrubber:{text:(s:string)=>s}},redactPastedKeys:(s:string)=>s,wake:()=>{},emit:()=>{}};
 const correct=new Function(...Object.keys(env),ts.transpile(node.getText(source).replace(/^async correctJob/,'async function correctJob'),{target:ts.ScriptTarget.ES2022})+';return correctJob;')(...Object.values(env));
 await correct({id:'next-correction',chatId:child.id,text:'Use this correction'});assert.equal(controller.signal.aborted,true);assert.equal(store.get<any>('turn',current.id).status,'stopping');assert.equal(store.get<any>('turn','next-correction').status,'queued');assert.deepEqual(store.get<any>('turn',parent.id).jobs,[current.id,'next-correction']);store.db.close();
});
