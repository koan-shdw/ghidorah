import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {mainSource} from './fixtures/main-source';
import {limitPause,limitReset,pausePatch,pauseText,resumeDue} from '../app/limit-pause';
import {Store} from '../app/store';
import {blockedFor,type Availability} from '../app/availability';
import type {Turn} from '../app/types';

// Resume after the usage limit (Koan 2026-11-09): the main-process pieces that put a limit-stopped message to wait and send it again.
const source=mainSource();
function main(name:string,env:Record<string,unknown>){
 let node:ts.Node|undefined;const visit=(n:ts.Node)=>{if(ts.isFunctionDeclaration(n)&&n.name?.getText(source)===name)node=n;ts.forEachChild(n,visit);};visit(source);assert.ok(node);
 return new Function(...Object.keys(env),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(env));
}
const now=Date.now(),later=now+2*3600000;
const limitRow=(resetAt:number|null=later):Availability=>({id:'claude-code:rate:five_hour:account',provider:'claude-code',key:'rate:five_hour',scope:'account',blocked:true,reason:'limit',resetAt,observedAt:now});
const turn=(over:Partial<Turn>={}):Turn=>({id:'t1',chatId:'c1',prompt:'Go on',text:'',reasoning:'',status:'queued',model:'claude-code:opus',error:null,usage:null,created:now,...over});
const BEHIND='Waiting for a model for the message above',BEHIND_PAUSED='Waiting for the paused message above';

test('checkDispatch: a model blocked by a limit with a reset ahead pauses the message; anything else asks for a model as before',()=>{
  const updates:any[]=[],routes:any[]=[];
  const env=(rows:Availability[])=>({inputMismatch:()=>null,availableModels:()=>['deepseek-flash'],unavailableMessage:()=>'Usage limit reached',store:{transaction:(fn:()=>void)=>fn(),update:(_k:string,_id:string,patch:any)=>updates.push(patch)},recordRoute:(_id:string,decision:any)=>routes.push(decision),emit:()=>{},health:{rows:()=>rows},limitReset,pausePatch,pauseText});
  const chat:any={id:'c1',pool:['claude-code:opus']};
  assert.equal(main('checkDispatch',env([limitRow()]))(chat,turn()),false);
  assert.equal(updates[0].status,'queued');assert.deepEqual(updates[0].resume,{at:later,reason:'limit'});assert.equal(updates[0].preparation,undefined);assert.equal(routes[0].reason,'limit');assert.equal(routes[0].until,later);
  updates.length=0;assert.equal(main('checkDispatch',env([limitRow()]))({id:'c1',pool:['deepseek-flash']},turn()),false);assert.equal(updates[0].status,'needs-model','not in the pool: a model choice');
  updates.length=0;assert.equal(main('checkDispatch',env([limitRow(null)]))(chat,turn()),false);assert.equal(updates[0].status,'needs-model','no reset time: a model choice');
  updates.length=0;assert.equal(main('checkDispatch',env([]))({id:'c1',pool:['deepseek-flash']},turn({model:'deepseek-flash'})),true,'an available model goes');
});

test('runStep: a paused message holds with its pause text until the reset, then goes',async()=>{
  const held:string[]=[],sent:string[]=[],paused=turn({resume:{at:later,reason:'limit'}});
  const env=(rows:Availability[])=>({store:{get:()=>({id:'c1'}),where:()=>[paused]},waitingRow:()=>paused,nameBehind:()=>{},hold:(_c:string,_t:Turn,reason:string)=>held.push(reason),holdReason:()=>'',dispatch:async(_c:any,t:Turn)=>{sent.push(t.id);},health:{rows:()=>rows},resumeDue,pauseText,blockedFor,checkDispatch:()=>true});
  assert.equal(await main('runStep',env([limitRow()]))('c1'),false);assert.deepEqual(held,[pauseText(later)]);assert.deepEqual(sent,[]);
  assert.equal(await main('runStep',env([limitRow(now-1)]))('c1'),true,'the reset passed');assert.deepEqual(sent,['t1']);
  assert.equal(await main('runStep',env([]))('c1'),true,'the limit lifted early');
});

// A queued message whose model its account blocks used to hold at "Waiting for DeepSeek to connect" for good; it never
// reached the model check, so the account limit mid-reply left it there (availability.e2e, 11-09).
test('runStep: a message whose model is blocked by its account goes to the model check instead of waiting to connect',async()=>{
  const checked:string[]=[],held:string[]=[],sent:string[]=[],plain=turn();
  const env=(rows:Availability[])=>({store:{get:()=>({id:'c1'}),where:()=>[plain]},waitingRow:()=>plain,nameBehind:()=>{},hold:(_c:string,_t:Turn,reason:string)=>held.push(reason),holdReason:()=>'Waiting for Claude to connect',dispatch:async(_c:any,t:Turn)=>{sent.push(t.id);},health:{rows:()=>rows},resumeDue,pauseText,blockedFor,checkDispatch:(_c:any,t:Turn)=>{checked.push(t.model);return false;}});
  assert.equal(await main('runStep',env([limitRow(null)]))('c1'),true,'look again: the check set the row');assert.deepEqual(checked,['claude-code:opus']);assert.deepEqual(sent,[]);assert.deepEqual(held,[]);
  checked.length=0;assert.equal(await main('runStep',env([]))('c1'),false,'not blocked: the usual hold');assert.deepEqual(checked,[]);assert.deepEqual(held,['Waiting for Claude to connect']);
});

