// Persistent native transport with real supervised fixture child processes. The fixture follows Claude Code's turn
// contract (session state, message lifecycle, one turn at a time; TURN-REVIEW section 5).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {ClaudeSession,type ClaudeRun,type ClaudeResult} from '../app/claude';
import {SecretScrubber} from '../app/redaction';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-session-')),events:any[][]=[[],[],[],[],[]],records=path.join(data,'requests.jsonl');
const mcp=(marker:string)=>({names:['test'],handle:async(_server:string,message:any)=>({jsonrpc:'2.0',id:message.id,result:message.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:message.method==='tools/call'?{content:[{type:'text',text:marker}]}:{}})});
const base={executable:process.execPath,prefixArgs:[path.join(root,'tests/fixtures/claude-cli.mjs'),'--fixture-record',records],python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'fixture',effort:'high',mode:'manual' as const,hasFolder:true,scrubber:new SecretScrubber(),work:{before:async()=>{},after:async()=>{}},mcp:mcp('initial')};
let n=0;
const options=(spec:any,index=0,extra:Partial<ClaudeRun>={}):ClaudeRun=>({...base,turnId:'message-'+(++n),prompt:JSON.stringify(spec),signal:new AbortController().signal,event:e=>events[index].push(e),approve:async()=>true,...extra});
const freePort=async()=>{const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return port;};
const wait=async(test:()=>boolean|Promise<boolean>)=>{const until=Date.now()+15000;while(!await test()){if(Date.now()>until)throw Error('Timed out');await new Promise(r=>setTimeout(r,30));}};
const healthy=async(port:number)=>{await wait(async()=>{try{return await (await fetch('http://127.0.0.1:'+port)).text()==='native-fixture';}catch{return false;}});};
// Main's side of a turn Claude starts by itself: an automatic row (events[4]) and its result.
const automatic:{result?:ClaudeResult|Error}[]=[],sessionEvents:any[]=[];let available=true;
const hooks={event:(e:any)=>sessionEvents.push(e),automatic:()=>{const row:{result?:ClaudeResult|Error}={};automatic.push(row);return {options:options({},4,{beforePrompt:()=>available?undefined:'Account unavailable'}),complete:(result:ClaudeResult|Error)=>{row.result=result;}};}};
const one=await ClaudeSession.open(options({action:'reply'}),hooks),two=await ClaudeSession.open(options({action:'reply'},3));
try{
  const firstPort=await freePort(),secondPort=await freePort(),foreignPort=await freePort(),pid=one.pid;
  const a=await one.submit(options({action:'background',port:firstPort},0,{projectMemory:'MEMORY A'})),b=await one.submit(options({action:'background',port:secondPort},1,{projectMemory:'MEMORY B',model:'second-model',mode:'accept-edits'})),foreign=await two.submit(options({action:'background',port:foreignPort},3));
  assert.equal(one.pid,pid);assert.equal(one.runningTasks.length,2);await healthy(firstPort);await healthy(secondPort);await healthy(foreignPort);
  assert.equal(one.busy,false,'running background jobs never hold the chat');
  await assert.rejects(one.stopTask(foreign.result.result),/does not belong/);
  await assert.rejects(one.submit(options({action:'reply'},2,{effort:'max'})),/configuration changed/);await healthy(firstPort);
  let before=0,after=0,asked=0;
  const written=await one.submit(options({action:'write',path:'fresh.txt'},2,{work:{before:async()=>{before++;},after:async()=>{after++;}},approve:async()=>{asked++;return true;},projectMemory:'FRESH MEMORY'}));
  assert.equal(written.result.result,'allow');assert.equal(before,1);assert.equal(after,1);assert.equal(asked,1);assert.equal(await fs.readFile(path.join(data,'fresh.txt'),'utf8'),'approved fixture');
  await one.submit(options({action:'write',path:'denied.txt'},2,{approve:async()=>false}));await assert.rejects(fs.access(path.join(data,'denied.txt')));
  await healthy(firstPort);await healthy(secondPort);
  console.log('PASS same native worker serves new models/turn callbacks and fresh memory; configuration and foreign-task checks preserve live servers');
  const abort=new AbortController();let partial=false;
  const stopped=await one.submit(options({action:'slow'},2,{signal:abort.signal,event:e=>{events[2].push(e);if(e.type==='stream_event'&&!partial){partial=true;abort.abort();}}}));
  assert.equal(stopped.status,'stopped');assert.equal(one.pid,pid);assert.ok(one.live);await healthy(firstPort);await healthy(secondPort);
  await one.stopTask(a.result.result);await wait(()=>one.runningTasks.length===1);await assert.rejects(fetch('http://127.0.0.1:'+firstPort));await healthy(secondPort);await healthy(foreignPort);
  const parentCount=events[0].length;await one.stopTask(b.result.result);await wait(()=>one.runningTasks.length===0);assert.equal(events[0].length,parentCount,'other task termination must not reach the first turn');
  console.log('PASS reply interrupt preserves existing tasks; task Stop is isolated and task_updated alone records termination');
  // Two messages sent back to back: the second goes to Claude at once and runs right after the first.
  const slow=one.submit(options({action:'slow'},0)),next=one.submit(options({action:'reply'},1));
  const [first,second]=await Promise.all([slow,next]);assert.equal(first.status,'completed');assert.equal(second.result.result,'Claude fixture retained copperfinch.');
  // Stop with a message waiting behind the reply: the reply stops, the waiting message still runs (live check 2, item 7).
  const stopMe=new AbortController();let streaming=false;
  const interrupted=one.submit(options({action:'slow'},0,{signal:stopMe.signal,event:e=>{if(e.type==='stream_event')streaming=true;}})),behind=one.submit(options({action:'reply'},1));
  await wait(()=>streaming);stopMe.abort();
  assert.equal((await interrupted).status,'stopped');assert.equal((await behind).status,'completed');
  console.log('PASS a message sent while Claude answers goes to Claude at once; Stop ends the reply, the message behind it still runs');
  // A job that finishes after its turn: Claude starts a turn of its own, which becomes an automatic row.
  const naturalPort=await freePort();await one.submit(options({action:'background',port:naturalPort,duration:300,completionDelay:200},0));
  const reply=await one.submit(options({action:'reply',beforePromptDelay:450},1));assert.equal(reply.result.result,'Claude fixture retained copperfinch.');
  await wait(()=>automatic.some(row=>row.result));
  assert.equal((automatic[0].result as ClaudeResult).status,'completed');assert.ok(events[4].some(e=>e.type==='result'&&e.origin?.kind==='task-notification'),'the notice reply goes to its automatic row');
  assert.ok(!events[1].some(e=>e.type==='result'&&e.origin?.kind==='task-notification'),'never into his message');
  await wait(()=>!one.busy);
  const requests=(await fs.readFile(records,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(requests[1].content[1].text,'MEMORY B');assert.equal(requests.find(r=>r.prompt.includes('fresh.txt')).content[1].text,'FRESH MEMORY');
  for(const marker of ['CURRENT MCP A','CURRENT MCP B']){const answer=await one.submit(options({action:'mcp',server:'test',tool:'echo',arguments:{same:'arguments'}},2,{mcp:mcp(marker)}));assert.match(answer.result.result,new RegExp(marker));}
  await one.submit(options({action:'background',port:await freePort(),duration:150},2));available=false;
  await wait(()=>sessionEvents.some(e=>e.type==='runtime.promptBlocked'&&e.reason==='Account unavailable'));await wait(()=>one.runningTasks.length===0);available=true;
  const secret='synthetic-agent-secret';base.scrubber.register(secret);let delegated:any,description='';
  await one.submit(options({action:'agent',readOnly:true,description:secret,summary:secret},2,{delegation:async task=>{description=task.description;return {options:options({},2,{model:task.model}),complete:value=>{delegated=value;}};}}));
  await wait(()=>!!delegated&&events[2].some(e=>e.type==='runtime.agentResult'&&e.usage));
  assert.equal(description,'[redacted]');assert.equal(delegated.result.result,'[redacted]');assert.ok(!JSON.stringify(events[2]).includes(secret));
  console.log('PASS delegated task descriptions, completion results and usage events are scrubbed before reaching the app');
  await wait(()=>!one.busy);assert.ok(sessionEvents.some(e=>e.type==='runtime.idle'),'Claude reports idle; the chat is free');
  await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({sameWorker:true,perTurnCallbacks:true,freshMemory:true,modelMode:true,configGuard:true,isolatedStop:true,interruptPreservesTasks:true,sentWhileBusy:true,stopKeepsWaiting:true,automaticRow:true},null,2));
  console.log('PASS a job finishing after its turn becomes an automatic row, never part of his message. Evidence: '+data);
}finally{await Promise.all([one.close(),two.close()]);}
