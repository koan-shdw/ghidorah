// Opt-in positive/negative control for native agent memory in a shared folder.
import {spawn,execFileSync} from 'node:child_process';import {createInterface} from 'node:readline';import {once} from 'node:events';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {findClaude,claudeEnvironment} from '../app/claude';
if(process.env.TRISMEGISTUS_LIVE_CLAUDE!=='1')throw Error('Explicit subscription-test opt-in required.');
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/agent-memory-control-')),folder=path.join(data,'workspace'),cli=await findClaude();assert.ok(cli);await fs.mkdir(folder);
execFileSync('git',['init','-q',folder],{windowsHide:true});
const scopes=['project','local'] as const,tokens=Object.fromEntries(scopes.map(scope=>[scope,'memory-'+scope+'-'+crypto.randomUUID()])),files:string[]=[];
for(const scope of scopes){const dir=path.join(folder,'.claude',scope==='local'?'agent-memory-local':'agent-memory','memory-'+scope);await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'MEMORY.md');await fs.writeFile(file,'NATIVE_MEMORY_TOKEN: '+tokens[scope]+'\n');files.push(file);}
const snapshots=await Promise.all(files.map(file=>fs.readFile(file,'utf8')));await fs.writeFile(path.join(data,'mcp.json'),'{"mcpServers":{}}');
async function run(disabled:boolean){
 const env=claudeEnvironment();if(!disabled)env.CLAUDE_CODE_DISABLE_AUTO_MEMORY='0';
 const worker=spawn(path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),[path.join(root,'backend/claude_worker.py')],{env,windowsHide:true,stdio:'pipe'}),lines=createInterface({input:worker.stdout}),records:any[]=[],controls=new Map<string,(v:any)=>void>(),tasks=new Map<string,string>();
 const send=(v:any)=>worker.stdin.write(JSON.stringify(v)+'\n'),command=(request:any)=>new Promise<any>(resolve=>{const id=crypto.randomUUID();controls.set(id,resolve);send({type:'control_request',request_id:id,request});});
 let parent:any,done!:(v:any)=>void;const answer=new Promise<any>(resolve=>done=resolve),finish=()=>{if(parent&&(parent.is_error||tasks.size===2&&[...tasks.values()].every(v=>['completed','failed','killed'].includes(v))))done(parent);};
 lines.on('line',line=>{const m=JSON.parse(line);records.push(m);if(m.type==='control_response'){controls.get(m.response.request_id)?.(m.response);return;}if(m.type==='result'){parent=m;finish();return;}if(m.type==='system'&&m.subtype==='task_started')tasks.set(m.task_id,'running');if(m.type==='system'&&['task_updated','task_notification'].includes(m.subtype)){const status=m.patch?.status||m.status;if(status)tasks.set(m.task_id,status);finish();}if(m.type!=='control_request')return;const r=m.request;let response:any={};
  if(r.subtype==='can_use_tool')response=r.tool_name==='Agent'?{behavior:'allow',updatedInput:r.input}:{behavior:'deny',message:'This control permits delegation only.'};
  if(r.subtype==='hook_callback'&&r.input?.hook_event_name==='PreToolUse'&&r.input.tool_name!=='Agent')response={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'No file or command tools in the memory control.'}};
  send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
 });
 worker.stderr.on('data',d=>records.push({stderr:String(d)}));const timer=setTimeout(()=>{worker.stdin.end();done({timeout:true});},120000);
 try{
  send({executable:cli!.executable,args:['-p','--model','sonnet','--effort','low','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-prompt-tool','stdio','--permission-mode','manual','--setting-sources','','--settings',JSON.stringify({autoMemoryEnabled:true}),'--strict-mcp-config','--mcp-config',path.join(data,'mcp.json'),'--tools','Agent,Read,Write,Edit'],cwd:folder});
  await command({subtype:'initialize',agents:Object.fromEntries(scopes.map(scope=>['memory-'+scope,{description:'Report the '+scope+' memory token already in initial context',prompt:'Return the exact NATIVE_MEMORY_TOKEN from your initial memory context. If none is present, return NO_NATIVE_MEMORY. Do not use any tools.',model:'haiku',memory:scope,tools:['Read']} ])),hooks:Object.fromEntries(['SubagentStart','PreToolUse','PostToolUse'].map(name=>[name,[{matcher:'',hookCallbackIds:['check']}]]))});
  send({type:'user',uuid:crypto.randomUUID(),message:{role:'user',content:'Invoke memory-project and memory-local once each using Agent, with run_in_background false. Ask each to report its NATIVE_MEMORY_TOKEN already in initial context, or NO_NATIVE_MEMORY if absent. Do no other work and use no other tools. Wait for both results and report them exactly.'}});
  const result=await answer;await fs.writeFile(path.join(data,disabled?'disabled.json':'enabled.json'),JSON.stringify({result,records},null,2));assert.ok(!result.timeout);assert.equal(result.is_error,false);assert.equal(tasks.size,2);assert.ok([...tasks.values()].every(v=>v==='completed'));
  const reports=JSON.stringify(records.filter(m=>m.type==='assistant'||m.type==='result'||m.type==='system'&&m.subtype==='task_notification'));
  for(const token of Object.values(tokens))if(disabled)assert.ok(!reports.includes(token));else assert.ok(reports.includes(token),'Positive control did not expose its seeded token');
  if(disabled)assert.match(reports,/NO_NATIVE_MEMORY/);
 }finally{clearTimeout(timer);worker.stdin.end();await once(worker,'close');lines.close();}
}
await run(false);console.log('PASS positive control: native project/local agent memory reached the agents.');await run(true);assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),snapshots);
await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({version:cli.version,positiveControl:true,disabledWithAppEnvironment:true,projectAndLocalMemoryAbsent:true,seedFilesUnchanged:true},null,2));console.log('PASS app environment disables both native agent memory scopes despite autoMemoryEnabled:true. Evidence: '+data);
