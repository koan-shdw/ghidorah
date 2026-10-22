import {_electron as electron,type Page} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {launchPackaged} from './fixtures/launch-packaged';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/read-point-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-read-point-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const app=process.env.TRISMEGISTUS_EXE?null:await electron.launch({args:[root,'--hidden'],env});
const run=app?{page:await mainWindow(app),close:async()=>{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}}:await launchPackaged(env);
const page=run.page,call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
async function order(view:Page,owner:string,joined:string){
 await view.waitForFunction(({owner,joined})=>{
  const row=document.querySelector('article[data-turn-id="'+owner+'"]'),message=row?.querySelector('[data-turn-id="'+joined+'"]');
  if(!row||!message)return false;
  const text=row.textContent||'';return text.includes('After reading.')&&text.indexOf('Before reading.')<text.indexOf('Please keep this correction')&&text.indexOf('Please keep this correction')<text.indexOf('After reading.');
 },{owner,joined});
 assert.equal(await view.locator('article[data-turn-id="'+joined+'"]').count(),0);
 assert.equal(await view.getByText('Read mid-reply, answer above',{exact:true}).count(),0);
}
try{
 await pollState(page,s=>s.backend==='ready'&&!!s.claude?.models?.length&&!!s.availableModels?.includes('deepseek-flash'));
 await call('wizardFinish');await call('workingFolder',{folder});
 const script=path.join(folder,'wait.py');await fs.writeFile(script,'import sys,time\nfrom pathlib import Path\nend=time.monotonic()+120\nwhile not Path(sys.argv[1]).exists():\n if time.monotonic()>end: raise TimeoutError("read point")\n time.sleep(.05)\nprint("done")\n');
 for(const [index,model] of ['deepseek-flash','claude-code:haiku','claude-code:haiku'].entries()){
  const chatId=await call('newChat');await call('addModel',{chatId,model});const state=await call('state');
  await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
  await call('mode',{projectId:state.chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
  const owner=crypto.randomUUID(),joined=crypto.randomUUID(),releases=[0,1].map(n=>path.join(folder,index+'-'+n)),keepText=index===2;
  const spec={commands:releases.map(file=>'"'+PYTHON+'" "'+script+'" "'+file+'"')};
  await call('submit',{id:owner,chatId,models:[model],text:model.startsWith('claude')?JSON.stringify({action:'read-point',releases,keepText}):'READ_POINT_FIXTURE '+JSON.stringify(spec)});
  await pollState(page,s=>s.tools.some(t=>t.turnId===owner&&t.status==='running'));
  await call('submit',{id:joined,chatId,models:[model],text:'Please keep this correction '+index});
  await pollState(page,s=>s.turns.some(t=>t.id===joined&&t.delivery==='sent'));
  await fs.writeFile(releases[0],'go');
  const during=await pollState(page,s=>!!s.turns.find(t=>t.id===joined)?.readAt&&s.turns.find(t=>t.id===owner)?.text.includes('After reading.')===true&&s.tools.filter(t=>t.turnId===owner).length===2);
  assert.equal(during.turns.find(t=>t.id===joined)!.answeredIn,owner);assert.equal(during.turns.find(t=>t.id===joined)!.readAt!.tools,1);
  assert.ok(during.turns.find(t=>t.id===joined)!.readAt!.text>0);await order(page,owner,joined);
  const opening=page.context().waitForEvent('page');await call('openChatWindow',{chatId});const detached=await opening;await detached.waitForLoadState();await order(detached,owner,joined);
  await fs.writeFile(releases[1],'go');const done=await pollState(page,s=>s.turns.some(t=>t.id===owner&&t.status==='completed'));
  const saved=done.turns.find(t=>t.id===joined)!;assert.equal(saved.answeredIn,owner);assert.equal(saved.readAt!.tools,1);
  assert.equal(saved.readAt!.text,keepText?during.turns.find(t=>t.id===joined)!.readAt!.text:0);
  await detached.evaluate(()=>window.desktop.invoke('window',{action:'close'})).catch(()=>{});
  console.log('PASS read point '+model+(keepText?' keeps text':' replaces final text'));
 }
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({hermes:true,claude:true,mainAndDetached:true,textAndTools:true,finalReplacement:true,keptText:true}));
 console.log('PASS messages stay inside the owner reply at their read point, across both engines and main/detached views. '+data);
}finally{await run.close();fake.stdin.end();lines.close();await host.host('delete_key');}
