import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {mainSource} from './fixtures/main-source';
import {claudeModelList,retiredClaudeModels,newerClaudeModels} from '../app/claude';

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
 main('renameRetiredClaude',{store,retiredClaudeModels,newerClaudeModels})([{id:'claude-code:fable',label:'Fable 5.1'},{id:'claude-code:opus',label:'Opus 5.5'}]);
 const settings=(id:string)=>store.all<any>('settings').find(row=>row.id===id).models;
 assert.deepEqual(settings('default-models'),['claude-code:opus','claude-code:fable']);
 assert.deepEqual(settings('favourite-models'),['claude-code:fable','gpt-6-astra'],'no duplicate after the rename');
 const renamed=store.get<any>('chat',chat.id);
 assert.deepEqual([renamed.model,renamed.pool,renamed.selectedModels,renamed.efforts],['claude-code:fable',['claude-code:fable','gpt-6-astra'],['claude-code:fable'],{'claude-code:fable':'high'}]);
 assert.equal(store.get<any>('chat',other.id).model,'gpt-6-astra');
 assert.equal(store.get<any>('turn','waiting').model,'claude-code:fable','a waiting message is sent with the listed model');
 assert.equal(store.get<any>('turn','done').model,'claude-code:claude-fable-5-1','history keeps the name it ran under');
});

// 11-13: Claude Code listed Fable 5.2 as claude-fable-5-2 while fable stayed Fable 5.1, so Koan's defaults,
// favourites and 57 chats stayed on 5.1.
test('a model saved under its short name points to the newest listed version; a full older version maps nothing',()=>{
 const listed=[['default','Default (recommended)'],['opus','Opus 5.5'],['claude-fable-5-2','Fable 5.2'],['sonnet','Sonnet 5.5'],['haiku','Haiku 5.5'],['fable','Fable 5.1'],['claude-haiku-4-5-20251001','Haiku 4.5'],['claude-sonnet-5','Sonnet 5'],['claude-opus-5','Opus 5'],['claude-fable-5','Fable 5'],['claude-opus-4-8','Opus 4.8'],['claude-haiku-4-5','Haiku 4.5']].map(([id,label])=>({id:'claude-code:'+id,label}));
 assert.deepEqual([...newerClaudeModels(listed)],[['claude-code:fable','claude-code:claude-fable-5-2']],'what Claude Code listed on 2026-11-13');
 assert.equal(newerClaudeModels([...listed,{id:'claude-code:claude-fable-5-10',label:'Fable 5.10'}]).get('claude-code:fable'),'claude-code:claude-fable-5-10','the newest of several; 5.10 is after 5.2');
 assert.equal(newerClaudeModels(listed.filter(model=>model.id!=='claude-code:claude-fable-5-2')).size,0,'nothing newer listed');
});

test('saved choices move to the newer version once; the older one linked again afterwards stays',async()=>{
 const {Store}=await import('../app/store');const store=new Store(':memory:'),project=store.project('C:/work'),chat=store.chat(project.id),old=store.chat(project.id),other=store.chat(project.id);
 const fable='claude-code:fable',next='claude-code:claude-fable-5-2',opus48='claude-code:claude-opus-4-8';
 const listed=[{id:fable,label:'Fable 5.1'},{id:next,label:'Fable 5.2'},{id:'claude-code:opus',label:'Opus 5.5'},{id:opus48,label:'Opus 4.8'}];
 store.put('settings',{id:'default-models',models:['claude-code:opus','gpt-6-astra',fable]});
 store.put('settings',{id:'favourite-models',models:['deepseek-flash',fable,next,opus48]});
 store.update<any>('chat',chat.id,{model:fable,pool:[fable,'claude-code:opus'],selectedModels:[fable],lockedModel:fable,efforts:{[fable]:'max'}});
 store.update<any>('chat',old.id,{model:'claude-code:claude-fable-5-1',pool:['claude-code:claude-fable-5-1']});
 store.update<any>('chat',other.id,{model:opus48,pool:[opus48,'gpt-6-astra']});
 const turn=(id:string,status:string)=>store.put('turn',{id,chatId:chat.id,prompt:'p',text:'',reasoning:'',status,model:fable,error:null,usage:null,created:0});
 turn('waiting','queued');turn('done','completed');
 const run=()=>main('renameRetiredClaude',{store,retiredClaudeModels,newerClaudeModels})(listed);
 const settings=(id:string)=>store.all<any>('settings').find(row=>row.id===id).models;
 run();
 assert.deepEqual(settings('default-models'),['claude-code:opus','gpt-6-astra',next]);
 assert.deepEqual(settings('favourite-models'),['deepseek-flash',next,opus48],'no duplicate; a full older version stays');
 const moved=store.get<any>('chat',chat.id);
 assert.deepEqual([moved.model,moved.pool,moved.selectedModels,moved.lockedModel,moved.efforts],[next,[next,'claude-code:opus'],[next],next,{[next]:'max'}]);
 assert.equal(store.get<any>('chat',old.id).model,next,'an old full name goes to the short name and on to the newer version');
 assert.deepEqual(store.get<any>('chat',other.id).pool,[opus48,'gpt-6-astra']);
 assert.equal(store.get<any>('turn','waiting').model,next);assert.equal(store.get<any>('turn','done').model,fable,'history keeps the name it ran under');
 assert.deepEqual(settings('claude-followed'),[next]);
 // Linked again on purpose: the next check leaves it.
 store.update<any>('chat',chat.id,{model:fable,pool:[fable,next]});run();
 assert.deepEqual([store.get<any>('chat',chat.id).model,store.get<any>('chat',chat.id).pool],[fable,[fable,next]]);
 store.db.close();
});
