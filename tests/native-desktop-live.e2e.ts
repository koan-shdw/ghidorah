// Opt-in subscription proof for desktop ownership, not a protocol fixture.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
if(process.env.TRISMEGISTUS_LIVE_CLAUDE!=='1')throw Error('Set TRISMEGISTUS_LIVE_CLAUDE=1 for this subscription check.');
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-desktop-live-')),folder=await fs.mkdtemp(path.join(root,'work/native-live-project-'));
const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
await fs.writeFile(path.join(folder,'server.py'),`from http.server import HTTPServer,BaseHTTPRequestHandler\nimport threading,os,sys\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'native-desktop-live')\n def log_message(self,*args): pass\nseconds=int(sys.argv[1])\nif seconds: threading.Timer(seconds,lambda:os._exit(0)).start()\nHTTPServer(('127.0.0.1',${port}),H).serve_forever()\n`);
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000});const page=await app.firstWindow();
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const approved:any[]=[];let latest:any,model:string;
const wait=async(predicate:(state:any)=>boolean,timeout=90000)=>{const until=Date.now()+timeout;while(Date.now()<until){latest=await call('state');if(predicate(latest))return latest;for(const a of latest.approvals.filter((a:any)=>a.status==='pending')){
 const description=a.params.description||'',turn=latest.turns.find((t:any)=>t.id===a.turnId);let permit=false;
 if(description.startsWith('Read\n'))permit=/server\.py/.test(description);
 if(description.startsWith('Bash\n')){const args=JSON.parse(description.slice(5));permit=['python -u server.py 40','python -u server.py 0'].includes(args.command)&&args.run_in_background===true;}
 if(description.startsWith('Write\n')){const args=JSON.parse(description.slice(6));permit=!!turn?.automatic&&path.basename(args.file_path)==='finished.txt'&&args.content.trim()==='FINISHED';}
 approved.push({turnId:a.turnId,automatic:turn?.automatic,tool:description.split('\n')[0],approved:permit});await call('approve',{id:a.id,choice:permit?'once':'deny'});
 }await page.waitForTimeout(100);}throw Error('Timed out '+JSON.stringify(latest.turns.map((t:any)=>({id:t.id,status:t.status,text:t.text,error:t.error}))));};
const send=async(chatId:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted','needs-model'].includes(t.status)));assert.equal(latest.turns.find((t:any)=>t.id===id).status,'completed');return id;};
const health=async()=>assert.equal(await(await fetch('http://127.0.0.1:'+port)).text(),'native-desktop-live');
const stopped=async()=>{const started=Date.now();while(Date.now()-started<5000){try{await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(500)});}catch{return Date.now()-started;}await page.waitForTimeout(50);}throw Error('Native reported Stop, but its HTTP child still responds after five seconds.');};
try{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));
 await wait(s=>s.backend==='ready');await call('claudeCheck');
 await wait(s=>s.backend==='ready'&&s.claude?.models?.length);model=(latest.claude.models.find((m:any)=>m.id==='claude-code:haiku')||latest.claude.models.find((m:any)=>m.id==='claude-code:claude-haiku-4-5'))?.id;assert.ok(model);
 await call('workingFolder',{folder});const chatId=await call('addProject');await call('addModel',{chatId,model});await call('effort',{chatId,model,effort:'low'});
 const instruction=(seconds:number)=>`Read server.py. Use inspect_action to assess Bash with exact arguments {"command":"python -u server.py ${seconds}","run_in_background":true}, evidence ["server.py"], and resources for observing server.py and writing port tcp:${port}. Then run that exact Bash command once. It is a tiny local HTTP server. Do not use other commands or poll it. Reply STARTED and leave it running.`;
 const first=await send(chatId,instruction(40)+' When its completion notification arrives, use Write to save FINISHED in finished.txt, then reply FINISHED.');await health();
 const start=latest.turns.find((t:any)=>t.id===first),row=latest.background.find((r:any)=>r.turnId===first);assert.ok(row);assert.equal(row.status,'running');
 const second=await send(chatId,'Reply FOLLOWUP only. Leave the server running and use no tools.');await health();
 await wait(s=>s.turns.some((t:any)=>t.automatic?.originTurnId===first&&t.status==='completed'));
 const update=latest.turns.find((t:any)=>t.automatic?.originTurnId===first);assert.equal((await fs.readFile(path.join(folder,'finished.txt'),'utf8')).trim(),'FINISHED');assert.equal(latest.turns.find((t:any)=>t.id===first).text,start.text);assert.ok(update.usage?.turn_total>0);assert.equal(latest.background.find((r:any)=>r.id===row.id).status,'exited');
 assert.ok(approved.some(a=>a.turnId===update.id&&a.tool==='Write'&&a.approved));await assert.rejects(fetch('http://127.0.0.1:'+port));
 console.log('PASS real desktop native server across replies, owned automatic Write approval, saved background result and usage');
 const third=await send(chatId,instruction(0));await health();const running=latest.background.find((r:any)=>r.turnId===third);assert.equal(running.generation,row.generation);
 await call('backgroundStop',{id:running.id});await wait(s=>s.background.find((r:any)=>r.id===running.id)?.status==='stopped');const stopDelayMs=await stopped();
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({first,second,third,runtime:row.generation,sameRuntime:true,serverAcrossReplies:true,automaticSaved:true,automaticApproval:true,explicitStop:true,stopDelayMs,context:latest.turns.find((t:any)=>t.id===second).usage,approved},null,2));
 console.log('PASS real desktop native task Stop with retained worker. Evidence: '+data);
}finally{if(latest)await fs.writeFile(path.join(data,'last-state.json'),JSON.stringify(latest,null,2));await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
