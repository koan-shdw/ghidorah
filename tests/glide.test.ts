import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {decideGlide,glideEndpoint,glideRequest,readGlide,type JevState} from '../app/jev';

// Fastino's documented System One shapes (docs.fastino.ai/inference/systemone, read 2 October): the request names
// model fastino/GLiDE, Choice criteria map keys to descriptions, and a Choice answer carries choice and probabilities.
const state:JevState={summary:'Fix the failing build',current:null,selected:[],models:[{id:'a',label:'Model A',available:true,capabilities:['text','coding']},{id:'b',label:'Model B',available:true,capabilities:['text']}],health:[],attachmentTypes:[]};
const settings={summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:5000};

test('GLiDE request: documented model, plain descriptions, non-empty instructions; its answers read as Jev\'s',()=>{
 assert.equal(glideEndpoint(),'https://api.fastino.ai/v1');assert.throws(()=>glideEndpoint('https://example.com/v1'));
 const request=glideRequest(state);assert.equal(request.model,'fastino/GLiDE');
 for(const question of Object.values(request.questions) as any[]){assert.ok(typeof question.instructions==='string'&&question.instructions.length>0);for(const value of Object.values(question.criteria))assert.equal(typeof value,'string');}
 assert.equal((request.questions.primary as any).criteria.a,'Model A: text, coding');
 const read=readGlide({model:'glide',answers:{primary:{type:'choice',choice:'b',probabilities:{a:0.1,b:0.85,ask:0.05}}},usage:{input_tokens:89,output_tokens:1}});
 assert.equal(read.answers.primary.confidence,0.85);assert.equal(read.usage.output_tokens,1);
});

test('GLiDE call: X-API-Key header, retries 503 then answers, never retries 401, refuses oversized input',async()=>{
 const seen:any[]=[];let fail:number[]=[],retryAfter='';
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;seen.push({headers:req.headers,body:JSON.parse(text)});
  const status=fail.shift();if(status){if(retryAfter)res.setHeader('Retry-After',retryAfter);res.writeHead(status).end();return;}
  const answers=Object.fromEntries(Object.entries(seen.at(-1).body.questions).map(([name,question]:[string,any])=>{const choice=name==='execution'?'single':Object.hasOwn(question.criteria,'a')?'a':'ask';return [name,{type:'choice',choice,probabilities:{[choice]:0.9}}];}));
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'glide',answers,usage:{input_tokens:50,output_tokens:2}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=glideEndpoint(`http://127.0.0.1:${(server.address() as any).port}/v1`);
 try{
  fail=[503];const pick=await decideGlide(endpoint,'synthetic-glide-key',state,settings,new AbortController().signal);
  assert.equal(pick.model,'a');assert.match(pick.message,/^GLiDE /);assert.equal(seen.length,2);
  assert.equal(seen[1].headers['x-api-key'],'synthetic-glide-key');assert.equal(seen[1].headers.authorization,undefined);
  fail=[401];await assert.rejects(decideGlide(endpoint,'synthetic-glide-key',state,settings,new AbortController().signal),/GLiDE: sign in again/);assert.equal(seen.length,3);
  await assert.rejects(decideGlide(endpoint,'k',{...state,summary:'x'.repeat(170_000)},settings,new AbortController().signal),/too large/);assert.equal(seen.length,3);
  fail=[425];retryAfter='1';const started=Date.now();await decideGlide(endpoint,'k',state,settings,new AbortController().signal);
  assert.ok(Date.now()-started>=950,'honour the supplier retry delay');
  fail=[425];retryAfter='60';const abort=new AbortController(),pending=decideGlide(endpoint,'k',state,settings,abort.signal);setTimeout(()=>abort.abort(),30);
  const cancelled=Date.now();await assert.rejects(pending);assert.ok(Date.now()-cancelled<400,'Stop cancels the retry wait');
 }finally{server.close();}
});
