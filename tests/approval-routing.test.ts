import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {mainSource} from './fixtures/main-source';

// Execute the actual main-process request handler without starting Electron.
const source=process.env.TRIS_APPROVAL_SOURCE?ts.createSourceFile('main.ts',fs.readFileSync(process.env.TRIS_APPROVAL_SOURCE,'utf8'),ts.ScriptTarget.Latest,true):mainSource();
const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='request')!;
const code=ts.transpileModule(declaration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('each live chat uses its current Bypass mode; questions and stopped turns never auto-approve',()=>{
  const chats=[{id:'a',runtimeId:'sa',mode:'bypass'},{id:'b',runtimeId:'sb',mode:'manual'}];
  const turns:any={a:{status:'running'},b:{status:'running'}};
  const saved:any[]=[],answers:any[]=[],requests=new Map();
  const store={all:()=>chats,get:(_kind:string,id:string)=>turns[id],put:(_kind:string,value:any)=>saved.push(value),update:()=>{}};
  const request=new Function('store','hermesTurns','projectFor','backend','requests','emit','askApproval',code+';return request;')(store,new Map(chats.map(c=>[c.id,c.id])),(chat:any)=>chat,{generation:'test',scrubber:{value:(v:any)=>v}},requests,()=>{},(row:any)=>store.put('approval',row));
  const send=(method:string,session_id='sa')=>request({id:'request-'+answers.length,method,params:{session_id,description:'AGENTS.md or private file approval'},respond:(v:any)=>answers.push(v)});
  for(const method of ['approval','approval.request']){send(method);assert.deepEqual(answers.at(-1),{choice:'once'});}
  assert.equal(saved.length,0);
  send('approval','sb');assert.equal(saved.at(-1).chatId,'b');assert.equal(answers.length,2);
  send('clarify');assert.equal(saved.at(-1).method,'clarify');assert.equal(answers.length,2);
  chats[0].mode='manual';send('approval');assert.equal(answers.length,2);
  chats[0].mode='bypass';turns.a.status='stopped';send('approval');assert.deepEqual(answers.at(-1),{choice:'deny'});
  send('clarify');assert.deepEqual(answers.at(-1),{});
  assert.equal(send('approval','unknown-session'),false);
});

test('expired permissions release only their original matching action; answered requests stay answered',()=>{
 const node=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='receive')!;
 const body=ts.transpileModule(node.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const approval={status:'pending',method:'approval',turnId:'original-turn',params:{description:'write_file: {}',command:'exact command'}},denied:any[]=[];
 const receive=new Function('backend','requests','mcpToolRequests','store','coordination','emit',body+';return receive;')({generation:'test'},new Map(),new Map(),{get:()=>approval,update:(_k:string,_id:string,value:any)=>Object.assign(approval,value)},{denied:(...args:any[])=>denied.push(args)},()=>{});
 receive({type:'request.cancel',payload:{id:'1'}});assert.equal(approval.status,'expired');assert.deepEqual(denied[0],['original-turn','write_file: {}','exact command','Approval expired before execution.']);
 approval.status='approved';receive({type:'request.cancel',payload:{id:'1'}});assert.equal(approval.status,'approved');assert.equal(denied.length,1);
 approval.status='pending';approval.method='clarify';receive({type:'request.cancel',payload:{id:'2'}});assert.equal(denied.length,1);
});