test('nameBehind: messages behind a paused one say so, and drop the text when it goes',()=>{
  const updates:any[]=[];
  const env=(rows:Availability[])=>({store:{update:(_k:string,id:string,patch:any)=>updates.push({id,...patch})},emit:()=>{},setImmediate:()=>{},BEHIND,BEHIND_PAUSED,resumeDue,health:{rows:()=>rows}});
  const head=turn({id:'h',resume:{at:later,reason:'limit'}}),behind=turn({id:'b'});
  main('nameBehind',env([limitRow()]))([head,behind],head);assert.deepEqual(updates,[{id:'b',hold:BEHIND_PAUSED}]);
  updates.length=0;main('nameBehind',env([limitRow()]))([head,turn({id:'p',paused:true})],head);assert.deepEqual(updates,[],'a message he paused himself keeps its own state');
  updates.length=0;const gone=turn({id:'h'});main('nameBehind',env([]))([gone,{...behind,hold:BEHIND_PAUSED}],gone);assert.deepEqual(updates,[{id:'b',hold:undefined}]);
});

test('finishNative: a reply the limit stopped waits for the reset and leaves the session position alone; without a reset time it fails as before',()=>{
  const rows:Record<string,any>={t1:turn({status:'running'})},engine:string[]=[],claude={status:''};
  const store={find:(_k:string,id:string)=>rows[id],get:(_k:string,id:string)=>rows[id],update:(_k:string,id:string,patch:any)=>Object.assign(rows[id],patch),finishEngine:(id:string,_e:string,sid:string|null,patch:any)=>{engine.push(String(sid));Object.assign(rows[id],patch);},where:()=>[]};
  const env=(availability:Availability[])=>({store,resetJoinedText:()=>{},native:{finished(){}},claude,health:{rows:()=>availability,clear(){}},claudeTurnUsage:()=>({}),limitPause});
  const result={status:'failed',sessionId:'s1',result:{errors:['Usage limit reached.'],result:'Usage limit reached.'}};
  main('finishNative',env([limitRow()]))({id:'c1'},rows.t1,result,'r1',now);
  assert.equal(rows.t1.status,'queued');assert.deepEqual(rows.t1.resume,{at:later,reason:'limit'});assert.equal(rows.t1.error,null);assert.equal(rows.t1.hold,pauseText(later));
  assert.deepEqual(engine,[],'the session did not answer this message: its position does not move');assert.equal(claude.status,'','not a failed turn');
  rows.t1=turn({status:'running'});main('finishNative',env([limitRow(null)]))({id:'c1'},rows.t1,result,'r1',now);
  assert.equal(rows.t1.status,'failed');assert.deepEqual(engine,['s1']);assert.equal(claude.status,'Last turn failed');
  rows.t1=turn({status:'running',automatic:{kind:'agent'} as any});main('finishNative',env([limitRow()]))({id:'c1'},rows.t1,result,'r1',now);
  assert.equal(rows.t1.status,'failed','an agent reply is not re-sent by the chat queue, so it ends as before');
});

test('a restart leaves a message waiting for a limit reset unpaused, so it still goes by itself',()=>{
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id);
  const waiting=store.accept('w',chat.id,'waits for the reset'),plain=store.accept('p',chat.id,'an ordinary queued message');
  store.update<Turn>('turn',waiting.id,{...pausePatch(later,now)});
  store.interrupt();
  assert.equal(store.get<Turn>('turn',waiting.id).paused,undefined);assert.equal(store.get<Turn>('turn',waiting.id).status,'queued');
  assert.equal(store.get<Turn>('turn',plain.id).paused,true);
  store.db.close();
});

test('the wait ends at the reset or when the limit lifts; the pause text is the row text',()=>{
  const waiting=turn({resume:{at:later,reason:'limit'}});
  assert.equal(resumeDue(waiting,[limitRow()],now),false);assert.equal(resumeDue(waiting,[limitRow()],later),true);assert.equal(resumeDue(waiting,[],now),true);
  assert.equal(limitReset([limitRow()],'claude-code:opus',now),later);assert.equal(pausePatch(later,now).hold,pauseText(later,now));
});
