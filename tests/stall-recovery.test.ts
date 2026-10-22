import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {Store} from '../app/store';
import {readChatHistory,readRuntimeHistory,clearHistoryReads} from '../app/chat-context';
import {turnActivity} from '../app/turn-status';
import {toolResultFailed} from '../app/tool-result';
import type {Turn,ToolCall} from '../app/types';

const source=ts.createSourceFile('main.ts',fs.readFileSync('app/main.ts','utf8'),ts.ScriptTarget.Latest,true);
function main(name:string,env:Record<string,unknown>){
 let node:ts.Node|undefined;const visit=(n:ts.Node)=>{if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n))&&n.name?.getText(source)===name)node=n;ts.forEachChild(n,visit);};visit(source);assert.ok(node);
 let code=node.getText(source);if(ts.isMethodDeclaration(node))code=code.replace(/^(async )?/,(_,prefix)=>(prefix||'')+'function ');
 return new Function(...Object.keys(env),ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(env));
}

test('replaying an in-flight desktop request keeps its owner; finished requests never execute again',async()=>{
 for(const method of ['trismegistus.work','trismegistus.mcp']){
  const store=new Store(':memory:'),chat=store.chat(store.project().id),turn=store.accept('turn',chat.id,'Work');store.update<any>('chat',chat.id,{runtimeId:'session'});store.update<Turn>('turn',turn.id,{status:'running'});
  let release!:()=>void,calls=0;const pending=new Promise<void>(resolve=>{release=resolve;});
  const action=async()=>{calls++;await pending;return null;},mcpToolRequests=new Map(),responses:any[]=[];
  const receive=main('request',{store,hermesTurns:new Map([[chat.id,turn.id]]),backend:{generation:'one',scrubber:{value:(v:any)=>v,text:(v:string)=>v}},mcpToolRequests,background:{recoverReceipts:async()=>{}},coordination:{begin:action},projectFor:()=>({profile:'profile',mode:'manual'}),workingDirectory:()=>'/workspace',publish:action});
  const request={id:'same-id',method,params:{session_id:'session',operation:method==='trismegistus.work'?'begin':'publish',name:'terminal',arguments:{command:'echo fixture'}},respond:(value:any)=>responses.push(value)};
  assert.equal(receive(request),true);await new Promise(setImmediate);
  const owner=mcpToolRequests.get('one:same-id');assert.ok(owner);assert.equal(calls,1);
  assert.equal(receive({...request,replayed:true}),true);assert.equal(mcpToolRequests.get('one:same-id'),owner);assert.equal(responses.length,0,'Replay must not cancel the original wait');
  release();await new Promise(setImmediate);assert.equal(calls,1);assert.equal(responses.length,1);assert.equal(mcpToolRequests.size,0);
  receive({...request,replayed:true});await new Promise(setImmediate);assert.equal(calls,1);assert.match(responses.at(-1).error,/already dispatched/);store.db.close();
 }
});
test('real event handler exposes compression, parallel tools, failures and ignores another session',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),turn=store.accept('current',chat.id,'Work');store.update<any>('chat',chat.id,{runtimeId:'session'});store.update<Turn>('turn',turn.id,{status:'running'});
 const hermesTurns=new Map([[chat.id,turn.id]]),receive=main('receive',{nextWatermark:main('nextWatermark',{}),hermesErrors:new Map(),wake:()=>{},replyRow:(id:string)=>hermesTurns.get(id),store,hermesTurns,backend:{generation:'one',scrubber:{value:(v:any)=>v}},hermesEvents:new Map(),emit:()=>{},emitStream:()=>{},toolResultFailed,clearHistoryReads,requests:new Map(),mcpToolRequests:new Map(),coordination:{denied:()=>{}}});
 let seq=0;const send=(type:string,payload:any={},session_id='session')=>receive({type,payload,session_id,seq:++seq});
 const activity=()=>turnActivity(store.get('turn',turn.id),store.all('tool'),[]);
 send('status.update',{kind:'compacting'});assert.equal(activity(),'Compressing context');const since=store.get<Turn>('turn',turn.id).stageSince;
 send('status.update',{kind:'compacting'});assert.equal(store.get<Turn>('turn',turn.id).stageSince,since,'Progress does not reset elapsed stage time');
 send('status.update',{kind:'compacted'});assert.equal(activity(),'Waiting for model');
 send('tool.start',{tool_id:'a',name:'patch'});send('tool.start',{tool_id:'b',name:'read_file'});assert.equal(activity(),'Running 2 tools');
 send('tool.complete',{tool_id:'a',result:{success:false,error:'Patch validation failed'}});assert.equal(store.get<ToolCall>('tool','current:a').status,'failed');assert.equal(activity(),'Running 1 tool');
 send('tool.complete',{tool_id:'b',result:'contents'});assert.equal(activity(),'Waiting for model');
 send('status.update',{kind:'compacting'},'old-session');assert.equal(activity(),'Waiting for model');
 store.put('approval',{id:'one:approval',chatId:chat.id,turnId:turn.id,method:'approval',params:{},status:'pending'});store.update<Turn>('turn',turn.id,{status:'waiting'});
 send('request.cancel',{id:'approval',reason:'timeout'});assert.equal(store.get<any>('approval','one:approval').status,'expired');assert.equal(activity(),'Waiting for model');
 store.update<Turn>('turn',turn.id,{status:'waiting'});assert.equal(activity(),'Waiting for model','A withdrawn native approval cannot leave a false approval wait');
 const next=store.accept('next',chat.id,'Continue');hermesTurns.set(chat.id,next.id);store.update<ToolCall>('tool','current:a',{status:'uncertain'});
 send('tool.complete',{tool_id:'a',result:{success:true}});assert.equal(store.get<ToolCall>('tool','current:a').status,'completed');assert.equal(store.all<ToolCall>('tool').some(t=>t.turnId===next.id),false);store.db.close();
});
test('side-job follow-ups queue durably, cancel independently and explicit correction alone interrupts',async()=>{
 const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),child=store.chat(project.id),parent=store.accept('parent',chat.id,'Work'),current=store.accept('current',child.id,'Work');
 store.update<any>('chat',child.id,{parentChatId:chat.id,groupTurnId:parent.id});store.update<Turn>('turn',parent.id,{jobs:[current.id],status:'running'});store.update<Turn>('turn',current.id,{parentTurnId:parent.id,status:'running'});
 const controller=new AbortController(),preparing=new Map([[child.id,{turnId:current.id,controller}]]),env={store,commandTurns:new Map([[chat.id,parent.id]]),preparing,hermesTurns:new Map(),replyRow:(id:string)=>preparing.get(id)?.turnId,native:{replyRow:()=>undefined,interrupt:async()=>[],withdraw:async()=>true},contextJobs:new Map(),jevControllers:new Map(),mcpToolRequests:new Map(),requests:new Map(),backend:{scrubber:{text:(s:string)=>s}},redactPastedKeys:(s:string)=>s,wake:()=>{},emit:()=>{},goals:{forget:()=>{}}};
 const send=main('correctJob',env);for(const id of ['queued-first','queued-second'])await send({id,chatId:child.id,text:id,queue:true});
 assert.equal(controller.signal.aborted,false);assert.equal(store.get<Turn>('turn',current.id).status,'running');
 await send({id:'queued-first',chatId:child.id,text:'queued-first',queue:true});assert.equal(store.get<Turn>('turn',parent.id).jobs!.length,3);
 await main('cancelQueued',env)({id:'queued-first'});assert.deepEqual(store.get<Turn>('turn',parent.id).jobs,[current.id,'queued-second']);assert.equal(controller.signal.aborted,false);
 await send({id:'queued-first',chatId:child.id,text:'queued-first',queue:true});assert.equal(store.all<Turn>('turn').some(t=>t.id==='queued-first'),false,'A retried IPC must not restore a cancelled message');
 await send({id:'explicit-correction',chatId:child.id,text:'Change direction',queue:false});assert.equal(controller.signal.aborted,true);assert.equal(store.get<Turn>('turn',current.id).stopReason,'superseded-by-message');store.db.close();
});
test('history budgets include JSON escaping and metadata; nested lookups keep retrievable originals',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),old=store.accept('old',chat.id,'Keep exact approved words'),current=store.accept('now',chat.id,'Continue');store.update<Turn>('turn',old.id,{status:'completed'});
 const body='"\\\n'.repeat(15000);store.put('tool',{id:'nested',turnId:old.id,name:'read_chat_history',status:'completed',args:{},result:body});
 for(let i=0;i<250;i++)store.put('tool',{id:'tool-'+i,turnId:old.id,name:'read_file',status:'completed',args:{},result:'old source'});
 const list=readChatHistory(store,current,{});assert.ok(JSON.stringify(list).length<=24000);assert.equal(list.messages![0].toolCount,251);assert.equal(list.messages![0].tools.length,20);
 let offset=0,full='';do{const page=readChatHistory(store,current,{toolId:'nested',offset});assert.ok(JSON.stringify(page).length<=24000);full+=page.text;offset=page.nextOffset!;}while(offset!==null);
 assert.equal(JSON.parse(full).result,body);assert.equal(store.get<ToolCall>('tool','nested').result,body);
 const message=readChatHistory(store,current,{turnId:'old'});assert.match(message.text!,/reference/);assert.match(message.text!,/Keep exact approved words/);assert.ok(message.totalCharacters!<30000);
 const request={toolId:'nested'};assert.ok('text' in readRuntimeHistory(store,current,request));assert.ok('unchanged' in readRuntimeHistory(store,current,request));assert.ok('text' in readRuntimeHistory(store,current,request),'A reload remains available even if a prune notification is missed');
 clearHistoryReads(store,current.id);assert.ok('text' in readRuntimeHistory(store,current,request));store.update<ToolCall>('tool','nested',{result:'Changed'});assert.ok('text' in readRuntimeHistory(store,current,request),'Changed records never return an unchanged stub');store.db.close();
});
test('restart and backend loss preserve initiating stop causes and uncertain results without queue replay',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),first=store.accept('first',chat.id,'Work'),next=store.accept('next',chat.id,'Queued');
 store.update<Turn>('turn',first.id,{status:'stopping',stopReason:'user-stop'});store.put('tool',{id:'write',turnId:first.id,name:'write_file',status:'running'});store.interrupt('hermes','backend-lost');
 assert.equal(store.get<Turn>('turn',first.id).stopReason,'user-stop');assert.equal(store.get<ToolCall>('tool','write').status,'uncertain');assert.equal(store.get<Turn>('turn',next.id).status,'queued');
 store.update<Turn>('turn',next.id,{status:'running'});store.interrupt();assert.equal(store.get<Turn>('turn',next.id).stopReason,'app-restart');store.db.close();
});
test('retrying Stop and send never interrupts the already-accepted follow-up',async()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),turn=store.accept('accepted',chat.id,'Continue');store.update<Turn>('turn',turn.id,{status:'running'});
 let stopped=false;const correct=main('correctGroup',{store,replyRow:()=>turn.id,handlers:{submit:async()=>turn.id,stop:async()=>{stopped=true;}}});
 assert.equal(await correct({id:turn.id,chatId:chat.id,text:turn.prompt}),turn.id);assert.equal(stopped,false);store.db.close();
});

