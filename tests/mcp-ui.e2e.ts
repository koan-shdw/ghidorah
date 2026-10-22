import {_electron as electron,type ElectronApplication} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {oauthFixture} from './fixtures/mcp-oauth';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','mcp-ui-'));
const fixture=await oauthFixture();
let instance:ElectronApplication;
async function launch(){
 const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
 return app;
}
try{
 instance=await launch();let page=await instance.firstWindow();page.setDefaultTimeout(25000);
 await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
 const section=()=>page.getByRole('region',{name:'MCP connections',exact:true});
 await section().getByText('No MCP servers added.',{exact:true}).waitFor();
 await section().getByText('Add MCP server',{exact:true}).click();
 await page.getByLabel('MCP setup',{exact:true}).selectOption('paste');
 const config={mcpServers:{'Local fixture':{command:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),args:[path.join(root,'tests/fixtures/mcp_stdio.py')],env:{SERVICE_KEY:'synthetic-ui-mcp-secret'}}}};
 await page.getByLabel('Paste MCP configuration',{exact:true}).fill(JSON.stringify(config));await page.getByRole('button',{name:'Review import',exact:true}).click();
 assert.equal((await page.evaluate(()=>window.desktop.invoke('state'))).mcp.length,0,'preview has no side effects');
 await page.getByRole('button',{name:'Save imported server',exact:true}).click();
 const local=()=>section().locator('details[data-mcp-id]').filter({has:page.locator('summary strong',{hasText:'Local fixture'})});
 await local().locator('summary').click();await local().getByText('Not connected',{exact:true}).waitFor();
 assert.ok(!(await fs.readFile(path.join(data,'hermes','mcp-connections.json'),'utf8')).includes('synthetic-ui-mcp-secret'));
 await local().getByRole('button',{name:'Test connection',exact:true}).click();await local().getByText('Connected',{exact:true}).waitFor();await local().getByText('Local command · 3 tools',{exact:true}).waitFor();
 await local().getByRole('switch').click();await local().getByRole('switch').filter({hasText:'Off'}).waitFor();assert.ok(await local().getByRole('button',{name:'Test connection',exact:true}).isDisabled());
 await local().getByRole('switch').click();await local().getByRole('button',{name:'Test connection',exact:true}).click();await local().getByText('Connected',{exact:true}).waitFor();
 await page.getByLabel('MCP setup',{exact:true}).selectOption('http');await page.getByLabel('MCP connection name',{exact:true}).fill('OAuth fixture');await page.getByLabel('MCP server address',{exact:true}).fill(fixture.origin+'/mcp');
 await page.getByRole('button',{name:'Save server',exact:true}).click();
 // Substitute only the system browser opener. All application IPC, callback,
 // discovery, token exchange, vault and MCP traffic are real.
 await instance.evaluate(({shell})=>{shell.openExternal=async url=>{const {callback}=await(await fetch(url)).json();const result=await fetch(callback);if(result.status!==200)throw Error('Callback refused');};});
 const remote=()=>section().locator('details[data-mcp-id]').filter({has:page.locator('summary strong',{hasText:'OAuth fixture'})});
 await remote().locator('summary').click();await remote().getByRole('button',{name:'Sign in',exact:true}).click();await remote().getByText('Connected',{exact:true}).waitFor();assert.equal(fixture.observed.exchanges,1);
 await page.screenshot({path:path.join(root,'work','mcp-connections.png')});
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Connections',exact:true}).click();await section().getByText('OAuth fixture',{exact:true}).waitFor();
 await instance.evaluate(({app})=>app.quit());await instance.close();
 instance=await launch();page=await instance.firstWindow();page.setDefaultTimeout(25000);await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
 await remote().locator('summary').click();await remote().getByRole('button',{name:'Test connection',exact:true}).click();await remote().getByText('Connected',{exact:true}).waitFor();assert.equal(fixture.observed.exchanges,1);
 await remote().getByRole('button',{name:'Forget sign-in',exact:true}).click();await remote().getByRole('switch').filter({hasText:'Off'}).waitFor();
 await remote().getByRole('switch').click();const before=fixture.observed.headers.length;await remote().getByRole('button',{name:'Test connection',exact:true}).click();
 await page.waitForFunction(()=>window.desktop.invoke('state').then((state:any)=>state.mcp.find((row:any)=>row.name==='OAuth fixture').status!=='Not connected'));
 assert.ok(fixture.observed.headers.slice(before).every(header=>header===undefined),'revoked credential is not sent');
 await remote().getByRole('button',{name:'Remove server',exact:true}).click();await local().locator('summary').click();await local().getByRole('button',{name:'Remove server',exact:true}).click();await section().getByText('No MCP servers added.',{exact:true}).waitFor();
 await assert.rejects(page.evaluate(()=>window.desktop.invoke('mcpCall',{})),/refused/);
 console.log('PASS desktop MCP setup: reviewed import, no execution on save, local test/on/off, real OAuth loopback with simulated browser consent, saved grant after app restart, revocation, removal and no renderer tool-call API');
}finally{if(instance!){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}await fixture.close();}
