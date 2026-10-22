import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','mcp-chat-')),folder=await fs.mkdtemp(path.join(root,'work','mcp-chat-workspace-'));
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
 const page=await instance.firstWindow();const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean)=>{for(let i=0;i<500;i++){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(100);}throw Error('MCP chat state timed out');};
 await wait(state=>state.backend==='ready'&&state.claude?.connected);
 const id=await call('mcpAdd',{name:'Chat fixture',config:{command:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),args:[path.join(root,'tests/fixtures/mcp_stdio.py')],env:{SERVICE_KEY:'synthetic-chat-mcp-key'}}});
 await call('workingFolder',{folder});const a=await call('addProject'),b=await call('addProject');
 for(const chatId of [a,b]){await call('addModel',{chatId,model:'claude-code:haiku'});await call('modelSelection',{chatId,model:'claude-code:haiku',selected:true});}
 const submit=async(chatId:string,marker:string,tool='echo')=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:JSON.stringify({action:'mcp',marker,tool})});return id;};
 const approve=async(turnId:string,choice='once')=>{const state=await wait(state=>state.approvals.some((approval:any)=>approval.turnId===turnId&&approval.status==='pending'));const pending=state.approvals.find((approval:any)=>approval.turnId===turnId&&approval.status==='pending');await call('approve',{id:pending.id,choice});return pending.id;};
 const done=(turnId:string)=>wait(state=>state.turns.some((turn:any)=>turn.id===turnId&&turn.status==='completed'));
 const [ta,tb]=await Promise.all([submit(a,'chat-a-copperfinch'),submit(b,'chat-b-silverfox')]);await Promise.all([approve(ta),approve(tb)]);await done(ta);let state=await done(tb);
 for(const [turnId,own,other] of [[ta,'chat-a-copperfinch','chat-b-silverfox'],[tb,'chat-b-silverfox','chat-a-copperfinch']]){
  const turn=state.turns.find((turn:any)=>turn.id===turnId);assert.match(turn.text,new RegExp(own));assert.doesNotMatch(turn.text,new RegExp(other+'|synthetic-chat-mcp-key'));
  const result=state.tools.find((tool:any)=>tool.turnId===turnId&&tool.name.startsWith('mcp__'));assert.match(JSON.stringify(result.result),new RegExp(own));assert.doesNotMatch(JSON.stringify(result.result),new RegExp(other+'|synthetic-chat-mcp-key'));
 }
 const denied=await submit(a,'denied-marker');await approve(denied,'deny');state=await done(denied);assert.equal(state.turns.find((turn:any)=>turn.id===denied).text,'denied');
 const slow=await submit(b,'cancel-marker','slow');await approve(slow);await wait(state=>state.turns.some((turn:any)=>turn.id===slow&&turn.status==='running'));await call('stop',{chatId:b});await wait(state=>state.turns.some((turn:any)=>turn.id===slow&&turn.status==='stopped'));
 const uncertain=(await wait(state=>state.workReview?.some((row:any)=>row.args?.marker==='cancel-marker'))).workReview.find((row:any)=>row.args?.marker==='cancel-marker');await call('inspectWork',{id:uncertain.id,note:'Checked the echo fixture: the stopped call changed nothing.'});
 const next=await submit(b,'after-cancel');await approve(next);await done(next);
 const waiting=await submit(a,'off-marker');await wait(state=>state.approvals.some((approval:any)=>approval.turnId===waiting&&approval.status==='pending'));await call('mcpAction',{id,action:'off'});await approve(waiting);state=await done(waiting);assert.match(state.turns.find((turn:any)=>turn.id===waiting).text,/off/);
 await call('mcpAction',{id,action:'remove'});
 console.log('PASS desktop Claude MCP private bridge: two simultaneous chat approvals/results isolated, denial, cancellation followed by next call, off blocks an already-listed tool');
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close();}
