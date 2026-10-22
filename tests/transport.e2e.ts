import {Backend} from '../app/backend';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const root=path.resolve('.'),data=path.join(root,'work','transport-'+Date.now());
const home=path.join(data,'hermes');await fs.mkdir(path.join(home,'plugins'),{recursive:true});
await fs.cp(path.join(root,'plugins','trismegistus-permissions'),path.join(home,'plugins','trismegistus-permissions'),{recursive:true});
await fs.writeFile(path.join(home,'config.yaml'),JSON.stringify({plugins:{enabled:['trismegistus-permissions']},auth:{adopt_external_logins:false},approvals:{mode:'manual'}}));
await fs.writeFile(path.join(home,'trismegistus-policy.json'),JSON.stringify({mode:'manual',folder:root,secrets_root:data}));
const backend=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
try{
 await backend.host('initialize');await backend.start(null);
 const base=`http://127.0.0.1:${backend.port}`;
 const landing=await fetch(base);assert.ok(!(await landing.text()).includes(backend.token));
 const unauth=await fetch(base+'/api/config');assert.equal(unauth.status,401);
 const denied=await new Promise<number>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${backend.port}/api/ws?token=wrong`);ws.on('unexpected-response',(_,res)=>{resolve(res.statusCode!);ws.terminate();});ws.on('open',()=>{ws.close();reject(Error('Unauthenticated socket accepted'));});ws.on('error',()=>{});});
 assert.ok([401,403].includes(denied));console.log('PASS root contains no token; HTTP and WebSocket reject missing/wrong token');
 backend.child!.stdin.end();
 const until=Date.now()+15000;while(backend.child&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
 assert.equal(backend.child,null);console.log('PASS supervisor pipe closure stops the backend process tree');
}finally{await backend.stop();}
