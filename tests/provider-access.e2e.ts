import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {AccountHealth,blockedFor} from '../app/availability';
import {providerAccess} from '../app/provider-access';
import {PYTHON} from '../app/backend';

const data=await fs.mkdtemp(path.resolve('work/provider-access-')),records=path.join(data,'main.jsonl'),auxRecords=path.join(data,'aux.jsonl');
const store=new Store(path.join(data,'chat.sqlite')),health=new AccountHealth(store),owner=await providerAccess(health,()=>{});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:records,FIXTURE_AUX_RECORDS:auxRecords},windowsHide:true,stdio:'pipe'});
const lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line'),url=JSON.parse(line).url;
const probe=spawn(PYTHON,['tests/fixtures/provider-probe.py'],{env:{...process.env,HERMES_HOME:path.join(data,'home')},windowsHide:true,stdio:'pipe'}),responses=createInterface({input:probe.stdout});
let diagnostics='';probe.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-3000);});
const next=()=>new Promise<any>((resolve,reject)=>{const clean=()=>{clearTimeout(timer);responses.off('line',reply);probe.off('close',closed);};const closed=()=>{clean();reject(Error('Probe stopped: '+diagnostics));};const timer=setTimeout(()=>{clean();reject(Error('Probe timed out: '+diagnostics));},90000);const reply=(line:string)=>{clean();resolve(JSON.parse(line));};responses.once('line',reply);probe.once('close',closed);});
const count=async()=>{const rows=await Promise.all([records,auxRecords].map(file=>fs.readFile(file,'utf8').then(text=>text.trim().split('\n').filter(Boolean),()=>[])));return rows.flat().length;};
const send=async(kind:string,profile='A',text='A short title',task='title_generation')=>{const pending=next();probe.stdin.write(JSON.stringify({kind,profile,text,task})+'\n');return pending;};
try{
 const ready=next();probe.stdin.write(JSON.stringify({root:data,url,connection:owner.connection})+'\n');assert.ok((await ready).ready);
 assert.equal((await fetch(owner.connection.url,{method:'POST',body:'{}'})).status,403);
 for(const profile of ['A','B','A'])assert.ok((await send('sync',profile)).ok,diagnostics);
 assert.ok((await send('async','B')).ok,diagnostics);assert.ok((await send('stream','A','Stream compression','compression')).ok,diagnostics);assert.ok((await send('background','B')).ok,diagnostics);
 console.log('PASS real auxiliary sync/async/stream/background calls under A-B-A profiles');
 const before=await count();assert.ok((await send('async','A','EXHAUST_SIDE_FIXTURE')).error);assert.equal(blockedFor(health.rows(),'deepseek-flash')?.reason,'credit');assert.equal(await count(),before+1);
 for(const kind of ['sync','async','stream','background'])assert.ok((await send(kind,'B','Refuse after exhaustion')).error,kind);
 assert.equal(await count(),before+1,'Unavailable supporting/background requests must never reach the provider');
 health.observe('deepseek','billing','credit',false,Date.now()+1);assert.ok((await send('sync','A')).ok,diagnostics);assert.equal(await count(),before+2);
 owner.close();assert.ok((await send('async','B','Owner stopped')).error);assert.equal(await count(),before+2,'Losing main must not bypass account checks');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({checks:['private owner authentication','real sync/async/stream/background auxiliary paths','A-B-A profiles','side failure saved before retry','cached clients blocked','restoration','owner lost fails closed']},null,2));console.log('PASS real Hermes auxiliary sync/async/stream/background, A-B-A, durable refusal before retries, restoration and owner-loss refusal\nEvidence: '+data);
}catch(error){console.error(diagnostics);throw error;}
finally{const finished=[probe,fake].map(child=>child.exitCode===null?once(child,'close'):Promise.resolve());probe.stdin.end();fake.stdin.end();responses.close();lines.close();owner.close();store.db.close();await Promise.all(finished);}
