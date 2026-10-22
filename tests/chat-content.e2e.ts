import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import type {Turn,Chat} from '../app/types';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/chat-content-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-chat-content-'));
await fs.writeFile(path.join(folder,'demo.ts'),'first line\nsecond line\nthird line\n');await fs.writeFile(path.join(folder,'other.ts'),'another file\n');await fs.writeFile(path.join(folder,'.env'),'synthetic protected configuration');
const store=new Store(path.join(data,'chat.sqlite')),project=store.project(folder),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'Show the implementation and task list.');
const text=`## Implementation ready

The **editor** preserves your draft. Visit [documentation](https://example.org/docs) or open [demo.ts line 2](<${path.join(folder,'demo.ts')}:2:2>).

1. Read the source.
2. Apply the change.

- [x] Save the result
- [ ] Review the next step

| Check | Result |
| --- | --- |
| Editor | Passed |

\`\`\`typescript
const answer = 42;
\`\`\`

> Keep the working files.

[Other file](other.ts) · [Protected file](.env) · [Unsafe protocol](javascript:alert(1))

<script>window.injectionRan=true</script><iframe src="https://example.org"></iframe><img src="https://example.org/tracker" onerror="window.injectionRan=true"><input value="injected"><form action="https://example.org">Hidden form</form>`;
store.update<Turn>('turn',turn.id,{text,status:'completed'});store.put('tool',{id:'read-demo',turnId:turn.id,name:'read_file',args:{path:'demo.ts'},result:'first line\nsecond line\nthird line',status:'completed'});store.put('tool',{id:'command-demo',turnId:turn.id,name:'terminal',args:{command:'node --version'},result:'v22.0.0',status:'completed'});
const group=store.accept(crypto.randomUUID(),chat.id,'Parallel example'),side=store.chat(project.id);store.update<Chat>('chat',side.id,{parentChatId:chat.id,groupTurnId:group.id});const job=store.accept(crypto.randomUUID(),side.id,'Side job');store.update<Turn>('turn',job.id,{parentTurnId:group.id,text:'[Side file](demo.ts:3)',status:'completed'});store.update<Turn>('turn',group.id,{jobs:[job.id],status:'completed'});store.db.close();
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
await instance.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
const capture=async(name:string)=>{const png=await instance.evaluate(async({BrowserWindow})=>{const view=BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!;await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,150));return (await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});await fs.writeFile(path.join(data,name+'.png'),Buffer.from(png,'base64'));};
try{
 const page=await instance.firstWindow();page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await instance.evaluate(({BrowserWindow,shell})=>{BrowserWindow.getAllWindows()[0].setSize(1450,950);(globalThis as any).openedLinks=[];shell.openExternal=async url=>{(globalThis as any).openedLinks.push(url);};});
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const end=Date.now()+90000;while((await call('state')).backend!=='ready'){if(Date.now()>end)throw Error('Backend timeout');await page.waitForTimeout(100);}
 await page.getByLabel('Close settings',{exact:true}).click();await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click();
 await page.getByRole('heading',{name:'Implementation ready'}).waitFor();assert.equal(await page.locator('.markdown table tbody tr').count(),1);assert.equal(await page.locator('.markdown input:checked:disabled').count(),1);assert.equal(await page.locator('.markdown input:not([type=checkbox]),.markdown script,.markdown img:not(.link-site-icon),.markdown iframe,.markdown form').count(),0);assert.equal(await page.evaluate(()=>(window as any).injectionRan),undefined);
 assert.equal(await page.locator('.activity[open]').count(),0);await page.locator('.activity-group > summary').first().click();await page.locator('[data-tool-id="read-demo"] summary').click();await page.locator('[data-tool-id="read-demo"] pre').filter({hasText:'first line'}).waitFor();await page.locator('[data-tool-id="read-demo"] summary').click();
 await page.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedCode=text;}}});");
 await page.getByRole('button',{name:'Copy code',exact:true}).click();await page.getByRole('button',{name:'Copy code',exact:true}).filter({hasText:'Copied'}).waitFor();assert.equal(await page.evaluate(()=>(window as any).copiedCode),'const answer = 42;\n');
 const stableLink=await page.getByRole('link',{name:'documentation',exact:true}).elementHandle();await call('draft',{chatId:chat.id,text:'Status update stability check'});await page.waitForTimeout(300);assert.equal(await stableLink!.evaluate(link=>link.isConnected),true,'Unchanged Markdown must retain its DOM across status updates');assert.equal(await page.getByRole('button',{name:'Copy code',exact:true}).textContent(),'Copied');await call('draft',{chatId:chat.id,text:''});
 await page.getByRole('link',{name:'documentation',exact:true}).click();assert.deepEqual(await instance.evaluate(()=>(globalThis as any).openedLinks),['https://example.org/docs']);assert.match(page.url(),/index\.html$/);
 await page.getByRole('link',{name:'demo.ts line 2',exact:true}).click();await page.locator('.cm-activeLine').filter({hasText:'second line'}).waitFor();
 const editor=page.getByRole('textbox',{name:'File contents'});await editor.fill('unsaved one\nunsaved two\nunsaved three\n');await page.getByRole('link',{name:'demo.ts line 2',exact:true}).click();await page.locator('.cm-activeLine').filter({hasText:'unsaved two'}).waitFor();assert.match(await editor.textContent()||'',/unsaved three/);
 await page.getByRole('link',{name:'Other file',exact:true}).click();await page.getByRole('alert').filter({hasText:'Save or discard'}).waitFor();assert.match(await editor.textContent()||'',/unsaved three/);assert.match(await fs.readFile(path.join(folder,'demo.ts'),'utf8'),/^first line/);
 await page.getByRole('button',{name:'Discard',exact:true}).click();await page.getByRole('button',{name:'Discard draft',exact:true}).click();
 await page.getByRole('link',{name:'Protected file',exact:true}).click();await page.getByRole('alert').filter({hasText:'Protected account'}).waitFor();await page.getByRole('link',{name:'Unsafe protocol',exact:true}).click();await page.getByRole('alert').filter({hasText:'Only web'}).waitFor();assert.equal(await page.evaluate(()=>(window as any).injectionRan),undefined);
 const opened=instance.waitForEvent('window');await call('openJob',{id:job.id});const jobPage=await opened;await jobPage.getByRole('link',{name:'Side file',exact:true}).click();await page.locator('.cm-activeLine').filter({hasText:'third line'}).waitFor();await assert.rejects(jobPage.evaluate(id=>window.desktop.invoke('chatLink',{turnId:id,href:'https://example.org'}),turn.id),/another job/);
 await page.getByLabel('Hide workspace').click();await page.locator('.transcript').evaluate(element=>element.scrollTop=0);await capture('chat-content');assert.deepEqual(errors,[]);assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({markdown:true,sanitization:true,copyCode:true,activityDetails:true,webDispatch:true,fileLine:true,unsavedDraft:true,protectedLinks:true,sideJobLinks:true,sideOwnership:true},null,2));console.log('PASS formatted chat, safe link routing, code copy, tool details, unsaved drafts and side-window ownership');console.log(data);
}catch(error){const pages=instance.windows();await capture('failure').catch(()=>{});await fs.writeFile(path.join(data,'failure.html'),await pages[0]?.content()||'');console.log(data);throw error;}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});execFileSync(path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/encryption'],{cwd:root,windowsHide:true});}

