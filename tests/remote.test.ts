import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readRemote,readInbound,parseRequest,remoteTurnId,gateChannel,GatewaySupervisor,RemoteDesk,replyFor,secretApproval,clip,type DeskDeps} from '../app/remote';

test('only the owner\'s direct message is read; a code, Deny and the safe commands are told apart',()=>{
 assert.deepEqual(readRemote({enabled:true,owner:'4242',chatId:'c1'}),{enabled:true,owner:'4242',chatId:'c1',paused:false});
 assert.equal(readRemote({owner:'0123'}).owner,'',"an id can't start with 0");
 const message={message_id:'17',chat_id:'4242',user_id:'4242',text:'hello'};
 assert.deepEqual(readInbound(message,'4242'),message);
 for(const bad of [{...message,user_id:'99'},{...message,chat_id:'-100123'},{...message,message_id:'x'},{...message,text:7}])assert.equal(readInbound(bad,'4242'),null);
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

function desk(overrides:Partial<DeskDeps>={}){
 const sent:string[]=[],alerts:string[]=[],submitted:any[]=[],seen=new Set<string>();let settings={enabled:true,owner:'4242',chatId:null as string|null,paused:false};
 const deps:DeskDeps={settings:()=>settings,save:patch=>{settings={...settings,...patch};},seen:id=>seen.has(id),done:id=>{seen.add(id);},send:text=>{sent.push(text);},alert:(title,body)=>{alerts.push(title+': '+body);},
  chats:()=>[{id:'c2',title:'Second'},{id:'c1',title:'First'}],newChat:async()=>'c3',submit:async(id,chatId,text)=>{submitted.push([id,chatId,text]);},stop:async()=>{},status:()=>'Ready',
  waiting:()=>null,code:async()=>'Approved.',deny:async()=>'Denied.',answer:async()=>'Answered.',...overrides};
 return {desk:new RemoteDesk(deps),sent,alerts,submitted,settings:()=>settings};
}
const from=(id:string,text:string)=>({message_id:id,chat_id:'4242',user_id:'4242',text});

test('Telegram Start shows help once without sending its connection payload to a model',async()=>{
 const run=desk(),message=from('1','/start connection-proof');
 await run.desk.receive(message);await run.desk.receive(message);
 assert.equal(run.sent.length,1);assert.match(run.sent[0],/^\/help:/);assert.match(run.sent[0],/\/new:/);assert.ok(!run.sent[0].includes('connection-proof'));assert.deepEqual(run.submitted,[]);
 await run.desk.receive({...from('2','/start'),user_id:'99',chat_id:'99'});assert.equal(run.sent.length,1);
});

test('a message becomes one turn in the chosen chat; a repeated delivery does nothing; strangers are ignored',async()=>{
 const run=desk();
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
 assert.equal(secretApproval({description:'Run npm test',command:'npm test'}),false);
});
