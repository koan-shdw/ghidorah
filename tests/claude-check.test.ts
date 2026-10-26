import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {mainSource} from './fixtures/main-source';

const source=mainSource();
function main(name:string,env:Record<string,unknown>){
 let node:ts.Node|undefined;const visit=(n:ts.Node)=>{if(ts.isFunctionDeclaration(n)&&n.name?.getText(source)===name)node=n;ts.forEachChild(n,visit);};visit(source);assert.ok(node);
 return new Function(...Object.keys(env),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(env));
}

// 10-26: Claude Code took 20 s to answer the usage request; the 15 s wait failed the check and dropped every Claude
// model, so no Claude chat could run.
test('a signed-in Claude Code keeps its models when the usage answer is late or missing',async()=>{
 const models=[{id:'claude-code:opus'},{id:'claude-code:haiku'}];
 const env=(result:unknown)=>({checkingClaude:false,claude:{connected:false,status:''},claudeExecutable:null,started:0,
  fixtureClaude:()=>undefined,existsSync:()=>true,findClaude:async()=>({executable:'claude.exe',version:'2.1.309 (Claude Code)'}),claudeAccount:async()=>({loggedIn:true,subscription:true}),
  health:{observe:()=>{},claudeUsage:()=>{}},emit:()=>{},path:{join:(...parts:string[])=>parts.join('/')},data:'data',root:'root',fs:{mkdir:async()=>{}},
  fixtureClaudeArgs:()=>[],backend:{python:'python',scrubber:{}},claudeUsage:()=>({windows:[]}),
  runClaude:async()=>({status:'completed',result,models})});
 assert.deepEqual(await main('checkClaude',env(null))(),['opus','haiku'],'no usage answer: the models stay');
 assert.deepEqual(await main('checkClaude',env({rate_limits_available:true}))(),['opus','haiku'],'with usage: unchanged');
});
