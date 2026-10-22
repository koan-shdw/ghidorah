import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

// Finish plan section 2 in the desktop: the expanded model bar shows level, sign-in state, health dot and vendor address (2f).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-2-')),healthFile=path.join(data,'health.json');
await fs.writeFile(healthFile,JSON.stringify({deepseek:'ready'}));
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl'),FIXTURE_HEALTH_FILE:healthFile},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
const api=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),[aline]=await once(createInterface({input:api.stdout}),'line');
const deepseekUrl=JSON.parse(dline).url,geminiUrl=JSON.parse(aline).gemini;
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:deepseekUrl,TRISMEGISTUS_TEST_API_URLS:JSON.stringify({gemini:geminiUrl})},timeout:30000});
try{
 const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(150);}throw Error('Timed out: '+JSON.stringify(await call('state')));};
 await wait(s=>s.backend==='ready'&&s.availableModels.includes('deepseek-flash'));
 await call('apiSave',{provider:'gemini',key:'synthetic-gemini-test-credential'});
 const gemini='api:gemini:gemini-3.8-flash';await wait(s=>s.availableModels.includes(gemini));
 const chat=await call('addProject');await call('addModel',{chatId:chat,model:gemini});await call('effort',{chatId:chat,model:gemini,effort:'low'});
 if(await page.getByRole('button',{name:'Close settings',exact:true}).count())await page.getByRole('button',{name:'Close settings',exact:true}).click();
 await page.locator('[data-chat-id="'+chat+'"] .chat-link').click();
 await page.getByRole('button',{name:'Model details',exact:true}).first().click();
 const section=(label:string)=>page.locator('.usage-model').filter({has:page.locator('h3',{hasText:label})}).first().locator('.usage-model-details');
 const deepseek=section('DeepSeek'),flash=section('gemini-3.8-flash');
 await deepseek.waitFor();
 assert.deepEqual(await deepseek.locator('span[title="Thinking level"]').innerText(),'High');
 assert.equal(await deepseek.locator('.usage-signin').innerText(),'Connected');assert.match(await deepseek.locator('.health-dot').getAttribute('class')||'',/ok/);
 assert.equal(await deepseek.locator('.usage-address').innerText(),deepseekUrl);
 assert.equal(await flash.locator('span[title="Thinking level"]').innerText(),'Low');
 assert.equal(await flash.locator('.usage-signin').innerText(),'Connected');
 assert.equal(await flash.locator('.usage-address').innerText(),geminiUrl);
 await fs.writeFile(healthFile,JSON.stringify({deepseek:'auth'}));await call('checkAccount');await wait(s=>s.providerStatus==='Authentication failed');
 await page.waitForFunction(()=>[...document.querySelectorAll('.usage-model')].some(section=>section.querySelector('h3')?.textContent==='DeepSeek'&&section.querySelector('.usage-model-details .health-dot.down')));
 await page.screenshot({path:path.join(data,'model-details.png')});
 console.log('PASS 2f expanded bar: level, sign-in state, health dot and the fakes\' live addresses for DeepSeek and Gemini');
}finally{
 await instance.close().catch(()=>{});ds.stdin.end();ds.kill();api.kill();
 for(const provider of ['deepseek','gemini'])await host.host('delete_key',{provider}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
