// claude.ai connectors switch (Connections, Anthropic) and Discover in MCP connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ClaudeSession,projectMcpNames,type ClaudeRun} from '../app/claude';
import {mcpCatalog,registryEntries} from '../app/mcp-catalog';
import {SecretScrubber} from '../app/redaction';

// The worker records what Claude Code would be started with, then exits.
async function launch(extra:Partial<ClaudeRun>){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-connectors-')),worker=path.join(root,'worker.mjs'),out=path.join(root,'launch.json');
  await fs.writeFile(worker,`import fs from 'node:fs';import readline from 'node:readline';const rl=readline.createInterface({input:process.stdin});rl.once('line',line=>{const m=JSON.parse(line),i=m.args.indexOf('--settings');fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({args:m.args,settings:JSON.parse(fs.readFileSync(m.args[i+1],'utf8'))}));process.exit(0);});`);
  const options={executable:'claude',python:process.execPath,worker,directory:root,dataRoot:root,exchangeRoot:root,model:'opus',effort:'high',mode:'manual',hasFolder:true,prompt:'',signal:new AbortController().signal,scrubber:new SecretScrubber(),event:()=>{},approve:async()=>false,mcp:{names:['ghidorah','connection_1'],handle:async()=>({})},...extra} as ClaudeRun;
  await ClaudeSession.open(options).then(session=>(session as any).close?.(),()=>{});
  return {root,...JSON.parse(await fs.readFile(out,'utf8')) as {args:string[];settings:any}};
}

test('claude.ai connectors stay off unless switched on',async()=>{
  const {args,settings}=await launch({});
  assert.ok(args.includes('--strict-mcp-config'));assert.equal(settings.deniedMcpServers,undefined);
});

test('switched on, connectors load but direct connections and project servers are denied',async()=>{
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'tris-project-'));
  await fs.writeFile(path.join(project,'.mcp.json'),JSON.stringify({mcpServers:{sneaky:{command:'node'},ghidorah:{command:'node'}}}));
  const {args,settings}=await launch({claudeConnectors:{hide:['Notion']},trustedProject:true,directory:project});
  assert.equal(args.includes('--strict-mcp-config'),false);
  assert.equal(args[args.indexOf('--setting-sources')+1],'project');
  const denied=settings.deniedMcpServers.map((row:any)=>row.serverName);
  assert.ok(denied.includes('claude.ai Notion'));assert.ok(denied.includes('sneaky'));
  assert.equal(denied.includes('ghidorah'),false,'The app\'s own server must never be denied');
});

test('inspection runs keep strict MCP even when switched on',async()=>{
  const {args}=await launch({claudeConnectors:{hide:[]},inspectUsage:true});
  assert.ok(args.includes('--strict-mcp-config'));
});

test('project MCP names are read from the folder and its parents',async()=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'tris-mcp-names-')),child=path.join(parent,'a','b');await fs.mkdir(child,{recursive:true});
  await fs.writeFile(path.join(parent,'.mcp.json'),JSON.stringify({mcpServers:{top:{}}}));
  await fs.writeFile(path.join(parent,'a','.mcp.json'),'not json');
  assert.ok((await projectMcpNames(child)).includes('top'));
});

test('registry entries keep active https remotes and their required headers',()=>{
  const rows=registryEntries({servers:[
    {server:{name:'com.example/a',title:'A',remotes:[{type:'sse',url:'https://a.example/sse'},{type:'streamable-http',url:'https://a.example/mcp',headers:[{name:'Authorization',isRequired:true},{name:'X-Optional'}]}]},_meta:{'io.modelcontextprotocol.registry/official':{status:'active',isLatest:true}}},
    {server:{name:'com.example/old',remotes:[{type:'streamable-http',url:'https://old.example/mcp'}]},_meta:{'io.modelcontextprotocol.registry/official':{status:'deleted'}}},
    {server:{name:'com.example/local',packages:[{registryType:'npm'}]}},
    {server:{name:'com.example/plain',remotes:[{type:'streamable-http',url:'http://insecure.example/mcp'}]}},
    {server:{name:'com.example/templated',remotes:[{type:'streamable-http',url:'https://{tenant}.example/mcp',variables:{tenant:{}}}]}},
  ]});
  assert.deepEqual(rows,[{id:'com.example/a',name:'A',about:'',url:'https://a.example/mcp',type:'http',headers:['Authorization']}]);
});

test('catalog entries are unique https servers',()=>{
  assert.equal(new Set(mcpCatalog.map(entry=>entry.url)).size,mcpCatalog.length);
  for(const entry of mcpCatalog)assert.match(entry.url,/^https:\/\/[^\s?#]+$/);
});
