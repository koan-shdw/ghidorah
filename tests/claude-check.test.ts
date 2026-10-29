import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {mainSource} from './fixtures/main-source';
import {claudeModelList,retiredClaudeModels} from '../app/claude';

const source=mainSource();
function main(name:string,env:Record<string,unknown>){
 let node:ts.Node|undefined;const visit=(n:ts.Node)=>{if(ts.isFunctionDeclaration(n)&&n.name?.getText(source)===name)node=n;ts.forEachChild(n,visit);};visit(source);assert.ok(node);
 return new Function(...Object.keys(env),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(env));
}

// 10-26: Claude Code took 20 s to answer the usage request; the 15 s wait failed the check and dropped every Claude
// model, so no Claude chat could run.
test('a signed-in Claude Code keeps its models when the usage answer is late or missing',async()=>{
 const models=[{id:'claude-code:opus'},{id:'claude-code:haiku'}];
 const env=(result:unknown)=>({checkingClaude:false,claudeFirstCheck:true,claude:{connected:false,status:''},claudeExecutable:null,started:0,
  fixtureClaude:()=>undefined,existsSync:()=>true,findClaude:async()=>({executable:'claude.exe',version:'2.1.309 (Claude Code)'}),claudeAccount:async()=>({loggedIn:true,subscription:true}),
  health:{observe:()=>{},claudeUsage:()=>{}},emit:()=>{},path:{join:(...parts:string[])=>parts.join('/')},data:'data',root:'root',fs:{mkdir:async()=>{}},
  fixtureClaudeArgs:()=>[],backend:{python:'python',scrubber:{}},claudeUsage:()=>({windows:[]}),
  claudeModelList,claudeRechecked:true,renameRetiredClaude:()=>{},runClaude:async()=>({status:'completed',result,models})});
 assert.deepEqual(await main('checkClaude',env(null))(),['opus','haiku'],'no usage answer: the models stay');
 assert.deepEqual(await main('checkClaude',env({rate_limits_available:true}))(),['opus','haiku'],'with usage: unchanged');
});

// 10-29: Claude Code listed Fable 5.1 as fable, while saved choices kept claude-fable-5-1, so Fable looked down.
test('a renamed Claude model maps to the one Claude Code lists now, by its name',()=>{
 const listed=[['default','Default (recommended)'],['opus','Opus 5.5'],['fable','Fable 5.1'],['sonnet','Sonnet 5.5'],['claude-opus-5','Opus 5'],['claude-haiku-4-5-20251001','Haiku 4.5']].map(([id,label])=>({id:'claude-code:'+id,label}));
 const renames=retiredClaudeModels(listed);
 assert.equal(renames.get('claude-code:claude-fable-5-1'),'claude-code:fable');
 assert.equal(renames.get('claude-code:claude-opus-5-5'),'claude-code:opus');
 assert.equal(renames.get('claude-code:claude-haiku-4-5'),'claude-code:claude-haiku-4-5-20251001');
 assert.equal(renames.has('claude-code:claude-opus-5'),false,'a name Claude Code still lists is never renamed');
 assert.equal([...renames.values()].includes('claude-code:default'),false,'labels without a version map nothing');
});

test('saved Claude choices follow a rename: defaults, favourites, chats and waiting messages, nothing else',async()=>{
 const {Store}=await import('../app/store');const store=new Store(':memory:'),project=store.project('C:/work'),chat=store.chat(project.id),other=store.chat(project.id);
 store.put('settings',{id:'default-models',models:['claude-code:opus','claude-code:claude-fable-5-1']});
 store.put('settings',{id:'favourite-models',models:['claude-code:claude-fable-5-1','claude-code:fable','gpt-6-astra']});
 store.update<any>('chat',chat.id,{model:'claude-code:claude-fable-5-1',pool:['claude-code:claude-fable-5-1','gpt-6-astra'],selectedModels:['claude-code:claude-fable-5-1'],efforts:{'claude-code:claude-fable-5-1':'high'}});
 store.update<any>('chat',other.id,{model:'gpt-6-astra',pool:['gpt-6-astra']});
 const turn=(id:string,status:string)=>store.put('turn',{id,chatId:chat.id,prompt:'p',text:'',reasoning:'',status,model:'claude-code:claude-fable-5-1',error:null,usage:null,created:0});
 turn('waiting','queued');turn('done','completed');
 main('renameRetiredClaude',{store,retiredClaudeModels})([{id:'claude-code:fable',label:'Fable 5.1'},{id:'claude-code:opus',label:'Opus 5.5'}]);
 const settings=(id:string)=>store.all<any>('settings').find(row=>row.id===id).models;
 assert.deepEqual(settings('default-models'),['claude-code:opus','claude-code:fable']);
 assert.deepEqual(settings('favourite-models'),['claude-code:fable','gpt-6-astra'],'no duplicate after the rename');
 const renamed=store.get<any>('chat',chat.id);
 assert.deepEqual([renamed.model,renamed.pool,renamed.selectedModels,renamed.efforts],['claude-code:fable',['claude-code:fable','gpt-6-astra'],['claude-code:fable'],{'claude-code:fable':'high'}]);
 assert.equal(store.get<any>('chat',other.id).model,'gpt-6-astra');
 assert.equal(store.get<any>('turn','waiting').model,'claude-code:fable','a waiting message is sent with the listed model');
 assert.equal(store.get<any>('turn','done').model,'claude-code:claude-fable-5-1','history keeps the name it ran under');
});
