import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/bypass-skills-')),folder=await fs.mkdtemp(path.join(root,'work/bypass-project-'));
const skill=path.join(data,'hermes/skills/shared-fixture');await fs.mkdir(skill,{recursive:true});
await fs.writeFile(path.join(skill,'SKILL.md'),'---\nname: shared-fixture\ndescription: Shared skill regression fixture\n---\nSHARED_SKILL_CANARY\n');
await fs.writeFile(path.join(skill,'config.yaml'),'fixture: SHARED_REFERENCE_CANARY');
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'requests.jsonl')},windowsHide:true,stdio:'pipe'});
const lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url}});
try{
 await app.evaluate(({app,BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.availableModels?.includes('deepseek-flash')===true);await call('wizardFinish');
 await call('workingFolder',{folder});const chatId=await call('newChat');
 let state=await call('state');const project=state.projects.find((p:any)=>p.id===state.chats.find((c:any)=>c.id===chatId).projectId);
 await call('mode',{projectId:project.id,mode:'bypass'});
 const id=crypto.randomUUID();await call('submit',{id,chatId,text:'BYPASS_SKILLS_FIXTURE',models:['deepseek-flash']});
 state=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','waiting','interrupted','failed'].includes(t.status)));
 assert.equal(state.turns.find((t:any)=>t.id===id).status,'completed',JSON.stringify(state.approvals));
 assert.equal(state.approvals.filter((a:any)=>a.turnId===id).length,0);assert.match(state.turns.find((t:any)=>t.id===id).text,/SHARED_SKILL_CANARY/);
 assert.match(state.turns.find((t:any)=>t.id===id).text,/SHARED_REFERENCE_CANARY/);
 assert.equal(await fs.readFile(path.join(folder,'bypass-result.txt'),'utf8'),'Bypass edit completed.');
 assert.ok(state.tools.some((t:any)=>t.turnId===id&&t.name==='terminal'&&JSON.stringify(t.result).includes('bypass-command')));
 const requests=(await fs.readFile(path.join(data,'requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const names=requests[0].tools.map((tool:any)=>tool.function?.name);for(const name of ['skills_list','skill_view'])assert.ok(names.includes(name),name+' is directly available');
 // A real private credential target keeps its separate, action-bound consent.
 const privateFile=path.join(data,'hermes/auth-fixture.txt');await fs.writeFile(privateFile,'PRIVATE_CANARY');
 const secret=crypto.randomUUID();await call('submit',{id:secret,chatId,text:'PRIVATE_READ_FIXTURE '+JSON.stringify({path:privateFile}),models:['deepseek-flash']});
 state=await pollState(page,s=>s.approvals.some(a=>a.turnId===secret&&a.status==='pending'));
 const approval=state.approvals.find((a:any)=>a.turnId===secret&&a.status==='pending');assert.match(approval.params.description,/private app data/i);
 await call('approve',{id:approval.id,choice:'deny'});await pollState(page,s=>s.turns.some(t=>t.id===secret&&t.status==='completed'));
 assert.doesNotMatch(await fs.readFile(path.join(data,'requests.jsonl'),'utf8'),/PRIVATE_CANARY/);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({sharedSkillVisible:true,eagerSkillTools:true,bypassSkillRead:true,bypassFileEdit:true,bypassCommand:true,noOrdinaryApprovals:true,privateConsentRetained:true,deniedPrivateDataNotSent:true,hidden:true},null,2));
 console.log('PASS shared skill discovery and coding without Bypass prompts; private consent retained. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
