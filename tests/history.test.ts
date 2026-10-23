import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {handover,managementText} from '../app/history';
import {readChatHistory} from '../app/chat-context';
import type {Turn,ToolCall} from '../app/types';

test('Claude → Hermes → Claude transfers only missing chat context and saved tool outcomes',()=>{
  const store=new Store(':memory:');
  const chat=store.chat(store.project().id);
  const first=store.accept('first',chat.id,'Remember copperfinch');
  store.beginEngine(chat.id,'claude');
  store.finishEngine(first.id,'claude','native-claude',{status:'completed',text:'Remembered'});
  const second=store.accept('second',chat.id,'Create a file');
  const transfer=handover(store.all('turn'),[],second,store.beginEngine(chat.id,'hermes'));
  assert.match(transfer.prompt,/copperfinch/);
  store.put('tool',{id:'tool',turnId:second.id,name:'write_file',args:{path:'saved.txt'},result:'written',status:'completed'});
  store.finishEngine(second.id,'hermes','native-hermes',{status:'completed',text:'File saved'});
  const third=store.accept('third',chat.id,'Review the result');
  const back=handover(store.all('turn'),store.all('tool'),third,store.beginEngine(chat.id,'claude'));
  assert.equal(back.sessionId,'native-claude');
  assert.match(back.prompt,/saved.txt/);assert.match(back.prompt,/Do not repeat completed actions/);
  assert.doesNotMatch(back.prompt,/copperfinch/);
  store.db.close();
});

test('uncertain dispatch reseeds context without including another chat or future queued messages',()=>{
  const store=new Store(':memory:');const project=store.project();const chat=store.chat(project.id),other=store.chat(project.id);
  const first=store.accept('first',chat.id,'First instruction');
  store.finishEngine(first.id,'claude','native',{status:'completed',text:'Done'});
  store.beginEngine(chat.id,'claude');
  const partial=store.accept('partial',chat.id,'Interrupted instruction');
  store.update<Turn>('turn',partial.id,{status:'interrupted',text:'Partial answer'});
  const now=store.accept('now',chat.id,'Inspect what happened');
  store.accept('other',other.id,'OTHER CHAT SECRET');store.accept('future',chat.id,'FUTURE MESSAGE');
  const result=handover(store.all('turn'),[],now,store.enginePosition(chat.id,'claude'));
  assert.equal(result.sessionId,null);assert.match(result.prompt,/First instruction/);assert.match(result.prompt,/Partial answer/);
  assert.doesNotMatch(result.prompt,/OTHER CHAT SECRET|FUTURE MESSAGE/);
  assert.equal(store.get<Turn>('turn',partial.id).status,'interrupted');store.db.close();
});

test('command instructions survive engine handover while the original user message remains intact',()=>{
 const store=new Store(':memory:');const chat=store.chat(store.project().id);
 const first=store.accept('command',chat.id,'/example:run copperfinch');
 store.update<Turn>('turn',first.id,{commandContext:'Reviewed command instructions: copperfinch',status:'completed'});
 const current=store.accept('next',chat.id,'/example:run next');current.commandContext='Reviewed command instructions: next';
 const result=handover(store.all('turn'),[],current);
 assert.match(result.prompt,/"user":"\/example:run copperfinch"/);assert.match(result.prompt,/"command_instructions":"Reviewed command instructions: copperfinch"/);
 assert.ok(result.prompt.endsWith('Reviewed command instructions: next'));assert.equal(store.get<Turn>('turn',first.id).prompt,'/example:run copperfinch');store.db.close();
});

