// Explicit authorized packaged test in the canonical account home; no grant copies.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
if(process.env.TRISMEGISTUS_LIVE_MCP!=='1'||!process.env.TRISMEGISTUS_EXE||process.env.TRISMEGISTUS_TEST_DATA)throw Error('Use the explicit live packaged MCP check with the canonical account home.');
const root=path.resolve('.'),instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[],timeout:30000});
let connection:string|undefined,chatId:string|undefined;const results:any[]=[];
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
 const page=await instance.firstWindow(),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean|Promise<boolean>)=>{const until=Date.now()+180000;while(Date.now()<until){const state=await call('state');if(await predicate(state))return state;await page.waitForTimeout(150);}throw Error('Live MCP check timed out');};
 const state=await wait(state=>state.backend==='ready'&&state.codex?.models?.length&&state.claude?.models?.length);
 assert.ok(state.defaultFolder,'A root working folder is required.');assert.ok(!state.turns.some((turn:any)=>['running','waiting','queued','dispatching','stopping'].includes(turn.status)),'Do not interrupt user work.');
 connection=await call('mcpAdd',{name:'Trismegistus local MCP check',config:{command:path.join(path.dirname(process.env.TRISMEGISTUS_EXE),'resources/runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),args:[path.join(root,'tests/fixtures/mcp_stdio.py')],env:{SERVICE_KEY:'synthetic-live-mcp-credential'}}});
 await call('mcpAction',{id:connection,action:'test'});chatId=await call('addProject');
 const gpt=state.codex.models.find((name:string)=>name==='gpt-6-luna')||state.codex.models[0];
 const native=state.claude.models.find((model:any)=>model.id==='claude-code:haiku')||state.claude.models.find((model:any)=>model.id==='claude-code:claude-haiku-4-5');assert.ok(native);
 for(const model of [gpt,native.id,'deepseek-flash']){
  await call('addModel',{chatId,model});await call('effort',{chatId,model,effort:model==='deepseek-flash'?'high':'low'});await call('modelSelection',{chatId,model,selected:true});
  const id=crypto.randomUUID(),marker='mcp-check-'+results.length+'-copperfinch';
  await call('submit',{id,chatId,text:`MCP integration check: discover echo on connection ${connection} (Trismegistus local MCP check), then call only echo once with marker "${marker}". Reply with the returned marker. Do not use file or terminal tools.`});
  let approvals=0;const seen=new Set<string>();
  const completed=await wait(async state=>{
   for(const approval of state.approvals.filter((item:any)=>item.turnId===id&&item.status==='pending')){
    const description=String(approval.params.description||'');
    assert.ok(description.includes('echo')&&description.includes(marker),'Unexpected live action: '+description);
    if(!seen.has(approval.id)){seen.add(approval.id);approvals++;await call('approve',{id:approval.id,choice:'once'});}
   }
   return state.turns.some((turn:any)=>turn.id===id&&['completed','failed','interrupted','stopped'].includes(turn.status));
  });
  const turn=completed.turns.find((turn:any)=>turn.id===id);assert.equal(turn.status,'completed',turn.error);assert.match(turn.text,new RegExp(marker));assert.ok(approvals>0);
  const tools=completed.tools.filter((tool:any)=>tool.turnId===id);assert.ok(tools.some((tool:any)=>tool.name.includes('echo')||tool.name==='call_connected_tool'));assert.doesNotMatch(JSON.stringify({turn,tools}),/synthetic-live-mcp-credential/);
  results.push({model,turnId:id,approvals,tools:tools.map((tool:any)=>tool.name)});console.log('PASS packaged live MCP tool discovery, approval and redacted result: '+model);
 }
 await fs.writeFile(path.join(root,'work/live-mcp-results.json'),JSON.stringify({chatId,results},null,2));
}finally{
 const page=await instance.firstWindow().catch(()=>null);
 if(page){if(chatId)await page.evaluate(chatId=>window.desktop.invoke('stop',{chatId}),chatId).catch(()=>{});if(connection)await page.evaluate(id=>window.desktop.invoke('mcpAction',{id,action:'remove'}),connection).catch(()=>{});}
 await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close();
}
