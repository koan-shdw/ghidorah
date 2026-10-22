import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {decideNotDiamond,notDiamondEndpoint,notDiamondRequest} from '../app/notdiamond';
import type {JevState} from '../app/jev';

const catalog=[{provider:'deepseek',model:'deepseek-flash'},{provider:'openai',model:'gpt-6-astra'},{provider:'anthropic',model:'claude-haiku-4-5'}];
const settings={summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:5000};
const state:JevState={summary:'Summarize the incident report',current:null,selected:[],health:[],attachmentTypes:[],models:[
 {id:'deepseek-flash',label:'DeepSeek',available:true,capabilities:['text']},
 {id:'gpt-6-astra',label:'gpt-6-astra',available:true,capabilities:['text']},
 {id:'claude-code:haiku',label:'Claude Haiku',available:true,capabilities:['text']},
 {id:'api:gemini:gemini-3.8-flash',label:'gemini-3.8-flash',available:false,capabilities:['text']},
 {id:'api:zai:glm-5',label:'glm-5',available:true,capabilities:['text']}]};

test('Not Diamond request: the summary only, the chat\'s models in its provider names, unlisted suppliers left out',()=>{
 assert.equal(notDiamondEndpoint(),'https://api.notdiamond.ai/v2');
 const {asked,left,body}=notDiamondRequest(state,catalog);
 assert.deepEqual(body.messages,[{role:'user',content:'Summarize the incident report'}]);
 assert.deepEqual(body.llm_providers,[{provider:'deepseek',model:'deepseek-flash'},{provider:'openai',model:'gpt-6-astra'}]);
 assert.deepEqual(left,['Claude Haiku','glm-5']);assert.equal(asked.length,2);
});

test('Not Diamond call: Bearer key, documented response read back to a model, anything else refused',async()=>{
 let seen:any,reply:any;
 const server=createServer(async(req,res)=>{if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:catalog}));return;}let text='';for await(const chunk of req)text+=chunk;seen={url:req.url,auth:req.headers.authorization,body:JSON.parse(text)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify(reply));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=notDiamondEndpoint(`http://127.0.0.1:${(server.address() as any).port}/v2`);
 try{
  reply={providers:[{provider:'openai',model:'gpt-6-astra'}],session_id:'550e8400-e29b-41d4-a716-446655440000'};
  const pick=await decideNotDiamond(endpoint,'synthetic-nd-key',state,settings,new AbortController().signal);
  assert.equal(pick.model,'gpt-6-astra');assert.match(pick.message,/Not asked: Claude Haiku, glm-5/);assert.ok(Number.isNaN(pick.confidence));
  assert.equal(seen.url,'/v2/modelRouter/modelSelect');assert.equal(seen.auth,'Bearer synthetic-nd-key');
  reply={providers:[{provider:'google',model:'gemini-3.8-flash'}],session_id:'x'};
  await assert.rejects(decideNotDiamond(endpoint,'synthetic-nd-key',state,settings,new AbortController().signal),/invalid decision/);
 }finally{server.close();}
});