test('Claude keeps its session past twelve exchanges (Koan, 2026-10-08); a Hermes failure leaves active Claude work intact',()=>{
  const store=new Store(':memory:');const project=store.project(),chat=store.chat(project.id),other=store.chat(project.id);
  for(let n=0;n<12;n++){const turn=store.accept('turn-'+n,chat.id,'Message '+n,'claude-code:haiku');store.event('event-'+n,()=>store.finishEngine(turn.id,'claude','native',{status:'completed',text:'Reply '+n}));}
  const current=store.accept('current',chat.id,'Next','claude-code:haiku');store.update<Turn>('turn',current.id,{status:'running'});
  const transfer=handover(store.all('turn'),[],current,store.beginEngine(chat.id,'claude'));
  assert.equal(transfer.sessionId,'native');assert.doesNotMatch(transfer.prompt,/Message 0/);
  const hermes=store.accept('hermes',other.id,'Running','deepseek-flash');store.update<Turn>('turn',hermes.id,{status:'running'});
  const plugin=store.accept('plugin',other.id,'/plugin:command','command:example');store.update<Turn>('turn',plugin.id,{status:'running',command:{name:'/example:command',command:'command',pluginId:'example',pluginKey:'reviewed/example',plugin:'example',hash:'fixed'}});
  store.interrupt('hermes');assert.equal(store.get<Turn>('turn',current.id).status,'running');assert.equal(store.get<Turn>('turn',hermes.id).status,'interrupted');assert.equal(store.get<Turn>('turn',plugin.id).status,'running');store.interrupt();assert.equal(store.get<Turn>('turn',plugin.id).status,'interrupted');store.db.close();
});
test('context update reseeds both engines once without changing saved messages',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),id=crypto.randomUUID();
 store.accept(id,chat.id,'Keep this decision','deepseek-flash');store.finishEngine(id,'hermes','old-runtime',{status:'completed',text:'The write finished.'});
 const original=store.get('turn',id);store.put('engine',{...store.enginePosition(chat.id,'claude'),sessionId:'native'});
 store.initializeToolContext();assert.equal(store.enginePosition(chat.id,'hermes').sessionId,null);assert.equal(store.enginePosition(chat.id,'claude').sessionId,null);assert.deepEqual(store.get('turn',id),original);
 store.finishEngine(id,'hermes','new-runtime',{status:'completed'});store.initializeToolContext();assert.equal(store.enginePosition(chat.id,'hermes').sessionId,'new-runtime');store.db.close();
});

test('large restart history stays bounded, preserves the latest correction and retrieves exact old results',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id);
 for(let n=0;n<60;n++){
  const t=store.accept('large-'+n,chat.id,'Instruction '+n+' '+('old discussion '.repeat(1000)));
  store.update<Turn>('turn',t.id,{status:'completed',text:'Recorded outcome '+n,reasoning:'PRIVATE_REASONING '.repeat(20000)});
  for(let k=0;k<20;k++)store.put<ToolCall>('tool',{id:t.id+':'+k,turnId:t.id,name:'read_file',args:{path:'I:/DEV/project/source.ts'},result:'SOURCE_OUTPUT '.repeat(3000),status:'completed'});
 }
 const correction=store.accept('correction',chat.id,'Use I:\\DEV as authoritative. Reject PDMD unless it supports img2vid.');
 store.finishEngine(correction.id,'hermes','oversized-session',{status:'failed',text:'',error:'Context compression could not bring this session under the model context window.'});
 const current=store.accept('current',chat.id,'Update the icon'),pins='Preserve this approved wording exactly.';
 const transfer=handover(store.all('turn'),store.all('tool'),current,store.enginePosition(chat.id,'hermes'),undefined,pins);
 assert.equal(transfer.sessionId,null);assert.ok(transfer.prompt.length<52000,transfer.prompt.length.toString());assert.ok(transfer.prompt.endsWith(current.prompt));
 assert.match(transfer.prompt,/Reject PDMD unless it supports img2vid/);assert.ok(transfer.prompt.includes(pins));assert.doesNotMatch(transfer.prompt,/PRIVATE_REASONING/);assert.match(transfer.prompt,/read_chat_history/);
 const window=JSON.parse(transfer.prompt.split('<conversation_history>\n')[1].split('\n</conversation_history>')[0]);assert.ok(window.omitted>0);assert.equal(window.records.at(-1).id,correction.id);
 const {started,finished,...original}=store.get<ToolCall>('tool','large-0:0');assert.ok(started&&finished);let offset=0,retrieved='';do{const page=readChatHistory(store,current,{toolId:original.id,offset});retrieved+=page.text;offset=page.nextOffset!;}while(offset!==null);
 assert.deepEqual(JSON.parse(retrieved),original);assert.equal(store.all('turn').length,62);store.db.close();
});

