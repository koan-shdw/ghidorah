// The Claude engine (TURN-REVIEW part 1 and section 7, items 1 and 2): Claude's own events decide busy, every message
// is paired by its ID, and nothing is left open. Event orders are copied from the 10-14 raw stream of his 2.1.283.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ClaudeSession,type ClaudeRun,type ClaudeResult} from '../app/claude';
import {SecretScrubber} from '../app/redaction';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function engine(automatic=true,base:Partial<ClaudeRun>={}){
  const scrubber=new SecretScrubber(),rows=new Map<string,any[]>(),hookEvents:any[]=[],wire:any[]=[],commands:any[]=[],responses:any[]=[],made:{id:string;result?:ClaudeResult|Error}[]=[];
  const options=(turnId:string,extra:Partial<ClaudeRun>={}):ClaudeRun=>{rows.set(turnId,[]);return {executable:'claude',python:'python',worker:'worker',directory:'C:/work',dataRoot:'C:/data',exchangeRoot:'C:/exchange',model:'opus',effort:'high',mode:'manual',hasFolder:false,prompt:'Message '+turnId,turnId,scrubber,signal:new AbortController().signal,event:e=>rows.get(turnId)!.push(e),approve:async()=>true,...base,...extra};};
  const initial=options('initial');
  const session:any=new (ClaudeSession as any)(initial,{event:(e:any)=>hookEvents.push(e),automatic:automatic?()=>{const id='auto-'+(made.length+1),row={id} as {id:string;result?:ClaudeResult|Error};made.push(row);return {options:options(id),complete:(result:ClaudeResult|Error)=>{row.result=result;}};}:undefined});
  session.send=(message:any)=>wire.push(message);session.response=(id:string,value:any)=>responses.push({id,value});
  session.command=async(request:any)=>{commands.push(request);return request.subtype==='interrupt'?{still_queued:[...session.sent.values()].filter((s:any)=>!s.turn).map((s:any)=>s.id)}:request.subtype==='cancel_async_message'?{cancelled:true}:{};};
  const feed=(...messages:any[])=>{for(const message of messages)session.receive({session_id:'native',...message});};
  const submit=async(id:string,extra:Partial<ClaudeRun>={})=>{const answer:Promise<ClaudeResult>=session.submit(options(id,extra));await tick();return {answer};};
  return {session,rows,hookEvents,wire,commands,responses,made,feed,submit,options};
}
const state=(value:'running'|'idle')=>({type:'system',subtype:'session_state_changed',state:value});
const life=(id:string,value:string)=>({type:'command_lifecycle',command_uuid:id,state:value});
const init={type:'system',subtype:'init'};
const replay=(id:string)=>({type:'user',uuid:id,isReplay:true,message:{role:'user',content:[{type:'text',text:'replayed'}]}});
const notice=(task:string)=>({type:'user',isReplay:true,origin:{kind:'task-notification'},message:{role:'user',content:`<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n</task-notification>`}});
const result=(ids:string[],extra:any={})=>({type:'result',subtype:'success',is_error:false,result:'done',num_turns:1,user_message_uuids:ids,...extra});
const settled=async(answer:Promise<ClaudeResult>)=>{let value:any;void answer.then(v=>{value=v;},e=>{value=e;});await tick();return value;};

test('a job notice folded into the running reply leaves nothing open (10-06 22:33, 10-08 12:41, 10-13 19:04)',async()=>{
  const e=engine(),{answer}=await e.submit('A');
  assert.equal(e.wire.at(-1).uuid,'A');assert.equal(e.wire.at(-1).priority,'next');
  e.feed(state('running'),life('A','queued'),life('A','started'),init,replay('A'));
  e.feed({type:'system',subtype:'task_started',task_id:'bg',tool_use_id:'t1',task_type:'local_bash',is_backgrounded:true});
  e.feed(notice('bg'),{type:'assistant',message:{content:[{type:'text',text:'Both done.'}]}});
  assert.equal(e.session.busy,true);
  e.feed(result(['A']),life('A','completed'),state('idle'));
  const value=await settled(answer);
  assert.equal(value.status,'completed');assert.equal(e.made.length,0,'no automatic turn for a folded notice');
  assert.equal(e.session.busy,false);assert.equal(e.hookEvents.at(-1).type,'runtime.idle');
});

