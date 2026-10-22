import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','attachments-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const imageFile=path.join(data,'sample.png'),pdfFile=path.join(data,'two-pages.pdf');
execFileSync(PYTHON,['-c',`from PIL import Image,ImageDraw; import sys; a=Image.new('RGB',(240,160),'white'); ImageDraw.Draw(a).text((15,20),'COPPERFINCH 731',fill='black'); b=Image.new('RGB',(240,160),'blue'); a.save(sys.argv[1]); a.save(sys.argv[2],save_all=True,append_images=[b])`,imageFile,pdfFile],{windowsHide:true});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'hermes-requests.jsonl')},windowsHide:true,stdio:'pipe'});
const lines=createInterface({input:fake.stdout});const [line]=await once(lines,'line');
const codex=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'codex-requests.jsonl')],{env:{...host.environment(),FIXTURE_TEXT_MODEL:'1'},windowsHide:true,stdio:'pipe'});
const codexLines=createInterface({input:codex.stdout});const [codexLine]=await once(codexLines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(codexLine).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
let instance=await launch(),page=await instance.firstWindow();
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+30000;while(Date.now()<end){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(150);}throw Error('Timeout: '+JSON.stringify((await call('state')).turns)+' UI: '+await page.locator('.error').allTextContents());};
const ready=()=>wait(s=>s.backend==='ready'&&s.claude?.models?.length&&s.codex?.models?.length);
const records=async(name:string)=>(await fs.readFile(path.join(data,name+'-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const images=(value:any):string[]=>{if(!value||typeof value!=='object')return [];if(value.type==='image_url')return [value.image_url.url];if(value.type==='input_image')return [value.image_url];if(value.type==='image')return ['data:'+value.source.media_type+';base64,'+value.source.data];return Object.values(value).flatMap(images);};
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await ready();
 const chatId=await call('addProject');await call('addModel',{chatId,model:'gpt-6-astra'});await call('addModel',{chatId,model:'claude-code:haiku'});
 const send=async(text:string,model:string,owner=chatId)=>{await call('modelSelection',{chatId:owner,model,selected:true});const id=crypto.randomUUID();await call('submit',{id,chatId:owner,text});return id;};
 const done=async(id:string)=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted','needs-model'].includes(t.status)));assert.equal(s.turns.find((t:any)=>t.id===id).status,'completed',s.turns.find((t:any)=>t.id===id).error);return s;};
 await page.emulateMedia({reducedMotion:'reduce'}); // floating thumbnails never settle for a click
 await page.waitForFunction(()=>!(document.querySelector('[aria-label="Attach files"]') as HTMLButtonElement)?.disabled);
 await page.getByLabel('Choose attachments').setInputFiles(imageFile);
 await wait(s=>s.chats.find((c:any)=>c.id===chatId)?.attachments?.length===1);
 await page.getByLabel('Draft attachments').getByTitle('sample.png').waitFor({state:'attached',timeout:10000});
 await page.getByRole('button',{name:'Remove sample.png'}).click();await wait(s=>!s.chats.find((c:any)=>c.id===chatId)?.attachments?.length);
 await page.getByLabel('Choose attachments').setInputFiles([imageFile,pdfFile]);
 await wait(s=>s.chats.find((c:any)=>c.id===chatId)?.attachments?.length===2);
 // Drop and paste exercise the renderer byte path independently of the picker.
 await page.locator('main').evaluate(element=>{const transfer=new DataTransfer();transfer.items.add(new File(['FILE_ONLY_COPPERFINCH'],'notes.txt',{type:'text/plain'}));element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
 await wait(s=>s.chats.find((c:any)=>c.id===chatId)?.attachments?.length===3);
 await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();page=await instance.firstWindow();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await ready();
 assert.equal((await call('state')).chats.find((c:any)=>c.id===chatId).attachments.length,3);
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.screenshot({path:path.join(data,'attachments-draft.png')});await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
 const a=await send('Read the attached data.','deepseek-flash');let state=await done(a);
 assert.equal(state.turns.find((t:any)=>t.id===a).attachments.length,3);assert.equal(state.chats.find((c:any)=>c.id===chatId).attachments.length,0);
 const deepseek=(await records('hermes')).at(-1),original=(await fs.readFile(imageFile)).toString('base64');
 assert.equal(images(deepseek).length,3);assert.ok(images(deepseek).some(image=>image.endsWith(original)));assert.match(JSON.stringify(deepseek),/FILE_ONLY_COPPERFINCH/);assert.match(JSON.stringify(deepseek),/PDF page 2 of 2/);
 const b=await send('Describe the same attachments.','claude-code:haiku');await done(b);
 const native=(await records('claude')).at(-1);assert.equal(images(native.content).length,3);assert.match(JSON.stringify(native.content),/FILE_ONLY_COPPERFINCH/);
 const c=await send('Continue from your previous answer.','claude-code:haiku');await done(c);assert.equal(images((await records('claude')).at(-1).content).length,0);
 const d=await send('Check the attached pages again.','gpt-6-astra');await done(d);assert.equal(images((await records('codex')).at(-1)).length,3);
 const other=await call('addProject');await call('addModel',{chatId:other,model:'claude-code:haiku'});
 const e=await send('Other chat.','claude-code:haiku',other);await done(e);const isolated=(await records('claude')).at(-1);assert.equal(images(isolated.content).length,0);assert.doesNotMatch(JSON.stringify(isolated),/FILE_ONLY_COPPERFINCH/);
 // An unknown/text-only model must ask; attaching alone does not authorise a replacement.
 await call('addModel',{chatId:other,model:'gpt-fixture-text'});
 await page.getByRole('combobox',{name:'Message',exact:true}).evaluate(element=>{const transfer=new DataTransfer();transfer.items.add(new File(['PASTED_TEXT_MARKER'],'pasted.txt',{type:'text/plain'}));element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));});
 await wait(s=>s.chats.find((c:any)=>c.id===chatId)?.attachments?.some((a:any)=>a.name==='pasted.txt'));
 await call('attachmentAdd',{chatId:other,name:'image.png',bytes:new Uint8Array(await fs.readFile(imageFile))});
 const refused=await send('', 'gpt-fixture-text',other);assert.equal(await call('submit',{id:refused,chatId:other,text:''}),refused);state=await wait(s=>s.turns.find((t:any)=>t.id===refused)?.status==='needs-model');assert.match(state.turns.find((t:any)=>t.id===refused).error,/image input/);
 await call('chooseTurnModel',{id:refused,model:'claude-code:haiku'});await done(refused);assert.equal(images((await records('claude')).at(-1).content).length,1);
 // Any file gets in (Koan, TRIS-TODO 1.2); this one is removed again before the next send.
 const binary=await call('attachmentAdd',{chatId:other,name:'binary.dat',bytes:new Uint8Array([0,255,0,99])});assert.equal(binary.kind,'file');await call('attachmentRemove',{chatId:other,id:binary.id});
 await assert.rejects(call('attachmentAdd',{chatId:other,name:'../foreign.txt',bytes:new Uint8Array([65])}),/Invalid attachment name/);
 const fresh=await call('addProject');await call('addModel',{chatId:fresh,model:'claude-code:haiku'});await call('attachmentAdd',{chatId:fresh,name:'fresh.png',bytes:new Uint8Array(await fs.readFile(imageFile))});await done(await send('','claude-code:haiku',fresh));const empty=(await records('claude')).at(-1).content;assert.equal(images(empty).length,1);assert.ok(empty.filter((part:any)=>part.type==='text').every((part:any)=>part.text.length>0));
 const before=(await records('claude')).length;
 // Tampering is detected even after acceptance and before any model call.
 const victim=state.turns.find((t:any)=>t.id===a).attachments[0];await fs.writeFile(path.join(data,'attachments',victim.id,'source'),'changed');
 await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();page=await instance.firstWindow();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await ready();
 // A fresh engine transfer after uncertainty must revalidate every attachment. A crash mid-reply leaves the context
 // uncertain; a Stop keeps the live session, as in Claude Code (TURN-REVIEW part 5), so nothing is sent again there.
 const slow=await send('SLOW_CLAUDE','claude-code:haiku');await wait(s=>s.turns.find((t:any)=>t.id===slow)?.text.length>12);
 execFileSync('taskkill',['/PID',String(instance.process().pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await instance.close().catch(()=>{});instance=await launch();page=await instance.firstWindow();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await ready();
 assert.equal((await call('state')).turns.find((t:any)=>t.id===slow).status,'interrupted');
 const count=(await records('claude')).length;const broken=await send('Inspect after Stop.','claude-code:haiku');state=await wait(s=>s.turns.find((t:any)=>t.id===broken)?.status==='interrupted');assert.match(state.turns.find((t:any)=>t.id===broken).error,/changed on disk/);assert.equal((await records('claude')).length,count);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({passed:true,checks:['picker/remove/drop/paste','image-only send and incapable model refusal/replacement','draft restart','image and two PDF pages and file through real Hermes DeepSeek/Codex and native Claude fixture','native resume does not resend old attachments','chat isolation','binary/path refusal','Stop and tamper refusal'],before,count},null,2));
 console.log('PASS attachments '+data);
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});fake.stdin.end('\n');codex.stdin.end('\n');lines.close();codexLines.close();await host.host('delete_key');}
