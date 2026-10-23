// Protocol fixture: exercises app/worker behavior, never claims a live Claude turn.
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
// Sign-in: records the call and finishes, as Claude Code's own sign-in does once the browser returns.
if(process.argv.slice(-3).join(' ')==='auth login --claudeai'){const record=process.argv.indexOf('--fixture-record');if(record>=0)fs.appendFileSync(path.join(path.dirname(process.argv[record+1]),'login-requests.jsonl'),JSON.stringify({args:process.argv.slice(2)})+'\n');process.exit(0);}
if(process.argv.includes('--fixture-oneshot')){
 let prompt='';for await(const bytes of process.stdin)prompt+=bytes;const input=JSON.parse(prompt);
 const source=[input.previousSummary||'',...(input.records||[]).map(r=>r.text)].join('\n');
 if(source.includes('SLOW_CONTEXT_FIXTURE'))await new Promise(r=>setTimeout(r,6000));
 const anchors=[...new Set(source.match(/ANCHOR_[A-Za-z0-9_-]+/g)||[])];
 const record=process.argv.indexOf('--fixture-record');if(record>=0)fs.appendFileSync(path.join(path.dirname(process.argv[record+1]),'context-requests.jsonl'),JSON.stringify({prompt,args:process.argv.slice(2)})+'\n');
 const system=process.argv[process.argv.indexOf('--append-system-prompt')+1]||'';
 let result=input.kind==='rlm-history'?JSON.stringify({answer:'Saved decision retrieved.',evidence:input.sources?[{id:input.sources[0].id,quote:input.sources[0].text.slice(0,80)}]:input.findings[0].evidence}):'Reviewed fixture decisions: '+anchors.join(', ')+'. Keep recorded outcomes and inspect current files before editing.';
 if(system.startsWith('Suggest sources an update watcher'))result=JSON.stringify({sources:'Two Minute Papers news'});
 if(system.startsWith('Plan web searches'))result=JSON.stringify({queries:[input.brief]});
 if(system.startsWith('Build an app overview'))result=JSON.stringify({items:[{kind:'current',text:'Claude fixture finding',evidence:[{sourceId:input.sources[0].id,quote:String(input.sources[0].text).slice(0,40)}]}]});
 if(system.startsWith('Write a short dashboard title'))result=JSON.stringify({items:input.todos.map(todo=>({id:todo.id,text:'Claude title'}))});
 if(system.startsWith('Review recent items for one app'))result=JSON.stringify({ideas:[{title:'Try Fixture video model',summary:'Open weights released.',why:'Local video rendering.',change:'Add it as a render backend.',effort:'small',sources:[input.items[0].id]},{title:'Unsourced',summary:'Not fetched.',change:'Do not show.',sources:['missing']}]});
 // Side answers (FEATURE-SPECS 2): the sorter sends every message to the main model unless it carries SIDE_FIXTURE.
 if(system.startsWith('The user sent this message while'))result=String(input.question).includes('SIDE_FIXTURE')?'Side fixture (sorted): '+input.live.status:'MAIN';
 if(system.startsWith('The user asked a quick question'))result='Side fixture: '+input.live.status+', '+String(input.live.textSoFar||'').length+' characters so far.';
 process.stdout.write(JSON.stringify({is_error:false,result,usage:{input_tokens:500,output_tokens:80,cache_read_input_tokens:100,cache_creation_input_tokens:200}}));process.exit(0);
}
const lines=createInterface({input:process.stdin});
const resumeAt=process.argv.indexOf('--resume'),sessionId=resumeAt>=0?process.argv[resumeAt+1]:crypto.randomUUID();
const pending=new Map();let count=0,workHooks=false;
const modeTest=()=>{const index=process.argv.indexOf('--fixture-record');if(index<0)return null;try{return JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[index+1]),'mode-test.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const modeRecord=(phase,mode)=>{const index=process.argv.indexOf('--fixture-record');fs.appendFileSync(path.join(path.dirname(process.argv[index+1]),'mode-events.jsonl'),JSON.stringify({phase,mode,pid:process.pid,model:process.argv[process.argv.indexOf('--model')+1]})+'\n');};
const context=new AsyncLocalStorage(),tasks=new Map();let current,contextTokens=250;
// Claude Code's turn contract, copied from the 10-14 raw stream of his 2.1.283 (TURN-REVIEW section 5): one turn at a
// time; session_state_changed running/idle; command_lifecycle queued/started/completed/cancelled by command_uuid; a
// message sent mid-reply is read after the current tool and answered in the same reply; 'later' waits for the turn to
// end; back-to-back turns have no idle between them; job notices are turns Claude starts itself (init, no lifecycle).
// --fixture-no-events leaves out the state and lifecycle events (Tris's fallback).
const quiet=process.argv.includes('--fixture-no-events'),replays=process.argv.includes('--replay-user-messages');
const queue=[];let state='idle',running=null;
const emit=message=>process.stdout.write(JSON.stringify({...message,session_id:sessionId,uuid:message.uuid||crypto.randomUUID()})+'\n');
const setState=next=>{if(state===next)return;state=next;if(!quiet&&process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS==='1')emit({type:'system',subtype:'session_state_changed',state:next});};
const lifecycle=(id,phase)=>{if(!quiet)emit({type:'command_lifecycle',command_uuid:id,state:phase});};
const replay=item=>{if(replays)emit(item.kind==='human'?{type:'user',uuid:item.id,isReplay:true,parent_tool_use_id:null,message:{role:'user',content:item.content}}:{type:'user',isReplay:true,parent_tool_use_id:null,origin:{kind:'task-notification'},message:{role:'user',content:item.prompt}});};
const enqueue=item=>{setState('running');if(item.kind==='human')lifecycle(item.id,'queued');queue.push(item);void pump();};
async function pump(){
  if(running)return;const item=queue.shift();if(!item){setState('idle');return;}
  const turn=running={id:item.kind==='human'?item.id:crypto.randomUUID(),isTurn:true,owner:item.kind==='human'?item.id:undefined,ids:item.kind==='human'?[item.id]:[],joined:[],origin:{kind:item.kind==='human'?'human':'task-notification'},promptId:crypto.randomUUID(),cancelled:false,done:false};current=turn;
  const ended=new Promise(resolve=>{turn.resolve=resolve;});
  if(item.kind==='human')lifecycle(item.id,'started');
  emit({type:'system',subtype:'init'});replay(item);
  void item.run(turn).catch(error=>context.run(turn,()=>result({is_error:true,result:String(error)})));
  await ended;running=null;setImmediate(()=>void pump());
}
// Messages that arrived mid-reply are read after the current tool, inside the same turn.
const fold=turn=>{
  for(const item of [...queue])if(item.kind==='notice'||item.priority!=='later'){
    queue.splice(queue.indexOf(item),1);replay(item);
    if(item.kind==='human'){lifecycle(item.id,'started');turn.ids.push(item.id);turn.joined.push(item.id);record({prompt:item.prompt,content:item.content,folded:true});}
  }
};
const record=value=>{const index=process.argv.indexOf('--fixture-record');if(index>=0)fs.appendFileSync(process.argv[index+1],JSON.stringify({...value,args:process.argv.slice(2),pid:process.pid,sessionId})+'\n');};
const notice=(prompt,run)=>enqueue({kind:'notice',prompt,run:turn=>context.run(turn,async()=>{
  const gate=await request({subtype:'hook_callback',callback_id:'turn-owner',input:{hook_event_name:'UserPromptSubmit',prompt}});
  if(gate.decision==='block'){result({is_error:true,result:gate.reason,num_turns:0});return;}
  await run(turn);
})});
const send=message=>{
  const scope=context.getStore(),stamp=id=>scope&&!id.startsWith(scope.id+':')?scope.id+':'+id:id;
  if(scope?.silentTools&&message.message?.content?.some(b=>['tool_use','tool_result'].includes(b.type)))return;
  if(scope){
    if(scope.agentId&&['assistant','user','stream_event'].includes(message.type))message={...message,parent_tool_use_id:scope.parentToolId,...(message.type==='assistant'?{message:{...message.message,model:scope.resolvedModel}}:{})};
    if(message.tool_use_id)message={...message,tool_use_id:stamp(message.tool_use_id)};
    if(Array.isArray(message.message?.content))message={...message,message:{...message.message,content:message.message.content.map(b=>b.type==='tool_use'?{...b,id:stamp(b.id)}:b.type==='tool_result'?{...b,tool_use_id:stamp(b.tool_use_id)}:b)}};
  }
  process.stdout.write(JSON.stringify(message)+'\n');
  if(scope?.isTurn&&!scope.done&&message.type==='user'&&message.message?.content?.some?.(b=>b.type==='tool_result'))fold(scope);
};
const request=request=>new Promise(resolve=>{
  const scope=context.getStore();
  if(scope&&request.subtype==='hook_callback'){
    request={...request,input:{...request.input,cwd:request.input.cwd||scope.cwd||process.cwd(),prompt_id:scope.promptId,...(scope.agentId?{agent_id:scope.agentId,permission_mode:scope.permissionMode,...(scope.effort?{effort:{level:scope.effort}}:{})}:{})}};
    if(request.input.tool_use_id)request.input.tool_use_id=scope.id+':'+request.input.tool_use_id;
    if(request.callback_id==='fixed-protection')scope.toolId=request.input.tool_use_id;
  }
  if(scope&&request.subtype==='can_use_tool')request={...request,tool_use_id:scope.toolId,...(scope.agentId?{agent_id:scope.agentId}:{})};
  const request_id=String(++count);pending.set(request_id,resolve);send({type:'control_request',request_id,request});
});
const result=(value={})=>{
  const turn=context.getStore();if(!turn?.isTurn||turn.done)return;turn.done=true;
  const end=turn.cancelled?'cancelled':'completed';for(const id of turn.joined)lifecycle(id,end);
  process.stdout.write(JSON.stringify({type:'result',subtype:turn.cancelled?'error_during_execution':'success',session_id:sessionId,is_error:turn.cancelled,result:'fixture complete',usage:{input_tokens:100,output_tokens:20},num_turns:1,...value,user_message_uuids:turn.ids,...(turn.owner?{}:{origin:turn.origin})})+'\n');
  if(turn.owner)lifecycle(turn.owner,end);turn.resolve();
};
const recordIndex=process.argv.indexOf('--fixture-record'),healthFile=recordIndex>=0?path.join(path.dirname(process.argv[recordIndex+1]),'health.json'):'';
function health(value){if(!healthFile||!fs.existsSync(healthFile))return 'unknown';const data=JSON.parse(fs.readFileSync(healthFile,'utf8'));if(value!==undefined){data.claude=value;fs.writeFileSync(healthFile,JSON.stringify(data));}return data.claude||'unknown';}
lines.on('line',async line=>{
  const message=JSON.parse(line);
  if(message.type==='control_response'){pending.get(message.response.request_id)?.(message.response.response);pending.delete(message.response.request_id);return;}
  if(message.type==='control_request'&&message.request.subtype==='initialize'){
    // models-loading.e2e: a file beside the records delays the model list, like a slow Claude start.
    const delay=recordIndex>=0?path.join(path.dirname(process.argv[recordIndex+1]),'initialize-delay'):'';while(delay&&fs.existsSync(delay))await new Promise(resolve=>setTimeout(resolve,100));
    const modes=modeTest();if(modes&&process.argv.includes('no-auto'))await new Promise(resolve=>setTimeout(resolve,200));
    if(recordIndex>=0)fs.appendFileSync(path.join(path.dirname(process.argv[recordIndex+1]),'initializations.jsonl'),JSON.stringify({agents:message.request.agents})+'\n');
    workHooks=Boolean(message.request.hooks?.PostToolUse);
    send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{agents:[{name:'fixture:haiku',model:'haiku'},{name:'fixture:full',model:'claude-haiku-4-5-20251001'},{name:'fixture:inherit',model:'inherit'}],models:[{value:'haiku',displayName:'Haiku fixture',supportedEffortLevels:['low','medium','high']},...(modes?[{value:'no-auto',displayName:'No Auto fixture',supportedEffortLevels:['low','medium','high']}]:[])]}}});return;
  }
  if(message.type==='control_request'){
    if(message.request.subtype==='interrupt'){
      send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{still_queued:queue.filter(item=>item.kind==='human').map(item=>item.id)}}});
      if(running&&!running.done){running.cancelled=true;context.run(running,()=>result({result:'Interrupted'}));}
      return;
    }
    if(message.request.subtype==='cancel_async_message'){
      const item=queue.find(item=>item.kind==='human'&&item.id===message.request.message_uuid);
      if(item){queue.splice(queue.indexOf(item),1);lifecycle(item.id,'cancelled');if(!running&&!queue.length)setState('idle');}
      send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{cancelled:!!item}}});return;
    }
    if(message.request.subtype==='stop_task'){
      const task=tasks.get(message.request.task_id);
      if(!task){send({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Unknown task'}});return;}
      task.stopped=true;if(task.agentScope){task.agentScope.cancelled=true;context.run(task.scope,()=>send({type:'system',subtype:'task_updated',task_id:message.request.task_id,patch:{status:'killed'}}));}else task.child.kill();
    }
    if(message.request.subtype==='set_permission_mode'){
      const modes=modeTest(),mode=message.request.mode;if(modes){modeRecord('received',mode);await new Promise(resolve=>setTimeout(resolve,modes.delay||0));}
      if(mode==='auto'&&process.argv.includes('no-auto')||modes?.rejectMode===mode&&process.argv.includes(modes.rejectModel)){if(modes)modeRecord('rejected',mode);send({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:mode==='auto'?'Auto is unavailable for this model.':'Permission mode unavailable for this model.'}});return;}
      if(modes)modeRecord('applied',mode);
    }
    const state=health();const response=message.request.subtype==='get_usage'?{subscription_type:'fixture',rate_limits_available:state!=='unknown',...(state==='unknown'?{}:{rate_limits:{five_hour:{utilization:state==='exhausted'?100:12,resets_at:'2100-01-01T00:00:00Z'}}})}:{totalTokens:contextTokens,maxTokens:200000};
    send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response}});return;
  }
  if(message.type!=='user')return;
  const content=message.message.content,rawPrompt=Array.isArray(content)?content[0].text:content,prompt=rawPrompt.replace(/^\[(?:Ghidorah|Trismegistus) turn [^\]]+\]\n/,'');
  enqueue({kind:'human',id:message.uuid||crypto.randomUUID(),priority:message.priority||'next',content,prompt,run:turn=>context.run(turn,async()=>{
  contextTokens=prompt.includes('HIGH_CONTEXT_FIXTURE')?150000:250;
  try{const parsed=JSON.parse(prompt);if(parsed.beforePromptDelay)await new Promise(r=>setTimeout(r,parsed.beforePromptDelay));}catch{}
  const promptGate=await request({subtype:'hook_callback',callback_id:'turn-owner',input:{hook_event_name:'UserPromptSubmit',prompt:rawPrompt}});
  if(promptGate.decision==='block'){result({is_error:true,result:promptGate.reason,num_turns:0});return;}
  record({prompt,content});
  let spec;try{spec=JSON.parse(prompt);}catch{
    const current=prompt.split('Current user message:').at(-1);
    try{spec=JSON.parse(current);}catch{spec=current.includes('PARALLEL_BOARD_FIXTURE')?{action:'mcp',server:'ghidorah',tool:'parallel_work',arguments:{operation:'note',text:'Claude board finding'}}:current.includes('WRITE_CLAUDE')?{action:'write',path:'claude-result.txt'}:current.includes('SLOW_CLAUDE')?{action:'slow'}:{action:'reply'};}
  }
  const goalFixture=/GOAL_FIXTURE (\{[^\n]+\})/.exec(prompt.split('Current user message:').at(-1));
  if(goalFixture){const config=JSON.parse(goalFixture[1]);spec={action:'mcp',server:'ghidorah',tool:'goal_status',arguments:{status:config.status||'complete',summary:'Native fixture verified the outcome',evidence:'Native MCP goal tool returned in this chat.'}};}
  if(spec.action==='limit'){
    health('unknown');send({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:spec.window||'five_hour',resetsAt:spec.reset||4102444800,utilization:1}});
    send({type:'assistant',error:'rate_limit',message:{content:[]}});result({is_error:true,errors:['Usage limit reached.'],result:'Usage limit reached.'});
  }else if(spec.action==='auth-failure'){
    health('unknown');send({type:'assistant',error:'authentication_failed',message:{content:[]}});result({is_error:true,errors:['Sign in again.']});
  }else if(spec.action==='mcp'){
    const searchInput={query:spec.tool||'echo'};
    const searchGate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:'search-call',tool_name:'ToolSearch',tool_input:searchInput}});
    if(searchGate.continue===false||searchGate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'catalogue denied by fixed protection'});return;}
    const searchApproval=await request({subtype:'can_use_tool',tool_name:'ToolSearch',input:searchInput});if(searchApproval.behavior!=='allow'){result({result:'catalogue denied'});return;}
    const config=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8'));
    const server=spec.server||Object.keys(config.mcpServers)[0];
    const rpc=async(method,params)=>{const answer=await request({subtype:'mcp_message',server_name:server,message:{jsonrpc:'2.0',id:++count,method,params}});return answer.mcp_response;};
    await rpc('initialize',{protocolVersion:'2025-11-25'});const listing=await rpc('tools/list');
    if(spec.requiredTools?.some(name=>!listing.result?.tools.some(tool=>tool.name===name))){result({is_error:true,result:'Missing promised app tools'});return;}
    if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:listing.error?'PostToolUseFailure':'PostToolUse',tool_use_id:'search-call',tool_name:'ToolSearch',tool_input:searchInput,tool_response:listing}});
    if(!listing.result?.tools.some(tool=>tool.name===(spec.tool||'echo'))){result({is_error:true,result:'No MCP tool'});return;}
    const input=spec.arguments||{marker:spec.marker},name=`mcp__${server}__${spec.tool||'echo'}`;
    send({type:'assistant',message:{content:[{type:'tool_use',id:'mcp-call',name,input}]}});
    const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:'mcp-call',tool_name:name,tool_input:input}});
    if(gate.continue===false||gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'denied by fixed protection'});return;}
    const approval=await request({subtype:'can_use_tool',tool_name:name,input});
    if(approval.behavior!=='allow'){result({result:'denied'});return;}
    const answer=await rpc('tools/call',{name:spec.tool||'echo',arguments:input});
    if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:answer.error?'PostToolUseFailure':'PostToolUse',tool_use_id:'mcp-call',tool_name:name,tool_input:input,tool_response:answer}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'mcp-call',content:JSON.stringify(answer),is_error:!!answer.error}]}});
    result({result:JSON.stringify(answer)});
  }else if(spec.action==='read-point'){
    const wait=async file=>{for(const end=Date.now()+120000;!fs.existsSync(file);){if(context.getStore().cancelled)return false;if(Date.now()>end)throw Error('Read-point fixture timed out');await new Promise(resolve=>setTimeout(resolve,50));}return true;};
    for(const [index,text] of ['Before reading.\n\n','After reading.\n\n'].entries()){
      send({type:'stream_event',event:{delta:{type:'text_delta',text}}});
      send({type:'assistant',message:{content:[{type:'tool_use',id:'read-'+index,name:'Read',input:{file_path:spec.releases[index]}}]}});
      if(!await wait(spec.releases[index]))return;
      send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-'+index,content:'done'}]}});
    }
    result({result:spec.keepText?'Before reading.\n\nAfter reading.\n\n':'Final answer.'});
  }else if(spec.action==='powershell'){
    const command='Get-ExecutionPolicy -Scope Process; Get-ExecutionPolicy -List',name='Bash',id='policy-call',input={command:'powershell -NoProfile -Command "'+command+'"'};
    send({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}});
    const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{hook_event_name:'PreToolUse',tool_use_id:id,tool_name:name,tool_input:input}});
    if(gate.continue===false||gate.hookSpecificOutput?.permissionDecision==='deny'){result({is_error:true,result:'Policy check blocked'});return;}
    const permission=await request({subtype:'can_use_tool',tool_name:name,input});if(permission.behavior!=='allow'){result({is_error:true,result:'Policy check denied'});return;}
    const child=spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}),output=child.stdout+child.stderr,failed=child.status!==0;
    if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:failed?'PostToolUseFailure':'PostToolUse',tool_use_id:id,tool_name:name,tool_input:input,tool_response:output}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:output,is_error:failed}]}});
    result({result:output,is_error:failed});
  }else if(spec.action==='recovery'){
    let step=0;
    for(const [name,input] of [['Bash',{command:spec.command}],['Write',{file_path:spec.path,content:'Recovered after the failed cleanup check.'}],['Edit',{file_path:spec.path,old_string:'Recovered',new_string:'Continued'}],['Edit',{file_path:spec.path,old_string:'Continued',new_string:'Recovered and edited twice'}]]){
      const id='recover-'+(++step)+'-'+name;
      send({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}});
      const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{hook_event_name:'PreToolUse',tool_use_id:id,tool_name:name,tool_input:input}});
      if(gate.continue===false||gate.hookSpecificOutput?.permissionDecision==='deny'){result({is_error:true,result:'Recovery blocked: '+gate.hookSpecificOutput?.permissionDecisionReason});return;}
      const permission=await request({subtype:'can_use_tool',tool_name:name,input});if(permission.behavior!=='allow'){result({is_error:true,result:'Recovery denied'});return;}
      let output,failed=false;
      if(name==='Bash'){
        const process=spawnSync(globalThis.process.execPath,['-e',"const fs=require('fs');fs.unlinkSync(process.argv[1]);fs.statSync(process.argv[1]);",spec.temporary],{encoding:'utf8',windowsHide:true});
        if(process.error)throw process.error;failed=process.status!==0;output='Exit code '+process.status+'\n'+process.stderr;
      }else if(name==='Edit'){fs.writeFileSync(spec.path,fs.readFileSync(spec.path,'utf8').replace(input.old_string,input.new_string));output='Edited';}
      else{fs.writeFileSync(spec.path,input.content);output='Written';}
      if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:failed?'PostToolUseFailure':'PostToolUse',tool_use_id:id,tool_name:name,tool_input:input,...(failed?{error:output}:{tool_response:output})}});
      send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:output,is_error:failed}]}});
    }
    result({result:'Recovery completed and replacement written.'});
  }else if(spec.action==='write'||spec.action==='read'){
    if(spec.readFirst||spec.action==='read'){
      const input={file_path:spec.path},toolId='read-before-write';
      send({type:'assistant',message:{content:[{type:'tool_use',id:toolId,name:'Read',input}]}});
      const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{hook_event_name:'PreToolUse',tool_use_id:toolId,tool_name:'Read',tool_input:input}});
      if(gate.continue===false||gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'read denied by fixed protection'});return;}
      const approval=await request({subtype:'can_use_tool',tool_name:'Read',input});
      if(approval.behavior!=='allow'){result({result:'read denied'});return;}
      const content=fs.readFileSync(spec.path,'utf8');
      if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:'PostToolUse',tool_use_id:toolId,tool_name:'Read',tool_input:input,tool_response:content}});
      send({type:'user',message:{content:[{type:'tool_result',tool_use_id:toolId,content}]}});
      if(spec.action==='read'){result({result:content});return;}
    }
    const input={file_path:spec.path,content:spec.content||'approved fixture'};
    send({type:'assistant',message:{content:[{type:'tool_use',id:'write-call',name:'Write',input}]}});
    const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{hook_event_name:'PreToolUse',tool_use_id:'write-call',tool_name:'Write',tool_input:input}});
    if(gate.continue===false||gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'denied by fixed protection'});return;}
    const approval=await request({subtype:'can_use_tool',tool_name:'Write',input});
    if(approval.behavior==='allow')fs.writeFileSync(spec.path,input.content);
    if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:approval.behavior==='allow'?'PostToolUse':'PostToolUseFailure',tool_use_id:'write-call',tool_name:'Write',tool_input:input,tool_response:approval.behavior,error:approval.behavior==='allow'?undefined:'denied'}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'write-call',content:approval.behavior,is_error:approval.behavior!=='allow'}]}});
    result({result:approval.behavior});
  }else if(spec.action==='skill'){
    const input={skill:'check'},id='skill-call';send({type:'assistant',message:{content:[{type:'tool_use',id,name:'Skill',input}]}});
    await new Promise(resolve=>setTimeout(resolve,spec.startDelay||0));
    if(modeTest())modeRecord('tool-gate-start','Skill');const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:id,tool_name:'Skill',tool_input:input}});if(modeTest())modeRecord('tool-gate-end','Skill');
    if(gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'skill denied before effect'});return;}
    const approval=await request({subtype:'can_use_tool',tool_name:'Skill',input});if(approval.behavior!=='allow'){result({result:'skill denied'});return;}
    fs.writeFileSync(spec.path,'skill effect');if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:'PostToolUse',tool_use_id:id,tool_name:'Skill',tool_input:input,tool_response:'skill completed'}});result({result:'skill completed'});
  }else if(spec.action==='agent'||spec.action==='resume-agent'){
    const specs=spec.children||[spec];let index=0;for(const spec of specs){
    const scope=context.getStore(),toolId='agent-call-'+index++,name=spec.action==='resume-agent'?'SendMessage':'Agent',input=name==='SendMessage'?{to:spec.to,message:'Continue the file task',summary:spec.description||'Resume agent'}:{description:spec.description||'Fixture agent',prompt:'Perform the assigned file task',subagent_type:spec.agentType||'general-purpose',...(spec.model!==null?{model:spec.model||'haiku'}:{})};
    send({type:'assistant',message:{content:[{type:'tool_use',id:toolId,name,input}]}});
    const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:toolId,tool_name:name,tool_input:input}});
    if(gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'agent denied'});return;}
    const id=name==='SendMessage'?spec.to:crypto.randomUUID(),agentScope={id:crypto.randomUUID(),promptId:scope.promptId,agentId:id,parentToolId:scope.id+':'+toolId,cwd:spec.cwd||scope.cwd||process.cwd(),cancelled:false,silentTools:spec.silentTools,resolvedModel:spec.resolvedModel||'claude-haiku-4-5-20251001',effort:spec.effort,permissionMode:spec.permissionMode||'default'},task={scope,agentScope,stopped:false};tasks.set(id,task);
    send({type:'system',subtype:'task_started',task_id:id,tool_use_id:toolId,task_type:'local_agent',description:input.description});
    if(spec.startDelay)await new Promise(resolve=>setTimeout(resolve,spec.startDelay));
    const start=await request({subtype:'hook_callback',callback_id:'agent-owner',input:{hook_event_name:'SubagentStart',agent_id:spec.claimedAgent||id,agent_type:input.subagent_type||spec.agentType||'general-purpose',cwd:agentScope.cwd}});
    if(start.continue===false){send({type:'system',subtype:'task_updated',task_id:id,patch:{status:'failed'}});result({result:'agent start blocked'});return;}
    if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:'PostToolUse',tool_use_id:toolId,tool_name:name,tool_input:input,tool_response:{isAsync:true,agentId:id,resolvedModel:agentScope.resolvedModel}}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:toolId,content:JSON.stringify({agentId:id})}]}});
    setTimeout(()=>void context.run(agentScope,async()=>{
      let answer=spec.summary||'Agent complete.';
      if(spec.mcp){
        const cfg=spec.mcp,name=`mcp__${cfg.server||'test'}__${cfg.tool||'echo'}`,input=cfg.arguments||{},id='child-mcp';
        send({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}});
        const gate=request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:id,tool_name:name,tool_input:input}});
        const call=()=>request({subtype:'mcp_message',server_name:cfg.server||'test',message:{jsonrpc:'2.0',id:++count,method:'tools/call',params:{name:cfg.tool||'echo',arguments:cfg.callArguments||input,...(!cfg.omitIdentity?{_meta:{'claudecode/toolUseId':cfg.toolId??agentScope.toolId}}:{})}}});
        if(cfg.early)answer=JSON.stringify((await call()).mcp_response);
        const allowed=(await gate).hookSpecificOutput?.permissionDecision!=='deny';
        if(allowed&&!cfg.early){
          const permission=await request({subtype:'can_use_tool',tool_name:name,input});
          if(permission.behavior==='allow'){await new Promise(resolve=>setTimeout(resolve,cfg.beforeCall||100));if(cfg.terminalBeforeCall){send({type:'system',subtype:'task_updated',task_id:agentScope.agentId,patch:{status:'completed'}});await new Promise(resolve=>setTimeout(resolve,25));}answer=JSON.stringify(cfg.duplicate?await Promise.all([call(),call()]):(await call()).mcp_response);}
          else answer='Child denied';
        }
        if(agentScope.cancelled)return;if(cfg.finishDelay)await new Promise(resolve=>setTimeout(resolve,cfg.finishDelay));
        if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:'PostToolUse',tool_use_id:id,tool_name:name,tool_input:input,tool_response:answer}});
        send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:answer}]}});
      }else for(const name of [...(spec.read?['Read']:[]),...(spec.readOnly?[]:['Write'])]){
        if(agentScope.cancelled)return;
        const id='child-'+name,input=name==='Read'?{file_path:spec.path}:{file_path:spec.path,content:spec.content||'agent-result'};
        send({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}});
        const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:id,tool_name:name,tool_input:input}});
        if(gate.hookSpecificOutput?.permissionDecision==='deny'){answer='Child refused: '+gate.hookSpecificOutput.permissionDecisionReason;break;}
        const permission=await request({subtype:'can_use_tool',tool_name:name,input});if(agentScope.cancelled)return;
        if(permission.behavior!=='allow'){answer='Child denied';break;}
        const file=path.resolve(agentScope.cwd,spec.path),output=name==='Read'?fs.readFileSync(file,'utf8'):(fs.writeFileSync(file,input.content),'written');
        if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:'PostToolUse',tool_use_id:id,tool_name:name,tool_input:input,tool_response:output}});
        send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:output}]}});
      }
      send({type:'assistant',message:{content:[{type:'text',text:answer}]}});
      context.run(scope,()=>{send({type:'system',subtype:'task_updated',task_id:id,patch:{status:'completed'}});send({type:'system',subtype:'task_notification',task_id:id,tool_use_id:toolId,status:'completed',summary:answer,usage:{total_tokens:123,tool_uses:spec.read?2:1}});});
      notice(`<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${scope.id}:${toolId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,async()=>result({result:'Agent update: '+answer}));
    }),spec.delay||150);
    }result({result:'Agent started.'});
  }else if(spec.action==='background'){
    const input={command:spec.command||'fixture server',run_in_background:true},toolId='background-call',scope=context.getStore();
    if(spec.inspect){
      const name='mcp__ghidorah__inspect_action',inspection={tool:'Bash',arguments:input,summary:'The fixture server opens only its assigned local HTTP listener; it has no shared file writes.',evidence:[],resources:[{kind:'port',value:'tcp:'+spec.port,access:'write'}]},id='inspect-background';
      send({type:'assistant',message:{content:[{type:'tool_use',id,name,input:inspection}]}});
      const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:id,tool_name:name,tool_input:inspection}});
      if(gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'inspection denied'});return;}
      const allowed=await request({subtype:'can_use_tool',tool_name:name,input:inspection});if(allowed.behavior!=='allow'){result({result:'inspection denied'});return;}
      const answer=await request({subtype:'mcp_message',server_name:'ghidorah',message:{jsonrpc:'2.0',id:++count,method:'tools/call',params:{name:'inspect_action',arguments:inspection}}});
      if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:'PostToolUse',tool_use_id:id,tool_name:name,tool_input:inspection,tool_response:answer}});
      send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:JSON.stringify(answer)}]}});
      if(answer.mcp_response?.error){result({result:JSON.stringify(answer)});return;}
    }
    send({type:'assistant',message:{content:[{type:'tool_use',id:toolId,name:'Bash',input}]}});
    const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:toolId,tool_name:'Bash',tool_input:input}});
    if(gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'denied by fixed protection'});return;}
    const approval=await request({subtype:'can_use_tool',tool_name:'Bash',input});if(approval.behavior!=='allow'){result({result:'denied'});return;}
    const id=crypto.randomUUID(),child=spawn(process.execPath,['-e',`require('http').createServer((q,s)=>s.end('native-fixture')).listen(${spec.port},'127.0.0.1');${spec.duration?`setTimeout(()=>process.exit(0),${spec.duration});`:''}`],{windowsHide:true,stdio:'ignore'});
    const task={child,scope,stopped:false};tasks.set(id,task);
    send({type:'system',subtype:'task_started',task_id:id,tool_use_id:toolId,task_type:'local_bash',is_backgrounded:true,description:input.command,childPid:child.pid});
    child.on('exit',()=>void context.run(scope,async()=>{
      send({type:'system',subtype:'task_updated',task_id:id,patch:{status:task.stopped?'killed':'completed'}});
      if(task.stopped)return;
      send({type:'system',subtype:'task_notification',task_id:id,tool_use_id:toolId,status:'completed'});
      notice(`<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${scope.id}:${toolId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,async automatic=>{
        if(spec.completionWrite){
          const input={file_path:spec.completionWrite,content:'background update'},toolId='completion-write';
          send({type:'assistant',message:{content:[{type:'tool_use',id:toolId,name:'Write',input}]}});
          const gate=await request({subtype:'hook_callback',callback_id:'fixed-protection',input:{tool_use_id:toolId,tool_name:'Write',tool_input:input}});
          if(gate.hookSpecificOutput?.permissionDecision==='deny'){result({result:'completion write blocked'});return;}
          const approval=await request({subtype:'can_use_tool',tool_name:'Write',input});
          if(automatic.cancelled)return;
          if(approval.behavior==='allow')fs.writeFileSync(spec.completionWrite,input.content);
          if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:approval.behavior==='allow'?'PostToolUse':'PostToolUseFailure',tool_use_id:toolId,tool_name:'Write',tool_input:input,tool_response:approval.behavior,error:approval.behavior==='allow'?undefined:'denied'}});
          send({type:'user',message:{content:[{type:'tool_result',tool_use_id:toolId,content:approval.behavior,is_error:approval.behavior!=='allow'}]}});
        }
        send({type:'stream_event',event:{delta:{type:'text_delta',text:'Background complete.'}}});
        if(spec.completionDelay)await new Promise(r=>setTimeout(r,spec.completionDelay));
        if(!automatic.cancelled)result({result:'Background complete.'});
      });
    }));
    if(workHooks)await request({subtype:'hook_callback',callback_id:'fixed-work-finish',input:{hook_event_name:'PostToolUse',tool_use_id:toolId,tool_name:'Bash',tool_input:input,tool_response:{backgroundTaskId:id}}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:toolId,content:JSON.stringify({backgroundTaskId:id})}]}});result({result:id});
  }else if(spec.action==='stream'){
    for(const text of ['before fixture-sec','ret after'])send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
    send({type:'assistant',message:{content:[{type:'text',text:'before fixture-secret after'}]}});result();
  }else if(spec.action==='thinking'){
    for(let i=0;i<100;i++){
      if(context.getStore().cancelled)return;
      send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'Thinking through the app folders and existing files.\n\n'}}});
      if(i%10===0)send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Checking the next folder.\n\n'}}});
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    result({result:'App inspection complete.'});
  }else if(spec.action==='reply'||spec.action==='slow'){
    const reply=spec.action==='slow'?'Slow Claude stream. '.repeat(spec.repeat||100):'Claude fixture retained copperfinch.';
    for(const text of reply.split(' ')){if(context.getStore().cancelled)return;send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:text+' '}}});await new Promise(resolve=>setTimeout(resolve,30));}
    if(!context.getStore().cancelled)result({result:reply});
  }else if(spec.action==='cancel'){
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    send({type:'system',subtype:'child',childPid:child.pid});
    setInterval(()=>{},1000);
  }
  })});
});