test('a waiting message names what it waits for; the log has one line per change with the engine state (TURN-REVIEW part 3)',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),waiting=store.accept('waiting',chat.id,'Next');
 const lines:string[]=[],env={store,preparing:new Map(),commandTurns:new Map(),hermesTurns:new Map(),hermesWaiting:()=>0,native:{processingReasons:()=>['claude-turn=A']},holds:new Map(),appendFileSync:(_:string,line:string)=>lines.push(line),path:{join:(...p:string[])=>p.join('/')},data:'data'};
 const engineState=main('engineState',env),hold=main('hold',{...env,engineState});
 hold(chat.id,waiting,'Waiting for Opus to finish before GPT-6 takes over');hold(chat.id,store.get<Turn>('turn',waiting.id),'Waiting for Opus to finish before GPT-6 takes over');
 assert.equal(lines.length,1,'same reason is logged once');assert.match(lines[0],/turn=waiting held: Waiting for Opus to finish before GPT-6 takes over \| engine: claude-turn=A/);
 assert.equal(store.get<Turn>('turn',waiting.id).hold,'Waiting for Opus to finish before GPT-6 takes over','shown on the message');
 hold(chat.id,store.get<Turn>('turn',waiting.id),'');assert.match(lines[1],/turn=waiting released/);assert.equal(store.get<Turn>('turn',waiting.id).hold,undefined);
 store.db.close();
});

