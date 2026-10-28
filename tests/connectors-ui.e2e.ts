// Connectors in Settings: MCP connections Yours | Discover (catalog, Google Workspace setup, token servers, the public
// MCP Registry) and the claude.ai connectors switch in Connections > Anthropic. Real Electron, isolated data; a local
// stand-in answers for the registry. Saves a screenshot of each state for review.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import http from 'node:http';
import {Backend} from '../app/backend';import {mainWindow,pollState} from './fixtures/poll-state';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','connectors-ui-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-connectors-'));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const searches:string[]=[];
const registry=http.createServer((request,response)=>{const url=new URL(request.url||'/','http://localhost');searches.push(url.pathname+'?'+url.searchParams.get('search'));response.setHeader('content-type','application/json');
  response.end(JSON.stringify({servers:[{server:{name:'com.example/notes',title:'Example Notes',description:'Notes from a registry stand-in.',remotes:[{type:'streamable-http',url:'https://notes.example/mcp'}]},_meta:{'io.modelcontextprotocol.registry/official':{status:'active',isLatest:true}}},
    {server:{name:'com.example/keyed',title:'Keyed Service',description:'Needs an API key header.',remotes:[{type:'streamable-http',url:'https://keyed.example/mcp',headers:[{name:'X-Api-Key',isRequired:true,isSecret:true}]}]}}]}));});
await new Promise<void>(resolve=>registry.listen(0,'127.0.0.1',resolve));const registryUrl='http://127.0.0.1:'+(registry.address() as any).port;
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_REGISTRY_URL:registryUrl,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
const shots:string[]=[];
const screenshot=async(name:string)=>{const png=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,150));return (await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});const file=path.join(data,name+'.png');await fs.writeFile(file,Buffer.from(png,'base64'));shots.push(file);};
try{
 const page=await mainWindow(app);await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&!!s.claude?.connected);await call('wizardFinish');await call('workingFolder',{folder});await call('addProject');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('#'))!.setSize(1280,940));
 if(await page.getByLabel('Close settings',{exact:true}).isVisible())await page.getByLabel('Close settings',{exact:true}).click();
 await page.locator('.rail-settings').click();const dialog=page.getByRole('dialog',{name:'Settings',exact:true}),body=dialog.locator('.settings-body');
 await dialog.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Connections',exact:true}).click();await page.locator('[data-settings-page="connections"]').waitFor();
 const top=(locator:any)=>locator.evaluate((el:Element)=>el.scrollIntoView({block:'start'})),section=page.locator('section.mcp-settings');
 const panel=(name:string)=>body.locator('details.supplier-pill').filter({has:page.locator('summary strong',{hasText:new RegExp('^'+name+'$')})}).first();

 // Connections > Anthropic: the switch, off by default.
 const anthropic=panel('Anthropic');if(!await anthropic.evaluate(el=>(el as HTMLDetailsElement).open))await anthropic.locator(':scope > summary').click();
 const toggle=page.getByRole('switch',{name:'Use my claude.ai connectors'});await toggle.scrollIntoViewIfNeeded();assert.equal(await toggle.getAttribute('aria-checked'),'false');
 await toggle.click();await pollState(page,s=>s.claudeConnectors===true);await top(anthropic);await screenshot('1-anthropic-switch-on');
 await anthropic.locator(':scope > summary').click();

 // Settings > MCP: Yours first, then Discover.
 await dialog.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'MCP',exact:true}).click();await page.locator('[data-settings-page="mcp"]').waitFor();
 const tabs=page.getByRole('navigation',{name:'MCP connections view'});await tabs.scrollIntoViewIfNeeded();
 await page.getByText('No MCP servers added. Find one in Discover.').waitFor();await top(section);await screenshot('2-mcp-yours-empty');
 await tabs.getByRole('button',{name:'Discover',exact:true}).click();await page.getByLabel('Search connectors',{exact:true}).scrollIntoViewIfNeeded();
 for(const name of ['Google Workspace','Notion','Webflow','Klaviyo','GitHub'])await page.locator('.mcp-offer strong',{hasText:new RegExp('^'+name+'$')}).waitFor();
 await top(section);await screenshot('3-mcp-discover');

 // Google Workspace: one click with Ghidorah's own Google sign-in app.
 const google=page.locator('[data-offer="google-workspace"]');await top(google);await screenshot('4-google-setup');
 await google.getByRole('button',{name:'Add',exact:true}).click();let state=await pollState(page,s=>!!s.mcp?.some((row:any)=>row.name==='Google Workspace'));
 const saved=state.mcp!.find((row:any)=>row.name==='Google Workspace')!;assert.equal(saved.transport,'stdio');assert.equal(saved.address,'uvx');await google.getByText('Added',{exact:true}).waitFor();

 // A token server asks for the token, then saves it as a header.
 const github=page.locator('[data-offer="https://api.githubcopilot.com/mcp/"]');await github.getByRole('button',{name:'Add',exact:true}).click();
 await page.getByLabel('GitHub Authorization',{exact:true}).fill('synthetic-github-token');await top(github);await screenshot('5-token-server');
 await github.getByRole('button',{name:'Save',exact:true}).click();state=await pollState(page,s=>!!s.mcp?.some((row:any)=>row.name==='GitHub'));
 assert.equal(state.mcp!.find((row:any)=>row.name==='GitHub')!.auth,'configured');

 // Search filters the catalog; the registry answers the rest.
 await page.getByLabel('Search connectors',{exact:true}).fill('notes');await page.getByText('Not in the list.').waitFor();
 await page.getByRole('button',{name:'Search the MCP Registry',exact:true}).click();await page.locator('.mcp-offer strong',{hasText:'Example Notes'}).waitFor();
 assert.deepEqual(searches,['/v0.1/servers?notes']);await top(page.getByLabel('Search connectors',{exact:true}));await screenshot('6-registry-results');

 // Yours lists what was added.
 await tabs.getByRole('button',{name:'Yours',exact:true}).click();for(const name of ['Google Workspace','GitHub'])await panel(name).waitFor();await top(section);await screenshot('7-mcp-yours-added');
 // A short setting such as DEBUG=1 is not hidden as a secret: hiding every "1" corrupted request IDs.
 await call('mcpAdd',{name:'Short setting',config:{command:'node',args:[],env:{DEBUG:'1'}}});state=await call('state');assert.ok(state.mcp!.some((row:any)=>row.name==='Short setting'));
 // Removing deletes their saved credentials from Windows Credential Manager.
 for(let rows=(await call('state')).mcp;rows.length;rows=(await call('state')).mcp)await call('mcpAction',{id:rows[0].id,action:'remove'});
 assert.equal((await call('state')).mcp.length,0);assert.deepEqual(errors,[]);
 console.log('PASS connectors settings: claude.ai switch, Yours/Discover, Google setup, token server, registry search. '+data);
}catch(error){await screenshot('failure').catch(()=>{});const page=await mainWindow(app).catch(()=>null);if(page)console.log('Alerts:',await page.locator('[role=alert]').allTextContents().catch(()=>[]),'MCP error:',(await page.evaluate(()=>window.desktop.invoke('state')).catch(()=>({})) as any).mcpError);console.log('Connectors evidence: '+data);throw error;}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});registry.close();}
