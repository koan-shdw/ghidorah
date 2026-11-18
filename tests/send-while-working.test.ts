import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {runningReply,sendsNow,waitsItsTurn} from '../app/send-now';

// Exercise the real main and split/pop-out handlers without launching the app.
const source=ts.createSourceFile('ui.tsx',fs.readFileSync('app/ui.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function handler(name:string,environment:Record<string,unknown>){
 let code='';
 const visit=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)code=node.getText(source);ts.forEachChild(node,visit);};visit(source);
 assert.ok(code,name);
 return new Function(...Object.keys(environment),ts.transpile(code,{target:ts.ScriptTarget.ES2022})+'\nreturn '+name)(...Object.values(environment));
}
const world=(extra:Record<string,unknown>={})=>{const sent:{method:string;args:any}[]=[];return {sent,env:{sending:{current:false},otherEditor:false,chat:{attachments:[] as object[]},draft:'Additional direction',busy:false,state:{availableModels:['gpt-6-astra']},working:true,ordinary:true,chatId:'chat',editorRevision:{current:0},draftEdits:{current:0},drafts:{flush:()=>{}},setBusy:()=>{},setDraft:()=>{},sendsNow,sendNowOn:false,call:async(method:string,args:any)=>{sent.push({method,args});},...extra}};};

test('with the chat\'s Send now switch off, a send waits its turn during work; the other action stops and sends',async()=>{
 for(const name of ['submit','correct']){
  const {sent,env}=world();
  await handler(name,env)();
  assert.equal(sent.pop()?.method,'submit',name+' must keep the running reply alive');
  await handler(name,env)(...(name==='submit'?[undefined,false]:[false]));
  assert.equal(sent.pop()?.method,'correctGroup',name+' keeps the explicit Send now');
  env.draft='';env.chat.attachments=[{id:'image'}];await handler(name,env)();
  assert.equal(sent.pop()?.method,'submit','Image-only messages also wait');
  env.draft='Normal message';env.working=false;await handler(name,env)();
  assert.equal(sent.pop()?.method,'submit','Idle sends still submit normally');
  env.sending.current=true;await handler(name,env)();assert.equal(sent.length,0,'Duplicate send is suppressed');
 }
});
test('with the switch on, Enter stops the reply and sends, the other action waits, and "??" and "/" never stop it',async()=>{
 for(const name of ['submit','correct']){
  const {sent,env}=world({sendNowOn:true}),other=name==='submit'?[undefined,false]:[false];
  await handler(name,env)();assert.equal(sent.pop()?.method,'correctGroup',name+': Enter sends now');
  await handler(name,env)(...other);assert.equal(sent.pop()?.method,'submit',name+': the other action waits its turn');
  for(const text of ['?? how is it going','  ??status','/compact','/skill run']){env.draft=text;
   await handler(name,env)();assert.equal(sent.pop()?.method,'submit',name+': '+text+' keeps its own path');
   await handler(name,env)(...other);assert.equal(sent.pop()?.method,'submit',name+': '+text+' with the other action too');}
  env.draft='Normal message';env.working=false;await handler(name,env)();assert.equal(sent.pop()?.method,'submit','with nothing running there is nothing to stop');
 }
});
test('a waiting message and the running reply are told apart from the turns alone',()=>{
 const turn=(id:string,extra:object)=>({id,chatId:'c',created:1,model:'m',prompt:'',text:'',reasoning:'',status:'running',error:null,usage:null,...extra}) as any;
 const reply=turn('reply',{}),sent=turn('sent',{delivery:'sent'}),queued=turn('queued',{status:'queued'}),agent=turn('agent',{automatic:{kind:'agent'}}),job=turn('job',{parentTurnId:'reply'}),read=turn('read',{answeredIn:'reply'});
 assert.deepEqual([reply,sent,queued,agent,job,turn('done',{status:'completed'}),turn('model',{status:'needs-model'})].map(waitsItsTurn),[false,true,true,false,false,false,false]);
 assert.equal(runningReply([agent,job,sent,queued,read,reply]),'reply');assert.equal(runningReply([sent,queued,turn('done',{status:'completed'})]),null);
 assert.equal(runningReply([turn('stopping',{status:'stopping'})]),'stopping');
 assert.deepEqual([sendsNow('x',true,false,false),sendsNow('x',true,false,true),sendsNow('x',true,true,false),sendsNow('x',true,true,true),sendsNow('x',false,true,false),sendsNow('??x',true,true,false),sendsNow('/x',true,false,true)],[false,true,true,false,false,false,false]);
});
