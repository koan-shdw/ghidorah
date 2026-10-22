import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {findClaude,runClaude} from '../app/claude';
import {PYTHON} from '../app/backend';
import {Store} from '../app/store';
import {SecretScrubber} from '../app/redaction';
import {WorkCoordination} from '../app/work-coordination';
if(process.env.TRISMEGISTUS_LIVE_COORDINATION!=='1')throw Error('Explicit live coordination opt-in required.');
const executable=(await findClaude())?.executable;assert.ok(executable);
const data=await fs.mkdtemp(path.resolve('work/live-coordination-')),directory=path.join(data,'workspace'),exchangeRoot=path.join(data,'exchange');await fs.mkdir(directory);await fs.mkdir(exchangeRoot);
const file=path.join(directory,'shared.txt');await fs.writeFile(file,'baseline\n');
const store=new Store(path.join(data,'actions.sqlite')),coordination=new WorkCoordination(store),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000),leases=new Map<string,string|null>();
let intervened=false,denials=0;const events:any[]=[];
try{
 const result=await runClaude({executable,python:PYTHON,worker:path.resolve('backend/claude_worker.py'),directory,dataRoot:path.join(data,'protected'),exchangeRoot,model:'haiku',effort:'low',mode:'manual',hasFolder:true,prompt:'Read shared.txt and append exactly one line: model-added. Keep every existing line. Use only Read and Write or Edit tools. If the file changes, read it again and keep the new contents. Reply done.',signal:controller.signal,scrubber:new SecretScrubber(),
  event:event=>{if(['assistant','user','result'].includes(event.type))events.push(event);},
  approve:async(_id,name,args)=>{if(!['Read','Write','Edit'].includes(name)||path.resolve(directory,args.file_path)!==file){denials++;return false;}if(name!=='Read'&&!intervened){await fs.writeFile(file,'baseline\nuser-added-during-approval\n');intervened=true;}return true;},
  work:{before:async(id,name,args)=>{const lease=await coordination.begin('group','native',directory,name,args,controller.signal);leases.set(id,lease);},after:async(id,result,failed)=>{assert.ok(leases.has(id));await coordination.finish(leases.get(id)!, 'native',result,failed);}}
 });
 await fs.writeFile(path.join(data,'events.json'),JSON.stringify(events,null,2));
 const content=await fs.readFile(file,'utf8');await fs.writeFile(path.join(data,'result.json'),JSON.stringify({status:result.status,intervened,denials,content,actions:coordination.records('group')},null,2));
 assert.equal(result.status,'completed');assert.ok(intervened);assert.equal(denials,0);assert.match(content,/baseline/);assert.match(content,/user-added-during-approval/);assert.equal(content.split('model-added').length-1,1);assert.ok(coordination.records('group').some(a=>a.access==='read'&&a.status==='completed'));
 console.log('PASS real native tool hooks and preservation of a user edit during approval: '+data);
}finally{clearTimeout(timer);controller.abort();coordination.interrupt();store.db.close();}
