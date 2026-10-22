import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Exercise the real main and split/pop-out handlers without launching the app.
const source=ts.createSourceFile('ui.tsx',fs.readFileSync('app/ui.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function handler(name:string,environment:Record<string,unknown>){
 let code='';
 const visit=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)code=node.getText(source);ts.forEachChild(node,visit);};visit(source);
 assert.ok(code,name);
 return new Function(...Object.keys(environment),ts.transpile(code,{target:ts.ScriptTarget.ES2022})+'\nreturn '+name)(...Object.values(environment));
}

test('ordinary sends queue during work; stopping requires the explicit correction action',async()=>{
 for(const name of ['submit','correct']){
  const sent:{method:string;args:any}[]=[],env={sending:{current:false},otherEditor:false,chat:{attachments:[] as object[]},draft:'Additional direction',busy:false,state:{availableModels:['gpt-6-astra']},working:true,ordinary:true,chatId:'chat',editorRevision:{current:0},draftEdits:{current:0},setBusy:()=>{},setDraft:()=>{},call:async(method:string,args:any)=>{sent.push({method,args});}};
  await handler(name,env)();
  assert.equal(sent.pop()?.method,'submit',name+' must keep the running reply alive');
  await handler(name,env)(...(name==='submit'?[undefined,false]:[false]));
  assert.equal(sent.pop()?.method,'correctGroup',name+' keeps explicit Stop and send');
  env.draft='';env.chat.attachments=[{id:'image'}];await handler(name,env)();
  assert.equal(sent.pop()?.method,'submit','Image-only messages also queue');
  env.draft='Normal message';env.working=false;await handler(name,env)();
  assert.equal(sent.pop()?.method,'submit','Idle sends still submit normally');
  env.sending.current=true;await handler(name,env)();assert.equal(sent.length,0,'Duplicate send is suppressed');
 }
});
