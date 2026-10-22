// Real native transport; paid model checks require an explicit test flag.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Backend} from '../app/backend';
import {findClaude,runClaude} from '../app/claude';
import {mcpExchange} from '../app/mcp-exchange';
import {memoryContext,projectMemory} from '../app/project-memory';
import type {Mode} from '../app/types';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','native-memory-'));
const backend=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{}),profiles=['p-'+randomUUID(),'p-'+randomUUID()];
for(const profile of profiles){const home=path.join(data,'hermes/profiles',profile);await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'config.yaml'),'{}');}
const host=(profile:string,name:string,args:any={})=>backend.host('project_memory',{profile,name,arguments:args});
await host(profiles[0],'update_project_memory',{action:'add',content:'Project marker: copperfinch'});
await host(profiles[1],'update_project_memory',{action:'add',content:'OTHER-PROJECT-SILVERFOX'});
const cli=await findClaude();assert.ok(cli);
let mode:Mode='manual',approvals=0;
const memory=projectMemory(backend,profiles[0],()=>mode,async args=>{assert.equal(args.content,'Native memory integration verified');approvals++;return true;});
const mcp=mcpExchange({} as any,[],memory);
const base={executable:cli.executable,python:backend.python,worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:data,exchangeRoot:data,model:'claude-haiku-4-5',effort:'low',mode,hasFolder:false,scrubber:backend.scrubber,mcp,signal:AbortSignal.timeout(60000),event:()=>{},approve:async()=>false};
const discovery=await runClaude({...base,inspectMcp:true,prompt:''});assert.match(JSON.stringify(discovery.result),/connected/);
console.log('PASS real native discovery of app-owned project memory tools without a working folder');
if(process.env.TRISMEGISTUS_LIVE_CLAUDE==='1'){
 const snapshot=memoryContext(await host(profiles[0],'read_project_memory')),events:any[]=[];
 const live=await runClaude({...base,signal:AbortSignal.timeout(120000),projectMemory:snapshot,prompt:'Integration check. Use only read_project_memory and update_project_memory. Read project memory, then add exactly "Native memory integration verified" to target memory once, then report the saved project marker. Do not use file or shell tools.',event:event=>events.push(event)});
 await fs.writeFile(path.join(data,'live-result.json'),JSON.stringify({live,events},null,2));
 assert.equal(live.status,'completed',JSON.stringify(live.result));assert.equal(approvals,1);assert.match(live.result.result,/copperfinch/i);assert.doesNotMatch(JSON.stringify(events),/OTHER-PROJECT-SILVERFOX/);
 assert.match(JSON.stringify(await host(profiles[0],'read_project_memory')),/Native memory integration verified/);assert.doesNotMatch(JSON.stringify(await host(profiles[1],'read_project_memory')),/Native memory integration verified/);
 const names=events.flatMap(event=>event.type==='assistant'?event.message?.content?.filter((block:any)=>block.type==='tool_use').map((block:any)=>block.name)||[]:[]);assert.ok(names.includes('mcp__ghidorah__read_project_memory'));assert.ok(names.includes('mcp__ghidorah__update_project_memory'));
 mode='plan';const planEvents:any[]=[];
 const plan=await runClaude({...base,mcp:mcpExchange({} as any,[],memory),mode,signal:AbortSignal.timeout(120000),prompt:'Test the project-memory tools only: read project memory, then attempt update_project_memory with action add, target memory, content PLAN-MUST-NOT-SAVE. If the tool denies it, stop and report that denial. Do not use file or shell tools.',event:event=>planEvents.push(event)});
 await fs.writeFile(path.join(data,'plan-result.json'),JSON.stringify({plan,events:planEvents},null,2));
 assert.equal(plan.status,'completed',JSON.stringify(plan.result));assert.equal(approvals,1);assert.doesNotMatch(JSON.stringify(await host(profiles[0],'read_project_memory')),/PLAN-MUST-NOT-SAVE/);
 assert.ok(planEvents.some(event=>event.type==='user'&&JSON.stringify(event.message?.content).includes('Plan mode permits')),'App must enforce Plan even when native allows app-owned MCP calls');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({live:live.status,plan:plan.status,approvals,names},null,2));
 console.log('PASS real Claude project memory read/write, one app approval, no-root support, isolated profiles and app-enforced Plan denial');
}