test('his message sent mid-reply is answered in the same reply, paired by ID (live check 1)',async()=>{
  const e=engine(),{answer:a}=await e.submit('A');
  e.feed(state('running'),life('A','queued'),life('A','started'),init,replay('A'));
  const {answer:b}=await e.submit('B');
  assert.equal(e.commands.some((c:any)=>c.subtype==='set_permission_mode'&&e.commands.indexOf(c)>0),false,'no mode change mid-reply');
  e.feed(life('B','queued'));assert.deepEqual(e.rows.get('B')!.filter(x=>x.type==='runtime.delivery').map(x=>x.state),['queued']);
  e.feed({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'ok'}]}},replay('B'),life('B','started'),life('B','completed'));
  assert.equal(e.rows.get('B')!.find(x=>x.type==='runtime.joined').answeredIn,'A');
  e.feed(result(['A','B']),life('A','completed'),state('idle'));
  assert.equal((await settled(a)).status,'completed');const second=await settled(b);
  assert.equal(second.status,'completed');assert.equal(second.answeredIn,'A');assert.equal(e.session.busy,false);
});

test('a prompt from another Claude session is refused, shows on its row and closes nothing of his (blocked prompt)',async()=>{
  // Claude starts the other session's message as a turn of its own; his message arrives while it runs.
  const e=engine();e.feed(state('running'),init);
  const {answer:a}=await e.submit('A');e.feed(life('A','queued'));
  // The hook answers at once, from what Tris knows.
  void e.session.control({request_id:'h1',request:{subtype:'hook_callback',callback_id:'turn-owner',input:{prompt:'<cross-session-message from="other">hi</cross-session-message>'}}});
  assert.equal(e.responses.at(-1).value.decision,'block','answered synchronously, no wait');
  assert.equal(e.made.length,1);assert.equal(e.rows.get('auto-1')!.find(x=>x.type==='runtime.promptRefused').kind,'cross-session');
  e.feed(result([],{is_error:true,num_turns:0,origin:{kind:'task-notification',subkind:'session-inbox'}}));
  assert.equal((e.made[0].result as ClaudeResult).status,'failed');
  assert.equal(e.session.busy,true,'his message A is still owed');
  e.feed(life('A','started'),init,result(['A']),life('A','completed'),state('idle'));
  assert.equal((await settled(a)).status,'completed');assert.equal(e.session.busy,false);
});

test('a wake-up runs as an automatic row with its own Stop, then the chat is free',async()=>{
  const e=engine();
  e.feed(state('running'),init);
  void e.session.control({request_id:'h1',request:{subtype:'hook_callback',callback_id:'turn-owner',input:{prompt:'Check the surveys and continue.'}}});
  assert.deepEqual(e.responses.at(-1).value,{},'self-started prompts are allowed (his decision 2026-10-14)');
  assert.equal(e.made.length,1);assert.equal(e.session.busy,true);
  await e.session.interrupt();assert.ok(e.commands.some((c:any)=>c.subtype==='interrupt'));
  e.feed({type:'result',subtype:'error_during_execution',is_error:true,num_turns:1,user_message_uuids:[],origin:{kind:'task-notification',subkind:'scheduled-trigger'}},state('idle'));
  assert.equal((e.made[0].result as ClaudeResult).status,'stopped');assert.equal(e.session.busy,false);
});

test('two notices in one turn Claude starts itself make one automatic row',async()=>{
  const e=engine();
  e.feed(state('running'),init,notice('one'),notice('two'),{type:'assistant',message:{content:[{type:'text',text:'Both jobs finished.'}]}},result([],{origin:{kind:'task-notification'}}),state('idle'));
  assert.equal(e.made.length,1);assert.equal((e.made[0].result as ClaudeResult).status,'completed');assert.equal(e.session.busy,false);
});

test('his message read inside a turn Claude started itself is answered there',async()=>{
  const e=engine();e.feed(state('running'),init);
  const {answer:b}=await e.submit('B');e.feed(life('B','queued'),replay('B'),life('B','started'),life('B','completed'),result(['B'],{origin:{kind:'task-notification'}}),state('idle'));
  const value=await settled(b);assert.equal(value.status,'completed');assert.equal(value.answeredIn,'auto-1');assert.equal(e.session.busy,false);
});

test('idle before result and result before idle both end free; an open turn is always busy',async()=>{
  for(const order of [['idle','result'],['result','idle']]){
    const e=engine(),{answer:a}=await e.submit('A');e.feed(state('running'),life('A','queued'),life('A','started'),init);
    for(const [index,step] of order.entries()){e.feed(step==='idle'?state('idle'):result(['A']));if(step==='idle'&&index===0)assert.equal(e.session.busy,true,'the turn is still open');}
    e.feed(life('A','completed'));assert.equal((await settled(a)).status,'completed');assert.equal(e.session.busy,false,order.join(' then '));
  }
});

