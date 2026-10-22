import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.env.TRISMEGISTUS_LIVE_ATTACHMENTS!=='1'||!process.env.TRISMEGISTUS_EXE||process.env.TRISMEGISTUS_TEST_DATA)throw Error('Explicit live packaged attachment check required in the canonical account home.');
const data=await fs.mkdtemp(path.resolve('work/live-attachments-')),instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[],timeout:30000});
const results:any[]=[];let current:string|undefined;
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const until=Date.now()+180000;while(Date.now()<until){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(150);}throw Error('Live attachment check timed out.');};
 const state=await wait(s=>s.backend==='ready'&&s.claude?.models?.length&&s.codex?.models?.length);
 assert.ok(!state.turns.some((t:any)=>['running','waiting','queued','dispatching','stopping'].includes(t.status)),'User work is active.');
 const native=state.claude.models.find((m:any)=>m.id==='claude-code:haiku')||state.claude.models.find((m:any)=>m.id==='claude-code:claude-haiku-4-5');assert.ok(native);
 const imageOnly=process.env.TRISMEGISTUS_LIVE_IMAGE_ONLY==='1';const models=imageOnly?[native.id]:['gpt-6-luna',native.id,'deepseek-flash'];assert.ok(state.codex.models.includes('gpt-6-luna'));
 for(const model of models){
  const markers=Array.from({length:4},()=>String(Math.floor(100000+Math.random()*899999))),folder=path.join(data,String(results.length));await fs.mkdir(folder);
  const python=path.join(path.dirname(process.env.TRISMEGISTUS_EXE),'resources/runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe');
  execFileSync(python,['-c',`from PIL import Image,ImageDraw,ImageFont; from pathlib import Path; import sys; p=Path(sys.argv[1]); font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',60); images=[]\nfor value in sys.argv[2:]:\n a=Image.new('RGB',(700,180),'white'); ImageDraw.Draw(a).text((30,45),value,font=font,fill='black'); images.append(a)\nimages[0].save(p/'picture.png'); images[1].save(p/'pages.pdf',save_all=True,append_images=[images[2]])`,folder,...markers.slice(0,3)],{windowsHide:true});
  await fs.writeFile(path.join(folder,'notes.txt'),markers[3]);current=await call('addProject');await call('addModel',{chatId:current,model});await call('effort',{chatId:current,model,effort:model==='deepseek-flash'?'none':'low'});
  for(const name of ['picture.png','pages.pdf','notes.txt'])await call('attachmentAdd',{chatId:current,name,bytes:new Uint8Array(await fs.readFile(path.join(folder,name)))});
  await call('modelSelection',{chatId:current,model,selected:true});const id=crypto.randomUUID();
  await call('submit',{id,chatId:current,text:imageOnly?'':'Attachment check: read the number in picture.png, the number on each of the two PDF pages, and the number in notes.txt. Reply only with those four numbers in that order. Use no tools.'});
  const finished=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted','needs-model','stopped','waiting'].includes(t.status))),turn=finished.turns.find((t:any)=>t.id===id);
  assert.equal(turn.status,'completed',turn.error||'Unexpected tool request');if(!imageOnly)for(const marker of markers)assert.ok(turn.text.includes(marker),'Missing an attachment marker from '+model);
  results.push({model,chatId:current,turnId:id,status:turn.status,allFourMarkers:!imageOnly,attachmentOnly:imageOnly});await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(results,null,2));console.log('PASS live '+(imageOnly?'attachment-only message: ':'image / two PDF pages / text: ')+model);
 }
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.screenshot({path:path.join(data,'live-attachments.png')});await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());console.log(data);
}finally{
 if(current)await (await instance.firstWindow()).evaluate(chatId=>window.desktop.invoke('stop',{chatId}),current).catch(()=>{});
 await instance.evaluate(({app})=>app.quit());await instance.close();
}
