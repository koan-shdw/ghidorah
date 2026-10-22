import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ClaudeSession,type ClaudeRun,type ClaudeResult} from '../app/claude';
import {SecretScrubber} from '../app/redaction';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-agent-mcp-')),completed=new Map<string,ClaudeResult|Error>(),tasks=new Map<string,string>(),calls:string[]=[],signals=new Map<string,AbortSignal>(),events:any[]=[];
let pause=false;const release=new Map<string,()=>void>();
const wait=async(check:()=>boolean)=>{const until=Date.now()+15000;while(!check()){if(Date.now()>until)throw Error('Timeout '+JSON.stringify({completed:[...completed],calls}));await new Promise(r=>setTimeout(r,20));}};
const mcp=(label:string)=>({names:['test'],managedTools:['mcp__test__echo'],handle:async(_server:string,message:any,signal:AbortSignal,directory?:string)=>{
 if(message.method!=='tools/call')return {jsonrpc:'2.0',id:message.id,result:{}};
 if(['alpha','beta'].includes(label))assert.equal(directory,path.join(data,label));
 calls.push(label);signals.set(label,signal);
 if(pause)await new Promise<void>((resolve,reject)=>{const abort=()=>reject(Error('Cancelled '+label));signal.addEventListener('abort',abort,{once:true});release.set(label,()=>{signal.removeEventListener('abort',abort);resolve();});});
 return {jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:label}]}};
}});
const base={executable:process.execPath,prefixArgs:[path.join(root,'tests/fixtures/claude-cli.mjs'),'--fixture-record',path.join(data,'requests.jsonl')],python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'haiku',effort:'high',mode:'manual' as const,hasFolder:true,scrubber:new SecretScrubber(),work:{before:async()=>{},after:async()=>{}}};
const options=(spec:any,label='parent'):ClaudeRun=>({...base,prompt:JSON.stringify(spec),signal:new AbortController().signal,event:e=>events.push({label,event:e}),approve:async()=>true,mcp:mcp(label),delegation:async task=>{tasks.set(task.description,task.id);return {options:options({},task.description),complete:value=>completed.set(task.description,value)};}});
const session=await ClaudeSession.open(options({action:'reply'}));
const batch=async(children:any[])=>{await session.submit(options({action:'agent',children}));await wait(()=>children.every(c=>completed.has(c.description)));};
try{
 for(const label of ['alpha','beta'])await fs.mkdir(path.join(data,label));
 pause=true;await session.submit(options({action:'agent',children:['alpha','beta'].map(description=>({description,cwd:path.join(data,description),mcp:{}}))}));await wait(()=>calls.includes('alpha')&&calls.includes('beta'));assert.notEqual(signals.get('alpha'),signals.get('beta'));
 release.get('beta')!();release.get('alpha')!();await wait(()=>completed.has('alpha')&&completed.has('beta'));
 for(const label of ['alpha','beta']){const result=completed.get(label) as ClaudeResult;assert.equal(result.status,'completed');assert.match(result.result.result,new RegExp(label));assert.doesNotMatch(result.result.result,new RegExp(label==='alpha'?'beta':'alpha'));}
 console.log('PASS identical MCP calls use their native tool IDs, retain separate callbacks and may finish out of order');
 pause=false;const before=calls.length;await batch(['legacy-a','legacy-b'].map(description=>({description,mcp:{omitIdentity:true,finishDelay:200}})));assert.equal(calls.length,before);for(const label of ['legacy-a','legacy-b'])assert.match((completed.get(label) as ClaudeResult).result.result,/refused/);
 await batch([{description:'legacy-single',mcp:{omitIdentity:true}}]);assert.ok(calls.includes('legacy-single'));
 pause=true;await session.submit(options({action:'agent',children:['cancelled','survivor'].map(description=>({description,mcp:{}}))}));await wait(()=>calls.includes('cancelled')&&calls.includes('survivor'));
 await session.stopTask(tasks.get('cancelled')!);await wait(()=>signals.get('cancelled')!.aborted);assert.equal(signals.get('survivor')!.aborted,false);release.get('survivor')!();await wait(()=>completed.has('cancelled')&&completed.has('survivor'));assert.equal((completed.get('cancelled') as ClaudeResult).status,'stopped');assert.equal((completed.get('survivor') as ClaudeResult).status,'completed');
 pause=false;
 for(const [description,mcp] of [['unknown-id',{toolId:'unknown'}],['invalid-id',{toolId:123}],['mismatched-input',{callArguments:{wrong:true}}]] as const){const before=calls.length;await batch([{description,mcp}]);assert.equal(calls.length,before);assert.match((completed.get(description) as ClaudeResult).result.result,/refused/);}
 await batch([{description:'duplicate',mcp:{duplicate:true}}]);assert.equal(calls.filter(v=>v==='duplicate').length,1);assert.match((completed.get('duplicate') as ClaudeResult).result.result,/refused/);
 const early=options({action:'agent',children:[{description:'early',mcp:{early:true}}]});early.delegation=async task=>({options:{...options({},task.description),work:{before:async()=>{await new Promise(r=>setTimeout(r,150));},after:async()=>{}}},complete:value=>completed.set(task.description,value)});
 await session.submit(early);await wait(()=>completed.has('early'));assert.ok(!calls.includes('early'));assert.match((completed.get('early') as ClaudeResult).result.result,/refused/);
 await batch([{description:'after-end',mcp:{terminalBeforeCall:true}}]);await wait(()=>events.some(e=>e.label==='after-end'&&e.event.type==='runtime.agentResult'&&e.event.usage));assert.ok(!calls.includes('after-end'));assert.match(events.find(e=>e.label==='after-end'&&e.event.type==='runtime.agentResult'&&e.event.usage).event.summary,/refused/);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({identicalCalls:true,independentCompletion:true,scopedCancellation:true,legacyUnique:true,ambiguousLegacyRefused:true,invalidIdentityRefused:true,argumentMatch:true,duplicateRefused:true,admissionRequired:true,completedTaskRefused:true},null,2));
 console.log('PASS scoped Stop, legacy compatibility, identity/argument/admission checks and duplicate refusal. Evidence: '+data);
}finally{await session.close();}
