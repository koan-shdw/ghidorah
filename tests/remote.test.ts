import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readRemote,readInbound,parseRequest,remoteTurnId,gateChannel,GatewaySupervisor,RemoteDesk,replyFor,secretApproval,clip,topicName,topicLink,type DeskDeps} from '../app/remote';
import {Store} from '../app/store';
import {chatPlace,claimRemoteOutbox,enqueueRemote,pruneRemoteOutbox,recordRemoteReceipt,remotePrompt,type TopicRecord} from '../app/remote-outbox';
import {autoTitled,cleanName,fallbackName,planTopics,topicRetry,uniqueName} from '../app/remote-threads';

test('only the owner\'s direct message is read; a code, Deny and the safe commands are told apart',()=>{
 assert.deepEqual(readRemote({enabled:true,owner:'4242',chatId:'c1'}),{enabled:true,owner:'4242',chatId:'c1',paused:false,topics:true,topicsSince:null,topicError:'',username:''});
 assert.equal(readRemote({username:'ghidora_bot'}).username,'ghidora_bot');assert.equal(readRemote({username:'not a name'}).username,'');
 assert.equal(readRemote({owner:'0123'}).owner,'',"an id can't start with 0");
 const message={message_id:'17',chat_id:'4242',user_id:'4242',text:'hello'};
 assert.deepEqual(readInbound(message,'4242'),message);
 assert.deepEqual(readInbound({...message,thread_id:'55'},'4242'),{...message,thread_id:'55'});
 for(const bad of [{...message,user_id:'99'},{...message,chat_id:'-100123'},{...message,message_id:'x'},{...message,text:7},{...message,thread_id:'5x'},{...message,thread_id:55}])assert.equal(readInbound(bad,'4242'),null);
 assert.equal(readInbound(message,''),null,'no owner set: nothing is read');
 assert.deepEqual(parseRequest(' 123456 '),{kind:'code',code:'123456'});
 assert.deepEqual(parseRequest('/approve 654321'),{kind:'code',code:'654321'});
 assert.deepEqual(parseRequest('Deny'),{kind:'deny'});assert.deepEqual(parseRequest('/deny'),{kind:'deny'});
 assert.deepEqual(parseRequest('/project@trismegistus_bot 2'),{kind:'command',name:'project',arg:'2'});
 assert.deepEqual(parseRequest('fix the build'),{kind:'text',text:'fix the build'});
 assert.match(remoteTurnId('4242','17'),/^[\w-]{10,80}$/);
 assert.equal(clip('x'.repeat(5000)).length,4000);
});