test('without state or lifecycle events Tris follows results only, and never guesses idle from silence',async()=>{
  const e=engine(),{answer:a}=await e.submit('A');
  e.feed(init,replay('A'));assert.equal(e.session.busy,true);
  e.feed({type:'assistant',message:{content:[{type:'text',text:'working'}]}});assert.equal(e.session.busy,true,'quiet is not idle');
  e.feed(result(['A']));const value=await settled(a);assert.equal(value.status,'completed');assert.equal(e.session.busy,false);
});

test('a later message starts 2 ms after the result with no idle between: busy throughout',async()=>{
  const e=engine(),{answer:a}=await e.submit('A'),{answer:d}=await e.submit('D');
  e.feed(state('running'),life('A','queued'),life('A','started'),init,life('D','queued'));
  e.feed(result(['A']),life('A','completed'));assert.equal((await settled(a)).status,'completed');
  assert.equal(e.session.busy,true,'D is still owed');assert.notEqual(e.hookEvents.at(-1)?.type,'runtime.idle');
  e.feed(life('D','started'),init,result(['D']),life('D','completed'),state('idle'));
  assert.equal((await settled(d)).status,'completed');assert.equal(e.session.busy,false);
});

test('Stop ends the running reply only; the message waiting behind it goes out after (live check 2, item 7)',async()=>{
  const e=engine(),{answer:a}=await e.submit('A'),{answer:f}=await e.submit('F');
  e.feed(state('running'),life('A','queued'),life('A','started'),init,life('F','queued'));
  const receipt=await e.session.interrupt();assert.deepEqual(receipt.stillQueued,['F']);
  e.feed({type:'result',subtype:'error_during_execution',is_error:true,num_turns:1,user_message_uuids:['A']},life('A','cancelled'));
  assert.equal((await settled(a)).status,'stopped','stopped, never failed');
  e.feed(life('F','started'),init,result(['F']),life('F','completed'),state('idle'));
  assert.equal((await settled(f)).status,'completed');assert.equal(e.session.busy,false);
});

test('his remove button withdraws a message Claude has not taken yet',async()=>{
  const e=engine(),{answer:a}=await e.submit('A'),{answer:b}=await e.submit('B');
  e.feed(state('running'),life('A','queued'),life('A','started'),init,life('B','queued'));
  assert.equal(await e.session.withdraw('B'),true);assert.equal((await settled(b)).status,'stopped');
  e.feed(life('B','cancelled'),result(['A']),life('A','completed'),state('idle'));
  assert.equal((await settled(a)).status,'completed');assert.equal(e.session.busy,false);
  assert.equal(await e.session.withdraw('A'),true,'an answered message is already gone');
});

test('a foreground command is part of its tool call: no background job, nothing held (10-06 holds)',async()=>{
  const e=engine(),{answer:a}=await e.submit('A');e.feed(state('running'),life('A','queued'),life('A','started'),init);
  e.session.tools.set('t1',{owner:e.session.turn.scope});e.session.tools.set('t2',{owner:e.session.turn.scope});
  e.feed({type:'system',subtype:'task_started',task_id:'fg',tool_use_id:'t1',task_type:'local_bash',is_backgrounded:false},{type:'system',subtype:'task_notification',task_id:'fg',status:'completed'});
  e.feed({type:'system',subtype:'task_started',task_id:'bg',tool_use_id:'t2',task_type:'local_bash',is_backgrounded:true});
  assert.deepEqual(e.session.runningTasks.map((t:any)=>t.id),['bg']);
  e.feed(result(['A']),life('A','completed'),state('idle'));await settled(a);assert.equal(e.session.busy,false,'a running background job never holds the chat');
});

test('a message Claude adds inside a turn never becomes his row',async()=>{
  const e=engine(),{answer:a}=await e.submit('A');e.feed(state('running'),life('A','queued'),life('A','started'),init);
  e.feed({type:'user',isSynthetic:true,uuid:'claude-own',message:{role:'user',content:[{type:'text',text:'[Your previous response had no visible output]'}]}});
  e.feed(result(['A']),life('A','completed'),state('idle'));assert.equal((await settled(a)).status,'completed');assert.equal(e.made.length,0);
});

