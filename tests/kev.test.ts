import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {decideKev,localEndpoint,type JevState} from '../app/jev';

const state:JevState={summary:'Fix the failing build',current:null,selected:[],models:['a','b'].map(id=>({id,label:id,available:true,capabilities:['text']})),health:[],attachmentTypes:[]};
const settings={summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:2000};

test('Kev: a local address only, Jev\'s questions with no key, the state as text, truncation refused',async()=>{
 assert.equal(localEndpoint('http://127.0.0.1:8009/v1/'),'http://127.0.0.1:8009/v1');
 for(const bad of ['https://127.0.0.1:8009/v1','http://localhost:8009/v1','http://192.168.1.4:8009/v1','http://user:pw@127.0.0.1:8009','http://127.0.0.1:8009/v1?x=1','not a url'])assert.throws(()=>localEndpoint(bad),/127\.0\.0\.1/);
 let seen:any,truncated=false;
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;seen={headers:req.headers,url:req.url,body:JSON.parse(text)};
  const answers=Object.fromEntries(Object.entries(seen.body.questions).map(([name,question]:[string,any])=>[name,{type:'choice',choice:name==='execution'?'single':Object.hasOwn(question.criteria,'b')?'b':'ask',confidence:0.9}]));
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'kev-latest',answers,usage:{input_tokens:40,output_tokens:2,...(truncated?{truncated:true}:{})}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 try{
  const pick=await decideKev(endpoint,state,settings,new AbortController().signal);
  assert.equal(pick.model,'b');assert.match(pick.message,/^Kev /);
  assert.equal(seen.url,'/v1/systemone');assert.equal(seen.headers.authorization,undefined);assert.equal(seen.body.model,'kev-latest');
  assert.equal(typeof seen.body.state,'string');assert.equal(JSON.parse(seen.body.state).summary,'Fix the failing build');assert.ok(seen.body.questions.primary);
  truncated=true;await assert.rejects(decideKev(endpoint,state,settings,new AbortController().signal),/complete routing input/);
 }finally{server.close();}
});