test('the channel answers only its token; the outbox waits for a row, then hands it over',async()=>{
 const seen:any[]=[],sent:any[]=[];let rows:any[]=[],ready=0;
 const channel=await gateChannel({inbound:async value=>{seen.push(value);},ready:()=>{ready++;},outbox:after=>rows.filter(row=>row.seq>after),sent:(seq,ok)=>{sent.push([seq,ok]);}});
 const call=(path:string,body?:unknown,token=channel.connection.token)=>fetch(channel.connection.url+path.replace(/^\//,''),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  assert.equal((await call('/inbound',{a:1},'0'.repeat(64))).status,403);assert.deepEqual(seen,[]);
  assert.equal((await call('/inbound',{a:1})).status,200);assert.deepEqual(seen,[{a:1}]);
  assert.equal((await call('/ready',{})).status,200);assert.equal(ready,1);
  const waiting=call('/outbox?after=0').then(response=>response.json());
  await new Promise(resolve=>setTimeout(resolve,100));rows=[{seq:1,chat_id:'4242',text:'hi'}];channel.notify();
  assert.deepEqual(await waiting,[{seq:1,chat_id:'4242',text:'hi'}]);
  assert.equal((await call('/sent',{seq:1,ok:true})).status,200);assert.deepEqual(sent,[[1,true]]);
  assert.equal((await call('/sent',{seq:'1',ok:true})).status,400);
 }finally{channel.close();}
});

class FakeChild extends EventEmitter{stderr=new EventEmitter();pid=1;}
test('a gateway that keeps stopping is restarted, then latched off after three exits in five minutes',async()=>{
 let now=0;const children:FakeChild[]=[],killed:FakeChild[]=[];
 const supervisor=new GatewaySupervisor(()=>{const child=new FakeChild();children.push(child);return child as any;},child=>{killed.push(child as any);},()=>{},()=>now);
 supervisor.start();assert.equal(supervisor.status,'starting');supervisor.ready();assert.equal(supervisor.status,'running');
 children[0].emit('exit',1);assert.equal(supervisor.status,'starting');
 await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(children.length,2,'restarted');
 now=1000;children[1].stderr.emit('data','telegram.error.InvalidToken: The token was rejected\n');children[1].emit('exit',1);
 await new Promise(resolve=>setTimeout(resolve,2100));assert.equal(children.length,3);
 now=2000;children[2].emit('exit',1);
 assert.equal(supervisor.status,'failed');assert.match(supervisor.message,/three times/);assert.equal(supervisor.running,false);
 supervisor.start();assert.equal(children.length,4,'turning Remote on again clears the latch');
 supervisor.stop();assert.equal(supervisor.status,'off');assert.deepEqual(killed,[children[3]]);
 children[3].emit('exit',1);assert.equal(children.length,4,'an asked-for stop is not restarted');
});

// topics: one thread per chat is on, as it is unless he turns it off; `false` is the plain bot chat without threads.
function desk(overrides:Partial<DeskDeps>={},topics=true){
 const sent:string[]=[],threads:(string|undefined)[]=[],alerts:string[]=[],submitted:any[]=[],seen=new Set<string>();let settings={enabled:true,owner:'4242',chatId:null as string|null,paused:false,topics,topicsSince:null as number|null,topicError:'',username:''};
 const deps:DeskDeps={settings:()=>settings,save:patch=>{settings={...settings,...patch};},seen:id=>seen.has(id),done:id=>{seen.add(id);},send:(text,_deny,thread)=>{sent.push(text);threads.push(thread);},alert:(title,body)=>{alerts.push(title+': '+body);},
  chats:()=>[{id:'c2',title:'Second'},{id:'c1',title:'First'}],newChat:async()=>'c3',topicChat:thread=>thread==='55'?{id:'c1',title:'First'}:null,linkTopic:async()=>({id:'c9',title:'New chat'}),submit:async(id,chatId,text,thread)=>{submitted.push(thread?[id,chatId,text,thread]:[id,chatId,text]);},stop:async()=>{},status:()=>'Ready',
  waiting:()=>null,prompt:()=>false,code:async()=>'Approved.',deny:async()=>'Denied.',answer:async()=>'Answered.',...overrides};
 return {desk:new RemoteDesk(deps),sent,threads,alerts,submitted,settings:()=>settings};
}
const from=(id:string,text:string)=>({message_id:id,chat_id:'4242',user_id:'4242',text});

test('Telegram Start shows help once without sending its connection payload to a model',async()=>{
 const run=desk(),message=from('1','/start connection-proof');
 await run.desk.receive(message);await run.desk.receive(message);
 assert.equal(run.sent.length,1);assert.match(run.sent[0],/^\/help:/);assert.match(run.sent[0],/\/new:/);assert.ok(!run.sent[0].includes('connection-proof'));assert.deepEqual(run.submitted,[]);
 await run.desk.receive({...from('2','/start'),user_id:'99',chat_id:'99'});assert.equal(run.sent.length,1);
});

test('without threads, a message becomes one turn in the chosen chat; a repeated delivery does nothing; strangers are ignored',async()=>{
 const run=desk({},false);
 await run.desk.receive(from('1','fix the build'));await run.desk.receive(from('1','fix the build'));
 assert.deepEqual(run.submitted,[['telegram-4242-1','c2','fix the build']]);assert.deepEqual(run.sent,['Sent to Second.']);assert.equal(run.alerts.length,1);
 await run.desk.receive({...from('2','hi'),user_id:'99',chat_id:'99'});assert.equal(run.submitted.length,1);
 await run.desk.receive(from('3','/project'));assert.match(run.sent.at(-1)!,/^1\. Second \(current\)\n2\. First\n/);
 await run.desk.receive(from('4','/project 2'));assert.equal(run.settings().chatId,'c1');
 await run.desk.receive(from('5','next task'));assert.deepEqual(run.submitted.at(-1),['telegram-4242-5','c1','next task']);
 await run.desk.receive(from('6','/yolo'));assert.equal(run.sent.at(-1),'That command is not available from Telegram.');
 await run.desk.receive(from('7','/pause'));await run.desk.receive(from('8','blocked task'));
 assert.equal(run.submitted.length,2);assert.match(run.sent.at(-1)!,/paused/);assert.equal(run.alerts.at(-1),'Remote task: blocked task','a blocked task still gets its alert');
});

test('while an approval is shown, only a code or Deny answers it; a code never reaches a chat',async()=>{
 const codes:string[]=[];let denied=0;
 const run=desk({waiting:()=>'approval',code:async code=>{codes.push(code);return 'Approved.';},deny:async()=>{denied++;return 'Denied.';}});
 await run.desk.receive(from('1','123456'));assert.deepEqual(codes,['123456']);assert.equal(run.sent.at(-1),'Approved.');
 await run.desk.receive(from('2','do something else'));assert.equal(run.sent.at(-1),'Reply with the code for the approval shown, or Deny.');
 await run.desk.receive(from('3','Deny'));assert.equal(denied,1);
 assert.deepEqual(run.submitted,[]);assert.equal(run.alerts.length,1,'the code is not a task');
 const idle=desk();await idle.desk.receive(from('1','123456'));assert.equal(idle.sent.at(-1),'No approval is waiting.');
});

test('replies name their model; secrets-list approvals are recognised',()=>{
 assert.equal(replyFor({status:'completed',text:'Done.'},'DeepSeek'),'Done.\n\nDeepSeek');
 assert.equal(replyFor({status:'failed',error:'No credit'},'x'),'Failed: No credit');
 assert.equal(secretApproval({description:'Access to protected credentials requires your approval.'}),true);
 assert.equal(secretApproval({description:'Access to private app data or credentials requires your approval. Use skills_list and skill_view for installed skills.'}),true,'the permissions plugin wording');
 assert.equal(secretApproval({description:'Run npm test',command:'npm test'}),false);
});

test("a message in a topic goes to that topic's chat and is answered there; an unknown topic gets a new chat",async()=>{
 const run=desk();
 await run.desk.receive({...from('1','in the topic'),thread_id:'55'});
 assert.deepEqual(run.submitted,[['telegram-4242-1','c1','in the topic','55']]);assert.deepEqual([run.sent.at(-1),run.threads.at(-1)],['Sent to First.','55']);
 await run.desk.receive({...from('2','/status'),thread_id:'55'});assert.deepEqual([run.sent.at(-1),run.threads.at(-1)],['First: Ready','55']);
 await run.desk.receive({...from('3','a topic made in Telegram'),thread_id:'77'});assert.deepEqual(run.submitted.at(-1),['telegram-4242-3','c9','a topic made in Telegram','77']);
 // A text in the bot chat's main view starts a new chat; a command there is about the chosen chat, as before.
 await run.desk.receive(from('4','no topic'));assert.deepEqual([run.submitted.at(-1),run.threads.at(-1)],[['telegram-4242-4','c3','no topic'],undefined]);
 await run.desk.receive(from('5','/status'));assert.equal(run.sent.at(-1),'Second: Ready');
 assert.equal(topicName({title:'Plan'}),'Plan');assert.equal(topicName({title:'Plan'},'⏳'),'⏳ Plan');assert.equal(topicName({title:'  '}),'New chat');assert.equal(topicName({title:'x'.repeat(300)}).length,128);
 assert.equal(topicLink('ghidora_bot','55'),'https://t.me/ghidora_bot/55');assert.equal(topicLink('','55'),'');
});

// 2026-11-01: two messages typed in an existing topic arrived as replies and were refused as late answers.
test('a reply is a message; only a reply to an old question or approval is refused',async()=>{
 const run=desk({prompt:id=>id==='900'});
 await run.desk.receive({...from('1','typed in the topic'),thread_id:'55',reply_to_message_id:'300'});
 assert.deepEqual(run.submitted,[['telegram-4242-1','c1','typed in the topic','55']]);assert.deepEqual([run.sent.at(-1),run.threads.at(-1)],['Sent to First.','55']);
 await run.desk.receive({...from('2','a reply outside a topic'),reply_to_message_id:'301'});assert.deepEqual(run.submitted.at(-1),['telegram-4242-2','c3','a reply outside a topic']);
 await run.desk.receive({...from('3','yes'),thread_id:'55',reply_to_message_id:'900'});
 assert.equal(run.submitted.length,2,'a late answer starts no task');assert.match(run.sent.at(-1)!,/no longer waiting for a reply/);
 const store=new Store(':memory:');
 enqueueRemote(store,'4242','Approval needed','a1',true);enqueueRemote(store,'4242','a reply');
 for(const seq of [1,2]){claimRemoteOutbox(store,seq-1,'4242');recordRemoteReceipt(store,seq,true,String(899+seq));}
 assert.deepEqual([remotePrompt(store,'900'),remotePrompt(store,'901'),remotePrompt(store,'5')],[true,false,false]);
});

test("a row for a chat's topic waits for the topic, goes into it, and is dropped if the topic was never made",()=>{
 const store=new Store(':memory:');
  store.put<TopicRecord>('remote-topic',{id:'c1',name:'First',status:'creating',created:0});
  enqueueRemote(store,'4242','First',undefined,false,{op:'topic',topicChat:'c1'});enqueueRemote(store,'4242','copied',undefined,false,{topicChat:'c1'});enqueueRemote(store,'4242','lost',undefined,false,{topicChat:'c2'});
  assert.deepEqual(claimRemoteOutbox(store,0,'4242'),[{seq:1,chat_id:'4242',text:'First',op:'topic'}],'the topic is made first');
  store.update<TopicRecord>('remote-topic','c1',{status:'ready',threadId:'55'});
  assert.deepEqual(claimRemoteOutbox(store,1,'4242'),[{seq:2,chat_id:'4242',text:'copied',thread_id:'55'}]);
  assert.deepEqual(claimRemoteOutbox(store,2,'4242'),[],'no topic for c2: the row is cancelled, not sent to the main chat');
  assert.equal(store.get<any>('remote-out','3').status,'cancelled');
});

// Koan 2026-11-19, version 3 of the Telegram mockup: one thread per chat, made with the chat's name.
test('a chat gets its thread once it is named, the oldest used first; a gone chat loses its thread',()=>{
 const chats=[{id:'new',title:'KOAN shader 3',used:300,named:true},{id:'old',title:'bodeverse archive',used:100,named:true},{id:'raw',title:'So I have a new idea for a shader for KOAN.live. T',used:200,named:false}];
 assert.deepEqual(planTopics(chats,[],0),[{do:'plan',chatId:'old'},{do:'create',chatId:'old',name:'bodeverse archive'},{do:'plan',chatId:'raw'},{do:'plan',chatId:'new'},{do:'create',chatId:'new',name:'KOAN shader 3'}],'the unnamed chat waits for its name');
 const topics:TopicRecord[]=[{id:'old',threadId:'55',name:'bodeverse archive',status:'ready',created:0},{id:'raw',name:'',status:'pending',created:0},{id:'new',name:'KOAN shader 3',status:'creating',created:0},
  {id:'deleted',threadId:'60',name:'Testing',status:'ready',created:0},{id:'never',name:'',status:'pending',created:0},{id:'making',name:'x',status:'creating',created:0},{id:'going',threadId:'61',name:'y',status:'deleting',created:0}];
 assert.deepEqual(planTopics(chats,topics,0),[{do:'delete',id:'deleted',thread:'60'},{do:'delete',id:'never'}],'nothing is made twice; a thread on its way out or in is left alone');
 // The name follows the app's, with the chat's state in front when it has one.
 assert.deepEqual(planTopics([{...chats[1],title:'Archive'}],topics.slice(0,1),0),[{do:'rename',chatId:'old',thread:'55',name:'Archive'}]);
 assert.deepEqual(planTopics([chats[1]],topics.slice(0,1),0,()=>'⏳'),[{do:'rename',chatId:'old',thread:'55',name:'⏳ bodeverse archive'}]);
 // A thread Telegram refused is tried again when its time comes.
 const failed:TopicRecord={id:'old',name:'bodeverse archive',status:'failed',created:0,tries:2,retryAt:5000};
 assert.deepEqual(planTopics([chats[1]],[failed],4999),[]);assert.deepEqual(planTopics([chats[1]],[failed],5000),[{do:'create',chatId:'old',name:'bodeverse archive'}]);
 assert.deepEqual([1,2,3,4,9].map(tries=>topicRetry(tries,0)/60000),[1,3,9,27,30]);
});

test('a chat he has not named gets a short name; no two chats share one',()=>{
 const first='So I have a new idea for a shader for KOAN.live. The idea is that it takes the depth map';
 assert.equal(autoTitled({title:first.slice(0,55)},first),true);assert.equal(autoTitled({title:'New chat'},undefined),true);
 assert.equal(autoTitled({title:'bodeverse archive'},first),false,'a name he typed');assert.equal(autoTitled({title:first.slice(0,55),named:'user'},first),false);assert.equal(autoTitled({title:'Fix (fork)'},'Fix'),false);
 assert.equal(cleanName('"KOAN shader."\nIt is about a shader.'),'KOAN shader');assert.equal(cleanName('Name: **Depth map shader**'),'Depth map shader');
 assert.equal(cleanName('A very long name that goes on and on past the limit'),'A very long name that goes');assert.equal(cleanName('  \n '),'');
 assert.equal(fallbackName(first),'So I have a new idea for');assert.equal(fallbackName('???'),'New chat');
 assert.equal(uniqueName('KOAN shader',['Testing','gAIt']),'KOAN shader');assert.equal(uniqueName('KOAN shader',['koan shader','KOAN shader 2']),'KOAN shader 3');
});

test("a row waits while its chat's thread is being made; a reply with no thread to be had goes to the main view",()=>{
 const store=new Store(':memory:');
 store.put<TopicRecord>('remote-topic',{id:'c1',name:'',status:'pending',created:0});
 assert.deepEqual(chatPlace(store,'c1','9'),{topicChat:'c1',fallback:true});assert.deepEqual(chatPlace(store,'c2','9'),{thread_id:'9'});assert.deepEqual(chatPlace(store,'c2'),{});
 enqueueRemote(store,'4242','the reply',undefined,false,chatPlace(store,'c1'));enqueueRemote(store,'4242','elsewhere');
 assert.deepEqual(claimRemoteOutbox(store,0,'4242'),[{seq:2,chat_id:'4242',text:'elsewhere'}],'the later row goes first; the reply keeps waiting');
 assert.deepEqual(claimRemoteOutbox(store,2,'4242'),[]);assert.equal(store.get<any>('remote-out','1').status,'pending');
 store.update<TopicRecord>('remote-topic','c1',{status:'ready',threadId:'55'});
 assert.deepEqual(claimRemoteOutbox(store,2,'4242'),[{seq:1,chat_id:'4242',text:'the reply',thread_id:'55'}],'handed over although a later row went before it');
 store.update<TopicRecord>('remote-topic','c1',{status:'failed',threadId:undefined});
 enqueueRemote(store,'4242','a second reply',undefined,false,chatPlace(store,'c1'));enqueueRemote(store,'4242','a copy of desktop work',undefined,false,{topicChat:'c1'});
 assert.deepEqual(claimRemoteOutbox(store,0,'4242'),[{seq:3,chat_id:'4242',text:'a second reply'}]);
 assert.deepEqual(claimRemoteOutbox(store,0,'4242'),[]);assert.equal(store.get<any>('remote-out','4').status,'cancelled');
 // Buttons and sound travel with the row.
 enqueueRemote(store,'4242','New chat: Plan',undefined,false,{notify:true,keys:[[{text:'Open Plan',url:'https://t.me/bot/55'}]]});
 assert.deepEqual(claimRemoteOutbox(store,0,'4242'),[{seq:5,chat_id:'4242',text:'New chat: Plan',notify:true,keys:[[{text:'Open Plan',url:'https://t.me/bot/55'}]]}]);
});

test('old settled rows go; a question or approval the app sent is kept, and so is the newest row',()=>{
 const store=new Store(':memory:');
 enqueueRemote(store,'4242','Approval needed','a1',true);for(let n=0;n<6;n++)enqueueRemote(store,'4242','row '+n);
 for(const seq of [1,2,3,4,5,6]){claimRemoteOutbox(store,0,'4242');recordRemoteReceipt(store,seq,true,String(900+seq));}
 assert.equal(pruneRemoteOutbox(store,3),3);assert.deepEqual(store.all<any>('remote-out').map(row=>row.seq).sort(),[1,5,6,7]);
 assert.equal(remotePrompt(store,'901'),true);assert.equal(enqueueRemote(store,'4242','next').seq,8,'the sequence carries on');
});
