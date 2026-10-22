import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Backend} from '../app/backend';
import {McpOwner} from '../app/mcp-owner';
import {mcpExchange} from '../app/mcp-exchange';
import {findClaude,runClaude} from '../app/claude';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','mcp-claude-'));
const backend=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await backend.host('initialize');
const owner=new McpOwner(backend,()=>{});let id:string|undefined;
try{
 const cli=await findClaude();assert.ok(cli,'Native Claude Code required');
 id=await owner.request('add',{name:'Native MCP fixture',config:{command:backend.python,args:[path.join(root,'tests/fixtures/mcp_stdio.py')],env:{SERVICE_KEY:'synthetic-native-mcp-key'}}});
 const exchange=mcpExchange(owner,await owner.request('list')),methods:string[]=[];
 const mcp={names:exchange.names,handle:async(server:string,message:any,signal:AbortSignal)=>{methods.push(message.method);return exchange.handle(server,message,signal);}};
 const base={executable:cli.executable,python:backend.python,worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'claude-haiku-4-5',effort:'low',mode:'manual' as const,hasFolder:true,scrubber:backend.scrubber,mcp,signal:AbortSignal.timeout(60000),event:()=>{},approve:async()=>false};
 const result=await runClaude({...base,inspectMcp:true,prompt:''});
 assert.equal(result.status,'completed');
 await fs.writeFile(path.join(data,'discovery.json'),JSON.stringify({result:result.result,methods},null,2));
 assert.ok(methods.includes('initialize')&&methods.includes('tools/list'),JSON.stringify({methods,result:result.result}));
 assert.match(JSON.stringify(result.result),/connected/);
 assert.doesNotMatch(JSON.stringify(result.result),/synthetic-native-mcp-key/);
 console.log('PASS installed Claude SDK MCP transport: private control pipe initialization and real owner tool discovery, no model prompt');
 if(process.env.TRISMEGISTUS_LIVE_MCP==='1'){
  let approvals=0;
  const live=await runClaude({...base,signal:AbortSignal.timeout(90000),prompt:'Call the connected MCP echo tool exactly once with marker "native-mcp-copperfinch". Report the marker returned. Do not use other tools.',approve:async(_id,name)=>{assert.match(name,/echo$/);approvals++;return true;}});
  assert.equal(live.status,'completed',JSON.stringify(live.result));assert.match(live.result.result,/native-mcp-copperfinch/);assert.ok(methods.includes('tools/call'));assert.ok(approvals>0);assert.doesNotMatch(JSON.stringify(live.result),/synthetic-native-mcp-key/);
  console.log('PASS real Claude model MCP call with app approval and redacted server result');
 }
}finally{if(id)await owner.request('remove',{id}).catch(()=>{});await owner.stop();}