test('only an engine or model switch waits: same-model messages go to a busy Claude at once (TURN-REVIEW part 3)',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),commandTurns=new Map<string,string>(),hermesTurns=new Map<string,string>();let busy=true;
 const labels:Record<string,string>={'claude-code:opus':'Opus','claude-code:sonnet':'Sonnet','gpt-6-astra':'GPT-6'};
 const env={store,commandTurns,hermesTurns,hermesSent:new Map(),native:{processing:()=>busy,liveModel:()=>'opus'},modelLabel:(m:string)=>labels[m]||m,claude:{models:[]},providerFor:(m:string)=>m.startsWith('claude-code:')?'claude-code':'openai-codex',reviewRequest:()=>null};
 const reason=main('switchReason',env),turn=(id:string,m:string)=>store.accept(id,chat.id,'Message',m);
 assert.equal(reason(chat,turn('a','claude-code:opus')),'','same model: sent to Claude now; it reads it after its current step');
 assert.equal(reason(chat,turn('b','claude-code:sonnet')),'Waiting for Opus to finish before Sonnet takes over');
 assert.equal(reason(chat,turn('c','gpt-6-astra')),'Waiting for Opus to finish before GPT-6 takes over');
 busy=false;assert.equal(reason(chat,turn('d','gpt-6-astra')),'','idle: any engine');
 hermesTurns.set(chat.id,'c');assert.equal(reason(chat,turn('e','claude-code:opus')),'Waiting for GPT-6 to finish before Opus takes over');
 assert.equal(reason(chat,turn('g','gpt-6-astra')),'','same model: sent to Hermes now, it reads it after its current step (steer)');
 assert.equal(reason(chat,turn('h','deepseek-flash')),'Waiting for GPT-6 to finish before deepseek-flash takes over');
 commandTurns.set(chat.id,'d');assert.equal(reason(chat,turn('f','claude-code:opus')),'Waiting for the command to finish');
 commandTurns.clear();hermesTurns.clear();busy=false;assert.equal(reason(chat,{...turn('i','command:plugin'),command:{name:'/plugin:run'}}),'','a plugin command has no engine model');
 store.db.close();
});

test('Stop targets the running reply, never the message being prepared behind it (Stop and send, message-retry)',()=>{
 const preparing=new Map([['chat',{turnId:'correction',controller:new AbortController()}]]),hermesTurns=new Map<string,string>(),commandTurns=new Map<string,string>();let claude:string|undefined='slow reply';
 const replyRow=main('replyRow',{preparing,hermesTurns,commandTurns,native:{replyRow:()=>claude}});
 assert.equal(replyRow('chat'),'slow reply');claude=undefined;hermesTurns.set('chat','gpt reply');assert.equal(replyRow('chat'),'gpt reply');
 hermesTurns.clear();assert.equal(replyRow('chat'),'correction','with nothing running, Stop ends the preparation');
});
