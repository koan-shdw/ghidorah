// The new Claude engine against his real Claude Code (signed-in subscription, Haiku): run only on his OK, with
// TRISMEGISTUS_LIVE_CLAUDE=1. TURN-REVIEW part 1: a message sent mid-reply is answered in that reply; his remove button
// withdraws a message Claude has not taken; Stop ends the reply and the message waiting behind it still runs; a job
// finishing after its turn becomes a turn Claude starts itself (an automatic row).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ClaudeSession,findClaude,type ClaudeRun,type ClaudeResult} from '../app/claude';
import {SecretScrubber} from '../app/redaction';
if(process.env.TRISMEGISTUS_LIVE_CLAUDE!=='1')throw Error('Set TRISMEGISTUS_LIVE_CLAUDE=1 for the signed-in subscription check.');
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-session-live-')),cli=await findClaude();assert.ok(cli);
const events:Record<string,any[]>={},sessionEvents:any[]=[],automatic:{result?:ClaudeResult|Error}[]=[],t0=Date.now();
const log=(text:string)=>console.log(String(Date.now()-t0).padStart(6)+' '+text);
const base={executable:cli.executable,python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'claude-haiku-4-5',effort:'low',mode:'manual' as const,hasFolder:true,scrubber:new SecretScrubber(),work:{before:async()=>{},after:async()=>{}}};
const options=(name:string,prompt:string,extra:Partial<ClaudeRun>={}):ClaudeRun=>{events[name]=[];return {...base,turnId:crypto.randomUUID(),prompt,signal:AbortSignal.timeout(120000),event:e=>events[name].push(e),approve:async(_id,tool,input)=>tool==='Bash'&&/^sleep \d+$/.test(String(input.command||'').trim()),...extra};};
const wait=async(test:()=>boolean,label:string,limit=60000)=>{const until=Date.now()+limit;while(!test()){if(Date.now()>until)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,100));}};
const toolRunning=(name:string)=>()=>events[name].some(e=>e.type==='runtime.tool'&&e.name==='Bash'&&e.status==='running');
const hooks={event:(e:any)=>{sessionEvents.push(e);if(['runtime.busy','runtime.idle','runtime.warning'].includes(e.type))log(e.type+(e.message?' '+e.message:''));},automatic:()=>{const row:{result?:ClaudeResult|Error}={};automatic.push(row);log('automatic turn opened');return {options:options('auto-'+automatic.length,''),complete:(result:ClaudeResult|Error)=>{row.result=result;log('automatic turn closed: '+(result instanceof Error?result.message:result.status));}};}};
const first=options('A','Use the Bash tool to run exactly: sleep 6 (in the foreground, not in the background). When it finishes, reply in one short line that answers every message you have received.');
const session=await ClaudeSession.open(first,hooks);
try{
 // 1. A message sent mid-reply is answered in the running reply (live check 1, now through Tris's engine).
 const a=session.submit(first);await wait(toolRunning('A'),'A runs its sleep');
 const b=session.submit(options('B','Also: what is 2+2? Answer in the same reply.'));
 const [ra,rb]=await Promise.all([a,b]);log('A '+ra.status+' '+JSON.stringify(ra.result?.result)+' | B '+rb.status+' answeredIn='+rb.answeredIn);
 assert.equal(ra.status,'completed');assert.equal(rb.status,'completed');assert.equal(rb.answeredIn,first.turnId,'B is answered in A\'s reply');assert.match(String(ra.result.result),/4/);
 console.log('PASS a message sent mid-reply is answered in the same reply, paired by ID');
 // 2. His remove button withdraws a message Claude has not taken yet.
 const c=session.submit(options('C','Use the Bash tool to run exactly: sleep 6 (in the foreground). Then reply DONE.'));await wait(toolRunning('C'),'C runs its sleep');
 const dOptions=options('D','Reply D only.'),d=session.submit(dOptions);await new Promise(r=>setTimeout(r,500));
 const withdrawn=await session.withdraw(dOptions.turnId!);const [rc,rd]=await Promise.all([c,d]);log('withdraw='+withdrawn+' C '+rc.status+' D '+rd.status);
 assert.equal(withdrawn,true);assert.equal(rd.status,'stopped');assert.equal(rc.status,'completed');assert.ok(!events.D.some(e=>e.type==='runtime.joined'),'D was never read');
 console.log('PASS the remove button withdraws a message Claude has not taken (cancel_async_message)');
 // 3. Stop ends the reply; the message waiting behind it still runs as its own turn (live check 2, item 7).
 const e=session.submit(options('E','Use the Bash tool to run exactly: sleep 8 (in the foreground). Then reply FINISHED.'));await wait(toolRunning('E'),'E runs its sleep');
 const fOptions=options('F','What is 3+3? Reply with just the number.'),f=session.submit(fOptions);await new Promise(r=>setTimeout(r,500));
 const receipt=await session.interrupt();const [re,rf]=await Promise.all([e,f]);log('still queued '+JSON.stringify(receipt.stillQueued.map((id:string)=>id===fOptions.turnId?'F':id))+' E '+re.status+' F '+rf.status+' '+JSON.stringify(rf.result?.result));
 assert.equal(re.status,'stopped');assert.ok(receipt.stillQueued.includes(fOptions.turnId!));assert.equal(rf.status,'completed');assert.equal(rf.answeredIn,undefined,'F ran as its own turn');assert.match(String(rf.result.result),/6/);
 console.log('PASS Stop ends the running reply only; the message waiting behind it runs next');
 // 4. A job finishing after its turn: Claude starts a turn of its own, which Tris makes an automatic row.
 const g=await session.submit(options('G','Use the Bash tool to run exactly: sleep 5 with run_in_background set to true. Do not wait for it. Reply STARTED and end your turn.'));log('G '+g.status+' '+JSON.stringify(g.result?.result));
 assert.equal(g.status,'completed');await wait(()=>automatic.some(row=>row.result),'the notice turn',60000);
 assert.equal((automatic[0].result as ClaudeResult).status,'completed');
 await wait(()=>!session.busy,'idle after the notice turn',30000);
 assert.ok(sessionEvents.some(e=>e.type==='runtime.idle'));assert.ok(!sessionEvents.some(e=>e.type==='runtime.warning'),'Claude reported its states');
 console.log('PASS a job finishing after its turn becomes an automatic row; the chat is free once Claude is idle');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({version:cli.version,midReplyAnswered:true,withdraw:true,stopKeepsWaiting:true,automaticRow:true},null,2));
 console.log('PASS real Claude Code '+cli.version+'. Evidence: '+data);
}finally{await session.close();await fs.writeFile(path.join(data,'events.json'),JSON.stringify({events,sessionEvents},null,2));}
