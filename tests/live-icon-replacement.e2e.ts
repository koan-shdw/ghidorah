// Opt-in real-account task: changes only the explicitly authorized program icons.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
if(process.env.TRISMEGISTUS_LIVE_ICON!=='1')throw Error('Explicit live icon task opt-in required.');
const root=path.resolve('.'),source='C:\\Users\\1\\OneDrive\\Desktop\\optimize-image.png',data=await fs.mkdtemp(path.join(root,'work','live-icon-')),namespace='Trismegistus/Test/'+path.basename(data);
const expected=createHash('sha256').update(await fs.readFile(source)).digest('hex'),host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));env.TRISMEGISTUS_TEST_DATA=data;delete env.TRISMEGISTUS_TEST_CLAUDE;delete env.TRISMEGISTUS_TEST_CLAUDE_NODE;delete env.TRISMEGISTUS_TEST_PROVIDER_URL;
const app=await electron.launch({args:[root,'--hidden'],env,timeout:30000});let chatId:string|undefined;
console.log('Live task evidence: '+data);
try{
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('workingFolder',{folder:root});await call('claudeCheck');
 let state=await call('state');assert.ok(state.claude?.connected,'Claude account is unavailable');
 const models=state.claude.models||[],model=models.find((m:any)=>/opus/i.test(m.id))?.id||models[0]?.id;assert.ok(model,'Claude model discovery did not return a model');
 console.log('Using '+model);chatId=await call('newChat');await call('addModel',{chatId,model});state=await call('state');await call('mode',{projectId:state.chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
 const id=crypto.randomUUID(),prompt=`Replace Trismegistus's actual program icon with the exact uploaded PNG at ${source}. Copy it unchanged to ${root}\\assets\\icon.png and generate ${root}\\assets\\icon.ico with sizes 16, 24, 32, 48, 64, 128 and 256. This changes the executable, window and tray icon. Use the existing Pillow installation at ${PYTHON}. Only change those two assets; preserve all unrelated work. Verify the PNG SHA-256 matches the source and list the ICO sizes. Then run npm run typecheck and npm run build in ${root}, and report their actual results. Keep the current app running; do not commit, publish or restart it.`;
 await call('submit',{id,chatId,models:[model],text:prompt});let stamp='',done=false;
 for(const deadline=Date.now()+12*60*1000;Date.now()<deadline;await page.waitForTimeout(500)){
  state=await call('state');const turn=state.turns.find((t:any)=>t.id===id),tools=state.tools.filter((t:any)=>t.turnId===id),pending=state.approvals.filter((a:any)=>a.turnId===id&&a.status==='pending');
  await fs.writeFile(path.join(data,'progress.json'),JSON.stringify({chatId,turnId:id,model,status:turn.status,text:turn.text,error:turn.error,tools,pending},null,2));
  const next=JSON.stringify([turn.status,tools.map((t:any)=>[t.name,t.status]),pending.map((p:any)=>p.id)]);if(next!==stamp){stamp=next;console.log(JSON.stringify({status:turn.status,tools:tools.map((t:any)=>({name:t.name,status:t.status})),pending:pending.map((p:any)=>p.id)}));}
  let choices:Record<string,string>={};try{choices=JSON.parse(await fs.readFile(path.join(data,'decisions.json'),'utf8'));}catch{}
  for(const approval of pending)if(['once','deny'].includes(choices[approval.id]))await call('approve',{id:approval.id,choice:choices[approval.id]});
  if(['completed','failed','interrupted','stopped'].includes(turn.status)){assert.equal(turn.status,'completed',turn.error||turn.text);done=true;break;}
 }
 assert.ok(done,'Real icon task timed out');assert.equal(createHash('sha256').update(await fs.readFile(path.join(root,'assets/icon.png'))).digest('hex'),expected,'PNG must preserve the exact upload');
 const ico=await fs.readFile(path.join(root,'assets/icon.ico'));assert.equal(ico.readUInt16LE(2),1);const sizes=Array.from({length:ico.readUInt16LE(4)},(_,i)=>ico[6+i*16]||256);for(const size of [16,24,32,48,64,128,256])assert.ok(sizes.includes(size),'Missing ICO size '+size);
 const turn=state.turns.find((t:any)=>t.id===id),tools=state.tools.filter((t:any)=>t.turnId===id);assert.ok(tools.some((t:any)=>t.name==='Bash'&&/npm run (build|typecheck)/.test(JSON.stringify(t.args))));
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({chatId,turnId:id,model,pngSHA256:expected,icoSizes:sizes,answer:turn.text,tools},null,2));console.log('PASS live Trismegistus icon replacement: '+data);
}finally{
 if(chatId)await app.windows().find(p=>/index\.html$/.test(p.url()))?.evaluate(chatId=>window.desktop.invoke('stop',{chatId}),chatId).catch(()=>{});
 await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});
}