test('wake-ups and timers are refused in a chat whose switch is off',async()=>{
  const e=engine(),{answer:a}=await e.submit('A',{wakeUps:()=>false});e.feed(state('running'),life('A','queued'),life('A','started'),init);
  await e.session.control({request_id:'p1',request:{subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:'w1',tool_name:'ScheduleWakeup',tool_input:{delaySeconds:600}}}});
  const answer=e.responses.at(-1).value.hookSpecificOutput;assert.equal(answer.permissionDecision,'deny');assert.match(answer.permissionDecisionReason,/Let Claude wake itself up/);
  e.feed(result(['A']),life('A','completed'));await settled(a);
});

test('a model change is never sent while Claude is answering',async()=>{
  const e=engine();await e.submit('A');e.feed(state('running'),life('A','queued'),life('A','started'),init);
  await assert.rejects(e.session.submit(e.options('B',{model:'sonnet'})),/model changes when it is idle/);
});

// Section 7 item 2: random orders. A small Claude that follows the contract drives the engine; Tris's busy must match
// Claude's, every message must end once, and Stop must free the chat.
test('invariant over random event orders: busy matches Claude, no message lost or doubled, Stop frees the chat',async()=>{
  let seed=7;const random=()=>((seed=(seed*1103515245+12345)%2147483648)/2147483648);
  for(let run=0;run<300;run++){
    const e=engine(),ends=new Map<string,number>(),answers:Promise<void>[]=[];
    let open:{owner?:string;ids:string[]}|undefined,claudeState:'idle'|'running'='idle';const waiting:{id:string;later:boolean}[]=[];let n=0;
    const toRunning=()=>{if(claudeState!=='running'){claudeState='running';e.feed(state('running'));}};
    const start=()=>{const next=waiting.shift();if(next){e.feed(life(next.id,'started'),init);open={owner:next.id,ids:[next.id]};}};
    const finish=(cancelled=false)=>{if(!open)return;const turn=open;open=undefined;for(const id of turn.ids.slice(1))e.feed(life(id,cancelled?'cancelled':'completed'));e.feed(result(turn.ids,cancelled?{subtype:'error_during_execution',is_error:true}:{origin:turn.owner?undefined:{kind:'task-notification'}}));if(turn.owner)e.feed(life(turn.owner,cancelled?'cancelled':'completed'));start();if(!open&&!waiting.length){claudeState='idle';e.feed(state('idle'));}};
    for(let step=0;step<25;step++){
      const roll=random();
      if(roll<0.3){const id='m'+(n++),later=random()<0.2;const answer=e.session.submit(e.options(id));answers.push(answer.then(()=>{ends.set(id,(ends.get(id)||0)+1);},()=>{ends.set(id,(ends.get(id)||0)+1);}));await tick();toRunning();e.feed(life(id,'queued'));waiting.push({id,later});if(!open)start();}
      else if(roll<0.5&&open){const fold=waiting.filter(m=>!m.later);for(const m of fold){waiting.splice(waiting.indexOf(m),1);e.feed(replay(m.id),life(m.id,'started'));open.ids.push(m.id);}}
      else if(roll<0.65&&!open&&!waiting.length){toRunning();e.feed(init);open={ids:[]};}
      else if(roll<0.7&&open){await e.session.interrupt();finish(true);}
      else if(roll<0.9)finish();
      else if(open)e.feed(notice('job'+step));
      const claudeBusy=!!open||waiting.length>0;
      if(claudeBusy)assert.equal(e.session.busy,true,`run ${run} step ${step}: Claude is busy`);
    }
    while(open||waiting.length){if(!open)start();finish();}
    await Promise.all(answers);
    assert.equal(e.session.busy,false,`run ${run}: free once Claude is idle`);
    for(let i=0;i<n;i++)assert.equal(ends.get('m'+i),1,`run ${run}: message m${i} ends exactly once`);
    for(const row of e.made)assert.ok(row.result,`run ${run}: automatic row ${row.id} closed`);
  }
});

