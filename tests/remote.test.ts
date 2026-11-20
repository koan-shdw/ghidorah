import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AWAY_SECONDS,GLYPH,homeCard,planCard,settledGlyph,sounds,readRemote,readInbound,readEvent,parseRequest,remoteTurnId,gateChannel,GatewaySupervisor,RemoteDesk,replyFor,replyShare,markFor,draftId,draftText,secretApproval,clip,topicName,topicLink,type DeskDeps} from '../app/remote';
import {Store} from '../app/store';
import {cardReceipt,chatPlace,claimRemoteOutbox,enqueueRemote,enqueueRemoteReply,pruneRemoteOutbox,recordRemoteReceipt,remotePrompt,setCard,type CardRecord,type TopicRecord} from '../app/remote-outbox';
import {autoTitled,cleanName,fallbackName,planTopics,topicRetry,uniqueName} from '../app/remote-threads';

test('only the owner\'s direct message is read; a code, Deny and the safe commands are told apart',()=>{
 assert.deepEqual(readRemote({enabled:true,owner:'4242',chatId:'c1'}),{enabled:true,owner:'4242',chatId:'c1',paused:false,topics:true,topicsSince:null,topicError:'',username:'',stateIcon:true});
 assert.equal(readRemote({stateIcon:false}).stateIcon,false);
 assert.equal(readRemote({username:'demo_bot'}).username,'demo_bot');assert.equal(readRemote({username:'not a name'}).username,'');
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

// Live (Koan 2026-11-19): the reply shows in its thread while it is written, with Stop.
test('draft frames wait on the channel like rows; a press or a Stop is handed over and answered',async()=>{
 let frames:any[]=[];const events:any[]=[];
 const channel=await gateChannel({inbound:async()=>{},ready:()=>{},outbox:()=>[],sent:()=>{},live:after=>frames.filter(frame=>frame.n>after),event:async value=>{events.push(value);return {text:'Stopped.'};}});
 const call=(path:string,body?:unknown)=>fetch(channel.connection.url+path.replace(/^\//,''),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+channel.connection.token},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  const waiting=call('/live?after=0').then(response=>response.json());
  await new Promise(resolve=>setTimeout(resolve,100));frames=[{n:1,chat_id:'4242',thread_id:'55',draft_id:7,text:'Yes, agents',stop:'gh:stop:c1'}];channel.notify();
  assert.deepEqual(await waiting,frames);
  assert.deepEqual(await (await call('/event',{type:'button',data:'gh:stop:c1'})).json(),{ok:true,text:'Stopped.'});assert.deepEqual(events,[{type:'button',data:'gh:stop:c1'}]);
  assert.equal((await call('/live?after=x')).status,400);
 }finally{channel.close();}
 assert.deepEqual(readEvent({type:'stopped',draft_id:7,thread_id:'55'}),{type:'stopped',draft_id:7,thread_id:'55'});
 assert.deepEqual(readEvent({type:'button',data:'gh:stop:3f0c8d2e-1b7a-4c55-9d1e-6a2b4c8e0f11',message_id:'900'}),{type:'button',data:'gh:stop:3f0c8d2e-1b7a-4c55-9d1e-6a2b4c8e0f11',message_id:'900'});
 for(const bad of [null,{type:'stopped',draft_id:'7'},{type:'button',data:'ea:once:1'},{type:'button',data:'gh:stop:c1',thread_id:55},{type:'button',data:'gh:'+'x'.repeat(70)},{type:'other'}])assert.equal(readEvent(bad),null);
 // One answer keeps one draft id from its first frame to its last; a long reply shows its end.
 assert.equal(draftId('t1:0'),draftId('t1:0'));assert.notEqual(draftId('t1:0'),draftId('t1:1'));assert.ok(draftId('')>0&&Number.isSafeInteger(draftId('telegram-4242-1017:2')));
 assert.equal(draftText('  short  '),'short');const long=draftText('a'.repeat(3000)+'b'.repeat(3000));assert.equal(long.length,3800);assert.ok(long.startsWith('…')&&long.endsWith('b'));
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
 const sent:string[]=[],threads:(string|undefined)[]=[],alerts:string[]=[],submitted:any[]=[],seen=new Set<string>();let settings={enabled:true,owner:'4242',chatId:null as string|null,paused:false,topics,topicsSince:null as number|null,topicError:'',username:'',stateIcon:true};
 const marks:string[][]=[];
 const deps:DeskDeps={settings:()=>settings,save:patch=>{settings={...settings,...patch};},seen:id=>seen.has(id),done:id=>{seen.add(id);},send:(text,_deny,thread)=>{sent.push(text);threads.push(thread);},mark:(id,emoji)=>{marks.push([id,emoji]);},alert:(title,body)=>{alerts.push(title+': '+body);},
  chats:()=>[{id:'c2',title:'Second'},{id:'c1',title:'First'}],newChat:async()=>'c3',topicChat:thread=>thread==='55'?{id:'c1',title:'First'}:null,linkTopic:async()=>({id:'c9',title:'New chat'}),submit:async(id,chatId,text,thread,attachments)=>{submitted.push([id,chatId,text,...(thread?[thread]:[]),...(attachments?.length?[attachments.map(item=>item.name)]:[])]);},stop:async()=>{},status:()=>'Ready',
  hear:async file=>file.endsWith('quiet.ogg')?'  ':'Which files changed today?',attach:async(_chatId,media)=>media.map(item=>({name:item.name||'IMG_2041.jpg'})),
  waiting:()=>null,prompt:()=>false,code:async()=>'Approved.',deny:async()=>'Denied.',answer:async()=>'Answered.',...overrides};
 return {desk:new RemoteDesk(deps),sent,threads,alerts,submitted,marks,settings:()=>settings};
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
 assert.deepEqual(run.submitted,[['telegram-4242-1','c2','fix the build']]);assert.deepEqual(run.sent,['Sent to Second.']);assert.deepEqual(run.marks,[['1','👀']]);assert.equal(run.alerts.length,1);
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

// Version 3 of the Telegram mockup: a voice note or a photo goes into the chat.
test('a voice note becomes his message and he is shown what was heard; a photo or a file goes in as an attachment',async()=>{
 const run=desk(),voice=(path:string)=>({path,kind:'voice' as const});
 await run.desk.receive({...from('1',''),thread_id:'55',media:[voice('C:/g/cache/note.ogg')]});
 assert.deepEqual(run.sent,['Heard: “Which files changed today?”']);assert.deepEqual(run.threads,['55']);
 assert.deepEqual(run.submitted,[['telegram-4242-1','c1','Which files changed today?','55']]);assert.deepEqual(run.marks,[['1','👀']]);assert.equal(run.alerts.at(-1),'Remote task: Voice note');
 await run.desk.receive({...from('2','use this as the cover'),thread_id:'55',media:[{path:'C:/g/cache/1.jpg',kind:'photo'},{path:'C:/g/cache/brief.pdf',kind:'file',name:'brief.pdf'}]});
 assert.equal(run.sent.at(-1),'Added to the chat: IMG_2041.jpg, brief.pdf');
 assert.deepEqual(run.submitted.at(-1),['telegram-4242-2','c1','use this as the cover','55',['IMG_2041.jpg','brief.pdf']]);
 // A photo with no words is a message too; one sent in the main view starts a new chat, as a text does.
 await run.desk.receive({...from('3',''),media:[{path:'C:/g/cache/2.jpg',kind:'photo'}]});assert.deepEqual(run.submitted.at(-1),['telegram-4242-3','c3','',['IMG_2041.jpg']]);
 // Nothing heard: nothing is sent on, and he is told.
 await run.desk.receive({...from('4',''),thread_id:'55',media:[voice('C:/g/cache/quiet.ogg')]});
 assert.equal(run.submitted.length,3);assert.deepEqual(run.marks.at(-1),['4','👎']);assert.equal(run.sent.at(-1),'Not sent: Nothing was heard in the voice note.');
 const message={message_id:'17',chat_id:'4242',user_id:'4242',text:''};
 assert.deepEqual(readInbound({...message,media:[{path:'C:/g/cache/note.ogg',kind:'voice'}]},'4242')?.media,[{path:'C:/g/cache/note.ogg',kind:'voice'}]);
 for(const bad of [[],[{path:'',kind:'voice'}],[{path:'x',kind:'video'}],[{path:'x',kind:'file',name:'a/b.pdf'}],Array.from({length:11},()=>({path:'x',kind:'photo'})),'x'])assert.equal(readInbound({...message,media:bad},'4242'),null);
});

test('a message that cannot be sent on gets the failed mark and the reason',async()=>{
 const run=desk({submit:async()=>{throw Error('Wait for the connection update to finish.');}});
 await run.desk.receive({...from('1','now'),thread_id:'55'});
 assert.deepEqual(run.marks,[['1','👎']]);assert.deepEqual(run.sent,['Not sent: Wait for the connection update to finish.']);assert.match(run.alerts.at(-1)!,/^Remote task failed/);
});

// Read from his data 2026-11-19: a text Claude read in the middle of another reply was answered "(no text)".
test('a message read in the middle of a reply is answered by its share of that reply',()=>{
 const text='I am reading the folders.\n\nThree files changed today.\n\nYou asked about the folders and I read them.',owner={id:'t1',text};
 const second=text.indexOf('Three'),third=text.indexOf('You asked');
 const joined=[{id:'t3',created:3,readAt:{text:third}},{id:'t2',created:2,readAt:{text:second}}];
 assert.equal(replyShare(owner,'t1',joined),'I am reading the folders.');
 assert.equal(replyShare(owner,'t2',joined),'Three files changed today.');
 assert.equal(replyShare(owner,'t3',joined),'You asked about the folders and I read them.');
 assert.equal(replyShare(owner,'t1',[]),text,'a reply nothing was read in is whole');assert.equal(replyShare(owner,'t9',joined),'');
 // Two messages read at the same point: the later one carries the answer, the earlier one's share is empty.
 const same=[{id:'t2',created:2,readAt:{text:second}},{id:'t3',created:3,readAt:{text:second}}];
 assert.equal(replyShare(owner,'t2',same),'');assert.equal(replyShare(owner,'t3',same),text.slice(second));
 // Claude's final message replaced the streamed text, so the points were reset: the last message read carries it all.
 const reset=[{id:'t2',created:2,readAt:{text:0}},{id:'t3',created:3,readAt:{text:0}}];
 assert.deepEqual([replyShare(owner,'t1',reset),replyShare(owner,'t2',reset),replyShare(owner,'t3',reset)],['','',text]);
 assert.deepEqual(['completed','partial','stopped','failed','interrupted'].map(markFor),['👍','👍','','👎','👎']);
});

test('replies name their model and are never cut; secrets-list approvals are recognised',()=>{
 assert.equal(replyFor({status:'completed',text:'Done.'},'DeepSeek'),'Done.\n\nDeepSeek');
 assert.equal(replyFor({status:'completed',text:'x'.repeat(9000)},'DeepSeek').length,9010,'a long reply goes whole; the gateway splits it into messages');
 assert.equal(replyFor({status:'failed',error:'No credit'},'x'),'Failed: No credit');
 assert.equal(secretApproval({description:'Access to protected credentials requires your approval.'}),true);
 assert.equal(secretApproval({description:'Access to private app data or credentials requires your approval. Use skills_list and skill_view for installed skills.'}),true,'the permissions plugin wording');
 assert.equal(secretApproval({description:'Run npm test',command:'npm test'}),false);
});

test("a message in a topic goes to that topic's chat and is answered there; an unknown topic gets a new chat",async()=>{
 const run=desk();
 await run.desk.receive({...from('1','in the topic'),thread_id:'55'});
 // The mark on his text says the app has it; no "Sent to" line any more.
 assert.deepEqual(run.submitted,[['telegram-4242-1','c1','in the topic','55']]);assert.deepEqual(run.sent,[]);assert.deepEqual(run.marks,[['1','👀']]);
 await run.desk.receive({...from('2','/status'),thread_id:'55'});assert.deepEqual([run.sent.at(-1),run.threads.at(-1)],['First: Ready','55']);
 await run.desk.receive({...from('3','a topic made in Telegram'),thread_id:'77'});assert.deepEqual(run.submitted.at(-1),['telegram-4242-3','c9','a topic made in Telegram','77']);
 // A text in the bot chat's main view starts a new chat; a command there is about the chosen chat, as before.
 await run.desk.receive(from('4','no topic'));assert.deepEqual([run.submitted.at(-1),run.marks.at(-1)],[['telegram-4242-4','c3','no topic'],['4','👀']]);
 await run.desk.receive(from('5','/status'));assert.equal(run.sent.at(-1),'Second: Ready');
 assert.equal(topicName({title:'Plan'}),'Plan');assert.equal(topicName({title:'Plan'},'⏳'),'⏳ Plan');assert.equal(topicName({title:'  '}),'New chat');assert.equal(topicName({title:'x'.repeat(300)}).length,128);
 assert.equal(topicLink('demo_bot','55'),'https://t.me/demo_bot/55');assert.equal(topicLink('','55'),'');
});

// 2026-11-01: two messages typed in an existing topic arrived as replies and were refused as late answers.
test('a reply is a message; only a reply to an old question or approval is refused',async()=>{
 const run=desk({prompt:id=>id==='900'});
 await run.desk.receive({...from('1','typed in the topic'),thread_id:'55',reply_to_message_id:'300'});
 assert.deepEqual(run.submitted,[['telegram-4242-1','c1','typed in the topic','55']]);assert.deepEqual(run.marks.at(-1),['1','👀']);
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
 const chats=[{id:'new',title:'Paint tool 3',used:300,named:true},{id:'old',title:'photo archive',used:100,named:true},{id:'raw',title:'I want a new brush for the paint tool. The idea is',used:200,named:false}];
 assert.deepEqual(planTopics(chats,[],0),[{do:'plan',chatId:'old'},{do:'create',chatId:'old',name:'photo archive'},{do:'plan',chatId:'raw'},{do:'plan',chatId:'new'},{do:'create',chatId:'new',name:'Paint tool 3'}],'the unnamed chat waits for its name');
 const topics:TopicRecord[]=[{id:'old',threadId:'55',name:'photo archive',status:'ready',created:0},{id:'raw',name:'',status:'pending',created:0},{id:'new',name:'Paint tool 3',status:'creating',created:0},
  {id:'deleted',threadId:'60',name:'Testing',status:'ready',created:0},{id:'never',name:'',status:'pending',created:0},{id:'making',name:'x',status:'creating',created:0},{id:'going',threadId:'61',name:'y',status:'deleting',created:0}];
 assert.deepEqual(planTopics(chats,topics,0),[{do:'delete',id:'deleted',thread:'60'},{do:'delete',id:'never'}],'nothing is made twice; a thread on its way out or in is left alone');
 // The name follows the app's, with the chat's state in front when it has one.
 assert.deepEqual(planTopics([{...chats[1],title:'Archive'}],topics.slice(0,1),0),[{do:'rename',chatId:'old',thread:'55',name:'Archive'}]);
 assert.deepEqual(planTopics([chats[1]],topics.slice(0,1),0,()=>'⏳'),[{do:'rename',chatId:'old',thread:'55',name:'⏳ photo archive'}]);
 // A thread Telegram refused is tried again when its time comes.
 const failed:TopicRecord={id:'old',name:'photo archive',status:'failed',created:0,tries:2,retryAt:5000};
 assert.deepEqual(planTopics([chats[1]],[failed],4999),[]);assert.deepEqual(planTopics([chats[1]],[failed],5000),[{do:'create',chatId:'old',name:'photo archive'}]);
 assert.deepEqual([1,2,3,4,9].map(tries=>topicRetry(tries,0)/60000),[1,3,9,27,30]);
});

test('a chat he has not named gets a short name; no two chats share one',()=>{
 const first='I want a new brush for the paint tool. The idea is that it reads the pen pressure';
 assert.equal(autoTitled({title:first.slice(0,55)},first),true);assert.equal(autoTitled({title:'New chat'},undefined),true);
 assert.equal(autoTitled({title:'photo archive'},first),false,'a name he typed');assert.equal(autoTitled({title:first.slice(0,55),named:'user'},first),false);assert.equal(autoTitled({title:'Fix (fork)'},'Fix'),false);
 assert.equal(cleanName('"Paint tool."\nIt is about a brush.'),'Paint tool');assert.equal(cleanName('Name: **Pen pressure brush**'),'Pen pressure brush');
 assert.equal(cleanName('A very long name that goes on and on past the limit'),'A very long name that goes');assert.equal(cleanName('  \n '),'');
 assert.equal(fallbackName(first),'I want a new brush for');assert.equal(fallbackName('???'),'New chat');
 assert.equal(uniqueName('Paint tool',['Testing','Walker']),'Paint tool');assert.equal(uniqueName('Paint tool',['paint tool','Paint tool 2']),'Paint tool 3');
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

// Version 3 of the Telegram mockup: the chat's state on its thread's icon, Home, the plan as a checklist.
test('Home lists what needs him, what works and what is held, with a link to each thread',()=>{
 const card=homeCard([{state:'working',title:'photo archive',agents:3,thread:'2625'},{state:'needs',title:'Paint tool 2',agents:0,thread:'2630'},{state:'held',title:'Walker',agents:0,until:'22:30'}],'Limit 61% used, resets 22:30','demo_bot');
 assert.equal(card.text,'Ghidorah now · 1 working, 1 needs you, 1 held\n❗ Paint tool 2 · needs you\n⏳ photo archive · working, 3 agents\n⏸ Walker · held until 22:30\n· Limit 61% used, resets 22:30');
 assert.deepEqual(card.keys,[[{text:'Paint tool 2',url:'https://t.me/demo_bot/2630'},{text:'photo archive',url:'https://t.me/demo_bot/2625'}],[{text:'New chat',data:'gh:new',style:'primary'}]],'a chat without a thread yet has no link');
 const idle=homeCard([],'','');assert.equal(idle.text,'Ghidorah now · nothing running');assert.deepEqual(idle.keys,[[{text:'New chat',data:'gh:new',style:'primary'}]]);
 assert.equal(homeCard([{state:'needs',title:'a',agents:0},{state:'needs',title:'b',agents:1}],'','').text,'Ghidorah now · 2 need you\n❗ a · needs you\n❗ b · needs you, 1 agent');
});

test('the plan is a checklist; a dropped step is left out and a finished reply says how far it got',()=>{
 const steps=[{content:'Read the overview',status:'completed'},{content:'Start three\n  Opus readers',status:'completed'},{content:'Collect what they save',status:'in_progress'},{content:'Write the index',status:'pending'},{content:'Dropped',status:'cancelled'}];
 assert.equal(planCard(steps),'Plan\n✓ Read the overview\n✓ Start three Opus readers\n▸ Collect what they save\n· Write the index');
 assert.equal(planCard(steps,true).split('\n')[0],'Plan · 2 of 4 steps done');
 const many=planCard(Array.from({length:45},(_,index)=>({content:'Step '+index,status:'pending'})));assert.equal(many.split('\n').length,42);assert.match(many,/… and 5 more$/);
});

test("a chat's state mark waits until the state has held, and does not flap; needing him shows at once",()=>{
 let memory=settledGlyph(undefined,'⏳',0);assert.equal(memory.shown,'','working for a moment is not yet shown');
 memory=settledGlyph(memory,'⏳',3999);assert.equal(memory.shown,'');
 memory=settledGlyph(memory,'⏳',4000);assert.equal(memory.shown,'⏳');
 // The reply ends and the next starts within seconds: the mark stays.
 memory=settledGlyph(memory,'',5000);memory=settledGlyph(memory,'⏳',6000);memory=settledGlyph(memory,'⏳',12000);assert.equal(memory.shown,'⏳');assert.equal(memory.changed,4000,'no rename happened');
 // It ends for good: the mark goes once that has held and the last change is long enough ago.
 memory=settledGlyph(memory,'',13000);memory=settledGlyph(memory,'',17000);assert.equal(memory.shown,'⏳','too soon after the last change');
 memory=settledGlyph(memory,'',19000);assert.equal(memory.shown,'');
 memory=settledGlyph(memory,'❗',19500);assert.equal(memory.shown,'❗','an approval waits: at once');
 assert.deepEqual([GLYPH.working,GLYPH.needs,GLYPH.held],['⏳','❗','⏸']);
});

test('a message sounds only when work has ended or it needs him, and never while he is at the PC',()=>{
 assert.deepEqual([sounds('ended',AWAY_SECONDS),sounds('needs',AWAY_SECONDS+900),sounds('note',AWAY_SECONDS+900)],[true,true,false]);
 assert.deepEqual([sounds('ended',AWAY_SECONDS-1),sounds('needs',0),sounds('note',0)],[false,false,false],'a key press or a mouse move in the last five minutes: he is at the PC');
 // The reply to a text carries the sound with it; a row without it arrives silently.
 const store=new Store(':memory:');
 store.put<any>('turn',{id:'telegram-4242-7',chatId:'c1',prompt:'hi',text:'Done.',reasoning:'',status:'completed',model:'m',error:null,usage:null,created:1,remote:{chatId:'4242',messageId:'telegram-4242-7',thread:'55'}});
 enqueueRemoteReply(store,'telegram-4242-7','Done.\n\nFable 5.2',true);
 assert.deepEqual(claimRemoteOutbox(store,0,'4242'),[{seq:1,chat_id:'4242',text:'Done.\n\nFable 5.2',thread_id:'55',notify:true}]);
 assert.equal(store.get<any>('turn','telegram-4242-7').remote.replied,true);assert.equal(enqueueRemoteReply(store,'telegram-4242-7','again',true),undefined,'a reply goes once');
});

// A card is one message kept current by editing it: the hold by the usage limit, the plan, Home.
test('a card is sent once, then edited; changes made while a row still waits are folded into it',()=>{
 const store=new Store(':memory:'),hand=()=>claimRemoteOutbox(store,0,'4242'),receipt=(seq:number,ok=true,id?:string,gone=false)=>cardReceipt(store,'4242',recordRemoteReceipt(store,seq,ok,id),gone);
 const card=()=>store.all<CardRecord>('remote-card').find(row=>row.id==='hold:c1');
 const drop=[[{text:'Don’t carry on',data:'gh:drop:c1',style:'danger' as const}]];
 assert.equal(setCard(store,'4242','hold:c1',{text:'Resets at 22:30. 1 message',keys:drop},{thread_id:'55'}),true);
 assert.equal(setCard(store,'4242','hold:c1',{text:'Resets at 22:30. 1 message',keys:drop},{thread_id:'55'}),false,'nothing changed: nothing is sent');
 assert.equal(setCard(store,'4242','hold:c1',{text:'Resets at 22:30. 2 messages',keys:drop},{thread_id:'55'}),true);
 assert.deepEqual(hand(),[{seq:1,chat_id:'4242',text:'Resets at 22:30. 2 messages',thread_id:'55',keys:drop}],'the row that had not left took the newer words');
 // A change while the first send is on its way: the receipt sees it and edits.
 setCard(store,'4242','hold:c1',{text:'Resets at 22:30. 3 messages',keys:drop},{thread_id:'55'});assert.deepEqual(hand(),[]);
 receipt(1,true,'900');assert.equal(card()!.messageId,'900');
 assert.deepEqual(hand(),[{seq:2,chat_id:'4242',text:'Resets at 22:30. 3 messages',op:'edit',message_id:'900',keys:drop}]);receipt(2);
 // Its last words: the buttons go and the record with them; the message stays.
 assert.equal(setCard(store,'4242','hold:c1',{text:'The limit reset at 22:30. Carrying on.'},{thread_id:'55'},true),true);assert.equal(card(),undefined);
 assert.deepEqual(hand(),[{seq:3,chat_id:'4242',text:'The limit reset at 22:30. Carrying on.',op:'edit',message_id:'900'}]);receipt(3);
 assert.equal(setCard(store,'4242','hold:c1',{text:'x'},{},true),false,'last words for a card that is not there send nothing');
 // A message that is gone in Telegram: the card is sent anew at its next change.
 setCard(store,'4242','home',{text:'Ghidorah now · 1 working'});assert.equal(hand()[0].seq,4);cardReceipt(store,'4242',recordRemoteReceipt(store,4,true,'901'),false);
 setCard(store,'4242','home',{text:'Ghidorah now · 2 working'});assert.equal(hand()[0].op,'edit');cardReceipt(store,'4242',recordRemoteReceipt(store,5,false),true);
 assert.equal(store.all<CardRecord>('remote-card').length,0);
 assert.equal(setCard(store,'4242','home',{text:'Ghidorah now · 2 working'}),true);assert.deepEqual(hand(),[{seq:6,chat_id:'4242',text:'Ghidorah now · 2 working'}]);
 // A card for a chat whose thread could not be made is dropped with its row, and made again later.
 store.put<TopicRecord>('remote-topic',{id:'c9',name:'x',status:'failed',created:0});
 setCard(store,'4242','hold:c9',{text:'Held'},{topicChat:'c9'});assert.deepEqual(hand(),[]);
 store.update<TopicRecord>('remote-topic','c9',{status:'ready',threadId:'77'});
 assert.equal(setCard(store,'4242','hold:c9',{text:'Held, 2'},{topicChat:'c9'}),true);assert.deepEqual(hand(),[{seq:8,chat_id:'4242',text:'Held, 2',thread_id:'77'}]);
});

test('old settled rows go; a question or approval the app sent is kept, and so is the newest row',()=>{
 const store=new Store(':memory:');
 enqueueRemote(store,'4242','Approval needed','a1',true);for(let n=0;n<6;n++)enqueueRemote(store,'4242','row '+n);
 for(const seq of [1,2,3,4,5,6]){claimRemoteOutbox(store,0,'4242');recordRemoteReceipt(store,seq,true,String(900+seq));}
 assert.equal(pruneRemoteOutbox(store,3),3);assert.deepEqual(store.all<any>('remote-out').map(row=>row.seq).sort(),[1,5,6,7]);
 assert.equal(remotePrompt(store,'901'),true);assert.equal(enqueueRemote(store,'4242','next').seq,8,'the sequence carries on');
});
