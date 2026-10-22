import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','claude-create-app-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-native-app-'));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
 const page=await instance.firstWindow(),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(100);}throw Error('Timed out');};
 const exists=(name:string)=>fs.stat(path.join(folder,name)).then(()=>true,()=>false);
 await wait(s=>s.claude?.models?.length);await call('workingFolder',{folder});const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});
 let s=await call('state');const projectId=s.chats.find((c:any)=>c.id===chatId).projectId;
 const submit=async(name:string,extra:Record<string,unknown>={})=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:JSON.stringify({action:'mcp',server:'ghidorah',tool:'create_app',arguments:{name,description:'A shop started through Claude',...extra}}),models:['claude-code:haiku']});return id;};
 const settled=(id:string)=>wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted','stopped'].includes(t.status)));
 // Manual must stop before the filesystem changes, including when the caller is an app-managed MCP tool.
 await call('mode',{projectId,mode:'manual'});let id=await submit('Claude Shop');
 s=await wait(s=>s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending')||s.turns.some((t:any)=>t.id===id&&['completed','failed'].includes(t.status)));
 assert.equal(await exists('Claude-Shop'),false,'Manual create_app changed the filesystem before approval');
 let approval=s.approvals.find((a:any)=>a.turnId===id&&a.status==='pending');assert.ok(approval,'Manual create_app must ask');assert.match(JSON.stringify(approval.params),/create_app|Create app/i);
 await call('approve',{id:approval.id,choice:'deny'});await settled(id);assert.equal(await exists('Claude-Shop'),false);
 id=await submit('Claude Shop');s=await wait(s=>s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending'));approval=s.approvals.find((a:any)=>a.turnId===id&&a.status==='pending');await call('approve',{id:approval.id,choice:'once'});s=await settled(id);
 assert.equal(await exists('Claude-Shop'),true);const saved=s.savedApps.find((a:any)=>a.name==='Claude Shop');assert.ok(saved.chatIds.includes(chatId));assert.ok(saved.repositories.includes(await fs.realpath(path.join(folder,'Claude-Shop'))));assert.equal(saved.current,'A shop started through Claude');
 await call('mode',{projectId,mode:'plan'});id=await submit('Plan Shop');s=await settled(id);assert.equal(await exists('Plan-Shop'),false);assert.equal(s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending'),false);
 for(const mode of ['accept-edits','auto','bypass']){await call('mode',{projectId,mode});const name=mode+' Shop';id=await submit(name);s=await settled(id);assert.equal(await exists(name.replace(' ','-')),true);assert.equal(s.approvals.some((a:any)=>a.turnId===id),false);}
 await fs.mkdir(path.join(folder,'vi-dancer'));await fs.mkdir(path.join(folder,'video-dancer'));await fs.copyFile(path.join(root,'assets/icon.png'),path.join(folder,'vi-dancer','icon.png'));
 id=await submit('Video Dancer',{repositories:['vi-dancer',path.join(folder,'video-dancer')],icon_path:'vi-dancer/icon.png',stage:'Beta · 0.23.1'});s=await settled(id);
 const video=s.savedApps.find((a:any)=>a.name==='Video Dancer');assert.ok(video,'Existing app must be registered');assert.equal((await fs.readdir(folder)).includes('Video-Dancer'),false,'Registering an existing app must not create another folder');assert.equal(video.stage,'Beta · 0.23.1');assert.match(video.icon,/^data:image\/png;base64,/);assert.equal(video.repositories.length,2);assert.deepEqual(video.chatIds,[chatId]);
 id=await submit('Video Dancer');s=await settled(id);assert.equal(s.savedApps.filter((a:any)=>a.name==='Video Dancer').length,1);assert.equal((await fs.readdir(folder)).includes('Video-Dancer'),false);assert.equal(s.savedApps.find((a:any)=>a.id===video.id).icon,video.icon);
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'tris-outside-app-'));await fs.symlink(outside,path.join(folder,'outside-link'),'junction');
 for(const [name,extra] of [['Outside',{repositories:[outside]}],['Linked outside',{repositories:['outside-link']}],['Missing folder',{repositories:['not-there']}],['Bad icon',{repositories:['vi-dancer'],icon_path:'vi-dancer/missing.png'}]] as const){id=await submit(name,extra);s=await settled(id);assert.equal(s.savedApps.some((a:any)=>a.name===name),false);assert.equal(await exists(name.replaceAll(' ','-')),false);}
 await fs.writeFile(path.join(data,'saved-app-result.json'),JSON.stringify({name:video.name,repositories:video.repositories,stage:video.stage,linked:video.chatIds,hasIcon:!!video.icon},null,2));
 console.log('PASS native Claude create_app: permissions, creation, existing repositories/icon/version, chat linking, repeat calls, invalid paths and outside junction refusal. Profile: '+data);
}finally{await instance.close().catch(()=>{});const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');}