// 10-16 KOAN.live chat: Tris's check took the work lock, then Claude Code refused the command by its own deny rule and
// sent no finish hook, so the lock stayed. Every later check waited until Claude gave up (10 min each), and the checks
// it gave up on kept waiting and took the lock later. A small lock stands in for WorkCoordination.
function lockedWork(){
  const calls:any[]=[],waiters:(()=>void)[]=[];let holder:string|undefined;
  const work:NonNullable<ClaudeRun['work']>={
    before:async(id,_name,_args,_directory,signal)=>{
      calls.push(['before',id]);
      while(holder)await new Promise<void>((resolve,reject)=>{waiters.push(resolve);signal?.addEventListener('abort',()=>reject(Error('Work cancelled.')),{once:true});});
      signal?.throwIfAborted();holder=id;calls.push(['lease',id]);
    },
    after:async(id,_result,failed)=>{calls.push(['after',id,failed]);if(holder===id){holder=undefined;for(const wake of waiters.splice(0))wake();}},
  };
  return {work,calls,holder:()=>holder};
}
const folders=()=>{const root=path.resolve('work');fs.mkdirSync(root,{recursive:true});return {directory:fs.realpathSync(fs.mkdtempSync(path.join(root,'hook-lock-'))),dataRoot:fs.realpathSync(fs.mkdtempSync(path.join(root,'hook-lock-data-')))};};
const check=(id:string,tool:string,name:string,input:any,cwd:string)=>({request_id:id,request:{subtype:'hook_callback',callback_id:'fixed-protection',input:{hook_event_name:'PreToolUse',tool_use_id:tool,tool_name:name,tool_input:input,cwd}}});
const refused=(tool:string,text:string)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:tool,is_error:true,content:text}]}});

test('a tool Claude Code refuses by itself after Tris\'s check frees its work lock (10-16 KOAN.live chat)',async()=>{
  const {directory,dataRoot}=folders(),lock=lockedWork(),e=engine(true,{hasFolder:true,directory,dataRoot,work:lock.work}),{answer:a}=await e.submit('A');
  e.feed(state('running'),life('A','queued'),life('A','started'),init);
  await e.session.control(check('p1','t1','Bash',{command:'cd ~/.cargo && rg resize'},directory));
  assert.deepEqual(e.responses.at(-1).value,{},'Tris\'s check passed');assert.equal(lock.holder(),'t1');
  // Claude Code's own deny rule: a tool_result error and no PostToolUse or PostToolUseFailure.
  e.feed(refused('t1','rg reads resize.rs after a cd whose target cannot be resolved, and a deny rule (~/.claude/**) names that file'));await tick();
  assert.equal(lock.holder(),undefined,'the lock is free');assert.deepEqual(lock.calls.at(-1),['after','t1',true],'finished with its outcome left to the work review');
  await e.session.control(check('p2','t2','Bash',{command:'echo next'},directory));
  assert.deepEqual(e.responses.at(-1).value,{},'the next tool runs at once');
  e.feed(result(['A']),life('A','completed'));await settled(a);
});

test('a check Claude Code gave up on stops waiting and never takes the lock later (10-16 KOAN.live chat)',async()=>{
  const {directory,dataRoot}=folders(),lock=lockedWork(),e=engine(true,{hasFolder:true,directory,dataRoot,work:lock.work}),{answer:a}=await e.submit('A');
  e.feed(state('running'),life('A','queued'),life('A','started'),init);
  await e.session.control(check('p1','t1','Bash',{command:'cd ~/.cargo && rg resize'},directory));
  const waiting=e.session.control(check('p2','t2','Edit',{file_path:path.join(directory,'desk.rs'),old_string:'a',new_string:'b'},directory));
  for(let i=0;i<100&&!lock.calls.some(call=>call[0]==='before'&&call[1]==='t2');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(lock.calls.at(-1),['before','t2'],'t2 waits behind t1');
  // Claude Code's hook limit: it reports the tool as not run and stops waiting for Tris's answer.
  e.feed(refused('t2','PreToolUse hook did not respond before its timeout (host client may be unreachable). The tool call was not executed; other configured hooks may not have completed.'));
  await Promise.race([waiting,new Promise(resolve=>setTimeout(resolve,500))]);
  e.feed(refused('t1','a deny rule (~/.claude/**) names that file'));await tick();await tick();
  assert.equal(lock.holder(),undefined,'nobody holds the lock');
  assert.equal(lock.calls.some(call=>call[0]==='lease'&&call[1]==='t2'),false,'the check Claude gave up on never took the lock');
  e.feed(result(['A']),life('A','completed'));await settled(a);
});

test('an older Claude Code naming its answer in user_message_uuid (singular) still closes his message',async()=>{
  const e=engine(),{answer:a}=await e.submit('A');
  e.feed({type:'result',subtype:'success',is_error:false,result:'done',user_message_uuid:'A'});
  const value=await settled(a);assert.equal(value.status,'completed');assert.equal(e.made.length,0,'not mistaken for a turn Claude started itself');
});
