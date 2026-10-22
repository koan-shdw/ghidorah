import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

// Plan quick wins in the desktop: tooltip prices (2b), pill health dots (2c), videos to Gemini (2d), app Git lights (5a).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','quick-wins-')),folder=path.join(data,'workspace'),healthFile=path.join(data,'health.json');await fs.mkdir(folder);
await fs.writeFile(healthFile,JSON.stringify({deepseek:'ready'}));
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl'),FIXTURE_HEALTH_FILE:healthFile},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
const api=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),[aline]=await once(createInterface({input:api.stdout}),'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_API_URLS:JSON.stringify({gemini:JSON.parse(aline).gemini})};
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
try{
 const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(150);}throw Error('Timed out: '+JSON.stringify(await call('state')));};
 await wait(s=>s.backend==='ready'&&s.availableModels.includes('deepseek-flash'));await call('workingFolder',{folder});
 await call('apiSave',{provider:'gemini',key:'synthetic-gemini-test-credential'});
 const gemini='api:gemini:gemini-3.8-flash';await wait(s=>s.availableModels.includes(gemini));
 const chat=await call('addProject');await call('addModel',{chatId:chat,model:gemini});
 await wait(s=>s.modelPrices?.[gemini]&&s.modelPrices['deepseek-flash']);
 if(await page.getByRole('button',{name:'Close settings',exact:true}).count())await page.getByRole('button',{name:'Close settings',exact:true}).click();
 await page.locator('[data-chat-id="'+chat+'"] .chat-link').click();

 await page.locator('.model-tab').filter({hasText:'DeepSeek'}).hover();
 let tip=await page.getByRole('tooltip').innerText();
 assert.match(tip,/\$0\.15 in · \$0\.60 out per million tokens/);assert.match(tip,/5\.7× cheaper than gemini-3\.8-flash/);
 await page.screenshot({path:path.join(data,'price-deepseek.png')});
 await page.locator('.model-tab').filter({hasText:'gemini-3.8-flash'}).hover();
 tip=await page.getByRole('tooltip').innerText();
 assert.match(tip,/\$0\.75 in · \$3\.75 out per million tokens/);assert.match(tip,/5\.7× pricier than DeepSeek/);
 console.log('PASS 2b tooltip list prices and in-chat comparison');

 const dot=(label:string)=>page.locator('.model-pill').filter({hasText:label}).locator('.health-dot');
 const health=async(label:string,value:string)=>{await page.waitForFunction(([label,value])=>[...document.querySelectorAll('.model-pill')].some(pill=>pill.textContent?.includes(label)&&pill.querySelector('.health-dot')?.classList.contains(value)),[label,value]);};
 await health('DeepSeek','ok');await health('gemini-3.8-flash','ok');
 for(const [state,value,status] of [['exhausted','limited','Credit exhausted'],['auth','down','Authentication failed'],['ready','ok','Connected']]){
  await fs.writeFile(healthFile,JSON.stringify({deepseek:state}));await call('checkAccount');await wait(s=>s.providerStatus===status);await health('DeepSeek',value);
  if(value==='limited')await page.screenshot({path:path.join(data,'health-limited.png')});
 }
 assert.equal(await dot('gemini-3.8-flash').getAttribute('class'),'health-dot ok');
 await page.getByRole('button',{name:'Add model',exact:true}).click();
 assert.match(await page.locator('[data-model="deepseek-flash"] .health-dot').first().getAttribute('class')||'',/ok/);
 assert.match(await page.locator('[data-model="deepseek-flash"]').first().getAttribute('title')||'',/Connected/);
 await page.getByLabel('Close settings').click();
 console.log('PASS 2c pill dots follow the account checks: fine, out of credit, signed out, recovered');

 const drop=async(name:string)=>{const transfer=await page.evaluateHandle(name=>{const files=new DataTransfer();files.items.add(new File([new Uint8Array(4096).fill(7)],name,{type:'video/mp4'}));return files;},name);await page.locator('main').first().dispatchEvent('drop',{dataTransfer:transfer});};
 const open=async(chatId:string)=>{await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();await page.locator('[data-chat-id="'+chatId+'"] .chat-link[aria-current="page"]').waitFor();};
 const videoChat=await call('addProject');await open(videoChat);await drop('clip.mp4');
 let s=await wait(s=>s.chats.find((c:any)=>c.id===videoChat)?.attachments?.some((a:any)=>a.kind==='video'));
 assert.ok(s.chats.find((c:any)=>c.id===videoChat).pool.includes(gemini),'the dropped video adds Gemini to the chat');
 await page.screenshot({path:path.join(data,'video-attached.png')});
 await call('modelSelection',{chatId:videoChat,model:'deepseek-flash',selected:true});
 const videoTurn=crypto.randomUUID();await call('submit',{id:videoTurn,chatId:videoChat,text:'Describe this clip.'});
 s=await wait(s=>s.turns.some((t:any)=>t.id===videoTurn&&['completed','failed','needs-model'].includes(t.status)));
 const turn=s.turns.find((t:any)=>t.id===videoTurn);assert.equal(turn.status,'completed',turn.error);assert.equal(turn.model,gemini);assert.equal(turn.routeNotice,'Videos go to Gemini.');
 const sent=(await fs.readFile(path.join(data,'requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).findLast((row:any)=>row.provider==='gemini');
 assert.match(JSON.stringify(sent.body),/"inlineData":\{"mimeType":"video\/mp4","data":"BwcH/);
 console.log('PASS 2d dropped video went to Gemini as inline video with DeepSeek picked');
 await call('apiDisconnect',{provider:'gemini'});
 const noGemini=await call('addProject');await open(noGemini);await drop('clip.mp4');
 await page.getByText(/Videos go to Gemini\. Connect Gemini in Connections to send this video\./).first().waitFor();
 assert.match(await page.locator('.error[role="alert"]').first().innerText(),/^Videos go to Gemini\. Connect Gemini in Connections to send this video\.\n×$/);
 assert.equal((await call('state')).chats.find((c:any)=>c.id===noGemini).attachments?.length||0,0);
 await page.screenshot({path:path.join(data,'video-no-gemini.png')});
 console.log('PASS 2d without Gemini the app says videos go to Gemini');

 const repo=path.join(folder,'light-app'),remote=path.join(data,'light-remote.git'),git=(...args:string[])=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','init.defaultBranch=main',...args],{windowsHide:true});
 const commit=async(name:string)=>{await fs.writeFile(path.join(repo,name),name);git('-C',repo,'add',name);git('-C',repo,'commit','-q','-m',name);};
 const focus=()=>instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.emit('focus')));
 const light=(state:string,text:string)=>wait(s=>{const app=s.savedApps.find((a:any)=>a.name==='Light app');return app?.light?.state===state&&app.light.text===text;});
 await fs.mkdir(repo);git('init','-q',repo);await commit('one.txt');
 await call('savedAppSave',{name:'Light app',icon:'',stage:'',current:'',ideas:'',planned:'',chatIds:[],repositories:['light-app']});
 await light('unpushed','1 commit not pushed · no remote yet');await page.locator('.saved-app-tile').filter({hasText:'Light app'}).locator('.app-light.unpushed').waitFor();
 await page.screenshot({path:path.join(data,'app-light-unpushed.png')});
 git('init','-q','--bare',remote);git('-C',repo,'remote','add','origin',remote);git('-C',repo,'push','-q','origin','HEAD:main');
 await focus();await light('pushed','All commits pushed');await page.locator('.saved-app-tile').filter({hasText:'Light app'}).locator('.app-light.pushed').waitFor();
 await page.screenshot({path:path.join(data,'app-light-pushed.png')});
 await commit('two.txt');await focus();await light('unpushed','1 commit not pushed');
 await page.locator('.saved-app-select').filter({hasText:'Light app'}).hover();assert.match(await page.locator('#saved-app-tooltip').innerText(),/1 commit not pushed/);
 console.log('PASS 5a app light: yellow with no remote, green once pushed, yellow again for a new commit');
}finally{
 await instance.close().catch(()=>{});ds.stdin.end();ds.kill();api.kill();
 for(const provider of ['deepseek','gemini'])await host.host('delete_key',{provider}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
