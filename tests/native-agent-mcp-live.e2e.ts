// Opt-in, read-only Claude subscription check with a private in-process MCP tool.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ClaudeSession,findClaude,type ClaudeRun,type ClaudeResult} from '../app/claude';
import {SecretScrubber} from '../app/redaction';
if(process.env.TRISMEGISTUS_LIVE_CLAUDE!=='1')throw Error('Set TRISMEGISTUS_LIVE_CLAUDE=1 for the live check.');
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-agent-mcp-live-')),cli=await findClaude();if(!cli)throw Error('Claude is unavailable.');
const calls:{owner:string;id:unknown;marker:string}[]=[],completed=new Map<string,ClaudeResult|Error>(),events:any[]=[],markers=new Map<string,string>();let both!:()=>void;const together=new Promise<void>(r=>both=r),controller=new AbortController();
const mcp=(owner:string)=>({names:['probe'],managedTools:['mcp__probe__echo'],handle:async(_server:string,message:any,signal:AbortSignal)=>{
 const reply=(result:any)=>({jsonrpc:'2.0',id:message.id,result});
 if(message.method==='initialize')return reply({protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}});
 if(message.method==='tools/list')return reply({tools:[{name:'echo',description:'Read this task’s probe marker.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]});
 if(message.method!=='tools/call')return reply({});
 assert.notEqual(owner,'parent');assert.deepEqual(message.params.arguments,{});const marker=markers.get(owner)!;calls.push({owner,id:message.params._meta?.['claudecode/toolUseId'],marker});if(calls.length===2)both();
 await Promise.race([together,new Promise<void>((_,reject)=>{signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true});})]);
 return reply({content:[{type:'text',text:marker}]});
}});
const options=(owner='parent'):ClaudeRun=>({executable:cli.executable,python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'haiku',effort:'low',mode:'manual',hasFolder:true,prompt:'Launch two general-purpose Haiku Agents concurrently. Each must call mcp__probe__echo with exactly {} once and return only its marker. Only Agent, ToolSearch and that MCP tool may be used. Do not call echo yourself.',signal:controller.signal,scrubber:new SecretScrubber(),mcp:mcp(owner),work:{before:async(_id,name)=>{if(!['Agent','ToolSearch','mcp__probe__echo'].includes(name))throw Error('Read-only probe');},after:async()=>{}},approve:async(_id,name)=>['Agent','ToolSearch','mcp__probe__echo'].includes(name),event:event=>events.push({owner,event}),delegation:async task=>{markers.set(task.id,'marker-'+crypto.randomUUID());return {options:options(task.id),complete:value=>completed.set(task.id,value)};}});
const session=await ClaudeSession.open(options()),timeout=setTimeout(()=>controller.abort(),90000);
try{
 const parent=session.submit(options());await parent;
 const until=Date.now()+85000;while(completed.size<2&&Date.now()<until&&!controller.signal.aborted)await new Promise(r=>setTimeout(r,100));
 assert.equal(calls.length,2);assert.equal(new Set(calls.map(c=>c.owner)).size,2);assert.equal(new Set(calls.map(c=>c.id)).size,2);assert.equal(completed.size,2);
 for(const call of calls){assert.equal((completed.get(call.owner) as ClaudeResult).status,'completed');const own=events.filter(e=>e.owner===call.owner&&e.event.type==='user').map(e=>e.event.message);assert.match(JSON.stringify(own),new RegExp(call.marker));assert.doesNotMatch(JSON.stringify(own),new RegExp(calls.find(c=>c.owner!==call.owner)!.marker));}
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({version:cli.version,simultaneousIdenticalCalls:true,separateResults:true,calls},null,2));console.log('PASS real Claude agents make simultaneous identical MCP calls through owned callbacks. Evidence: '+data);
}finally{clearTimeout(timeout);await fs.writeFile(path.join(data,'events.json'),JSON.stringify(events,null,2));await session.close();}