test('a Stop or a failure keeps the session; a cut-off tool or a context overflow starts fresh (batch 5, 7c)',()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id);
  const done=(id:string,status:any,cut=false,error?:string)=>{const t=store.accept(id,chat.id,id,'claude-code:opus');if(cut)store.put<ToolCall>('tool',{id:id+':t',turnId:id,name:'Bash',args:{},result:null,status:'running'});store.finishEngine(t.id,'claude','s1',{status,error});return store.enginePosition(chat.id,'claude').uncertain;};
  assert.equal(done('stopped','stopped'),false);assert.equal(done('failed','failed',false,'Your organization has disabled Claude subscription access'),false);assert.equal(done('completed','completed'),false);
  assert.equal(done('cut','stopped',true),true);assert.equal(done('overflow','failed',false,'prompt is too long: 210000 tokens > 200000 maximum'),true);assert.equal(store.enginePosition(chat.id,'claude').sessionId,null,'an overflow drops the session');assert.equal(done('interrupted','interrupted'),true);
  store.db.close();
});

test('a resumed session gets only the new message, with one "Current user message:" (Koan, 2026-10-08)',()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id),first=store.accept('first',chat.id,'First','deepseek-flash');
  store.finishEngine(first.id,'hermes','sess',{status:'completed',text:'Done'});
  const current=store.accept('current',chat.id,'Second','deepseek-flash');
  const lean=handover(store.all('turn'),[],current,store.enginePosition(chat.id,'hermes'),undefined,'','APP LIST',false);
  assert.equal(lean.sessionId,'sess');assert.doesNotMatch(lean.prompt,/Follow the latest user direction|APP LIST/);assert.equal(lean.prompt.split('Current user message:').length,2);assert.ok(lean.prompt.endsWith('Second'));
  const full=handover(store.all('turn'),[],current,undefined,undefined,'','APP LIST');assert.match(full.prompt,/Follow the latest user direction/);
  store.db.close();
});

test('one GO covers the whole plan without repeated requests (Koan, 2026-10-18)',()=>{
  const text=managementText();
  assert.match(text,/^Plan first: when the user asks you to build, change, fix, install or commit something, reply with a short plan/);
  assert.match(text,/then stop/);assert.match(text,/Never tell the user to say or reply GO/);
  assert.match(text,/One GO covers the whole plan, including every step, check and workaround inside it, until the job is done/);
  assert.match(text,/Never stop to ask inside a GO'd job/);assert.match(text,/Small calls are yours; list what you picked in the final report/);
  assert.match(text,/A new or changed request still gets a new plan/);assert.match(text,/Search with rg .*never grep -r/);
  assert.doesNotMatch(text,/wait for the user to say GO|A GO covers only the plan it answers/);
  const full=handover([{id:'t',chatId:'c',prompt:'build it',model:'deepseek-flash',status:'queued',created:1} as any],[],{id:'t',chatId:'c',prompt:'build it'} as any);
  assert.match(full.prompt,/^Plan first:/);
});

test('tool errors use routes inside the plan; a true blocker is stated once',()=>{
 const text=managementText();
 assert.match(text,/If another route is inside the plan, take it without asking/);
 assert.match(text,/Only when truly blocked/);assert.match(text,/say once in plain words what is blocked and what you need, then stop/);
 assert.match(text,/Respect explicit denials and the existing permission checks/);
 assert.doesNotMatch(text,/ask the user for the specific permission|ask whether they want to request approval again/);
});

// 10-13..20: 21 sends waited up to 285 s for a summary because an uncertain Hermes turn threw its session away.
test('Hermes resumes its stored session after an uncertain turn; Claude starts fresh',()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id),first=store.accept('first',chat.id,'Build it','gpt-6'),cut=store.accept('cut',chat.id,'Go on','gpt-6'),next=store.accept('next',chat.id,'Done?','gpt-6');
  store.finishEngine(first.id,'hermes','stored-1',{status:'completed'});store.beginEngine(chat.id,'hermes');
  store.put<ToolCall>('tool',{id:'cut:t',turnId:cut.id,name:'terminal',args:{},result:null,status:'uncertain'});store.finishEngine(cut.id,'hermes','stored-1',{status:'stopped'});
  const position=store.enginePosition(chat.id,'hermes');assert.equal(position.uncertain,true);
  assert.equal(handover(store.all('turn'),store.all('tool'),next,position).sessionId,'stored-1','Hermes keeps its stored session');
  assert.equal(handover(store.all('turn'),store.all('tool'),next,{...position,engine:'claude'}).sessionId,null,'Claude starts fresh');
  store.db.close();
});
