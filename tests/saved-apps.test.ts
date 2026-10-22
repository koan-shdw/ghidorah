import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {saveApp,removeApp,appTurnOwners,appFolderName,appTodo,updateAppTodo,linkAppChat,appChatContext,changeAppGroup} from '../app/saved-apps';
import {handover} from '../app/history';
test('app folders preserve app data, reject invalid moves and ungroup apps when removed',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),first=saveApp(store,{name:'Core',chatIds:[chat.id],ideas:'Keep this',repositories:['I:/DEV/Core']}),second=saveApp(store,{name:'Experiment'});
 appTodo(store,{app:first.id,title:'Keep this task'});
 const group=changeAppGroup(store,{action:'create',name:'Extras',appId:second.id}) as any;
 assert.equal(store.get<any>('saved-app',first.id).groupId,null);assert.equal(store.get<any>('saved-app',second.id).groupId,group.id);
 changeAppGroup(store,{action:'move',appId:first.id,groupId:group.id});saveApp(store,{id:first.id,stage:'Beta'});linkAppChat(store,first.id,chat.id,false);
 assert.equal(store.get<any>('saved-app',first.id).groupId,group.id,'Ordinary app saves and linking retain the folder');
 assert.throws(()=>changeAppGroup(store,{action:'create',name:' extras '}),/already/);
 assert.throws(()=>changeAppGroup(store,{action:'create',name:'Broken',appId:'missing'}));assert.equal(store.all('saved-app-group').length,1);
 assert.throws(()=>changeAppGroup(store,{action:'move',appId:first.id,groupId:'missing'}));assert.throws(()=>saveApp(store,{id:first.id,groupId:'missing'}));
 assert.throws(()=>changeAppGroup(store,{action:'collapse',id:group.id,collapsed:'true'}));
 changeAppGroup(store,{action:'collapse',id:group.id,collapsed:true});changeAppGroup(store,{action:'rename',id:group.id,name:'Later'});assert.deepEqual(store.get('saved-app-group',group.id),{id:group.id,name:'Later',collapsed:true});
 changeAppGroup(store,{action:'remove',id:group.id});assert.equal(store.all('saved-app-group').length,0);assert.ok(store.all<any>('saved-app').every(app=>app.groupId===null));assert.equal(store.get<any>('saved-app',first.id).ideas,'Keep this');assert.equal(store.all('app-todo').length,1);assert.ok(store.get('chat',chat.id));store.db.close();
});
test('saved apps link chats across folders, preserve chat data and validate edits',()=>{
 const store=new Store(':memory:'),p=store.project(),a=store.chat(p.id),b=store.chat(p.id);
 const input={name:'Studio',icon:'',stage:'Building',current:'Menus',ideas:'Timeline',planned:'Publish',questions:'Which host?',repositories:['studio'],chatIds:[a.id,b.id,a.id]};
 const app=saveApp(store,input);assert.deepEqual(app.chatIds,[a.id,b.id]);assert.equal(store.all('saved-app').length,1);
 saveApp(store,{...app,ideas:'Live preview'});assert.equal(store.get<any>('saved-app',app.id).ideas,'Live preview');
 assert.throws(()=>saveApp(store,{...input,chatIds:['missing']}));assert.throws(()=>saveApp(store,{...input,icon:'https://example.com/logo.png'}));assert.throws(()=>saveApp(store,{...input,id:'missing'}));
 removeApp(store,app.id);assert.equal(store.all('saved-app').length,0);assert.equal(store.all('chat').length,2);store.db.close();
});

test('app reports include nested jobs without mixing unrelated chats',()=>{
 const turns=[{id:'parent',chatId:'linked'},{id:'child',chatId:'job',parentTurnId:'parent'},{id:'nested',chatId:'job2',parentTurnId:'child'},{id:'other',chatId:'elsewhere'}] as any;
 const owners=appTurnOwners(['linked'],turns.reverse());assert.equal(owners.get('nested'),'linked');assert.equal(owners.has('other'),false);
});
test('a new app gets a safe folder name close to its name',()=>{
 assert.equal(appFolderName('Plush Shop'),'Plush-Shop');
 assert.equal(appFolderName('  ../KOAN: live?  '),'KOAN-live');
 assert.equal(appFolderName('ダバン'),'ダバン');
 assert.equal(appFolderName('con'),'');assert.equal(appFolderName('nul.txt'),'');assert.equal(appFolderName('...'),'');
});

test('to-do updates target one existing task and preserve linked work',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),a=saveApp(store,{name:'One'}),b=saveApp(store,{name:'Two'});
 const first=appTodo(store,{app:a.id,title:'Original'})!,other=appTodo(store,{app:a.id,title:'Keep'})!;
 store.update<import('../app/saved-apps').AppTodo>('app-todo',first.id,{chatId:chat.id});
 assert.throws(()=>updateAppTodo(store,{app:a.id,title:'No ID'}));
 assert.throws(()=>updateAppTodo(store,{app:a.id,id:'missing',title:'No creation'}));
 assert.throws(()=>updateAppTodo(store,{app:b.id,id:first.id,remove:true}));
 assert.throws(()=>updateAppTodo(store,{app:a.id,id:first.id,remove:'false'}));
 const updated=updateAppTodo(store,{app:a.id,id:first.id,title:'Revised',done:true});assert.equal((updated as any).chatId,chat.id);
 updateAppTodo(store,{app:a.id,id:first.id,done:false});assert.equal(store.get<any>('app-todo',first.id).done,false);
 assert.deepEqual(updateAppTodo(store,{app:a.id,id:first.id,remove:true}),{id:first.id,removed:true});
 assert.equal(store.get<any>('app-todo',other.id).title,'Keep');assert.ok(store.get('chat',chat.id));store.db.close();
});

test('app links preserve metadata, deduplicate and resolve child chats to the parent',()=>{
 const store=new Store(':memory:'),project=store.project(),a=store.chat(project.id),b=store.chat(project.id),child=store.chat(project.id);
 store.update<import('../app/types').Chat>('chat',child.id,{parentChatId:a.id});
 const first=saveApp(store,{name:'Video Dancer',stage:'Beta',ideas:'Keep',repositories:['vi-dancer']}),second=saveApp(store,{name:'Sprite Dancer'});
 linkAppChat(store,first.id,child.id,true);linkAppChat(store,first.id,a.id,true);linkAppChat(store,first.id,b.id,true);linkAppChat(store,second.id,a.id,true);
 let saved=store.get<any>('saved-app',first.id);assert.deepEqual(saved.chatIds,[a.id,b.id]);assert.equal(saved.ideas,'Keep');assert.deepEqual(saved.repositories,['vi-dancer']);
 linkAppChat(store,first.id,child.id,false);assert.deepEqual(store.get<any>('saved-app',first.id).chatIds,[b.id]);assert.deepEqual(store.get<any>('saved-app',second.id).chatIds,[a.id]);
 const title='Use PDMD https://pdmd2026.github.io/';store.transaction(()=>{const todo=appTodo(store,{app:first.id,title})!;linkAppChat(store,todo.appId,a.id,true);});assert.equal(appTodo(store,{app:first.id,title})!.chatId,undefined);assert.equal(store.all('app-todo').length,1);
 assert.throws(()=>store.transaction(()=>{const todo=appTodo(store,{app:first.id,title:'Rollback'})!;linkAppChat(store,todo.appId,'missing',true);}));assert.equal(store.all('app-todo').length,1);
 assert.throws(()=>linkAppChat(store,'missing',a.id,true));assert.throws(()=>linkAppChat(store,first.id,a.id,'true' as any));store.db.close();
});

test('initial app context supports relevance decisions and respects manual unlinking',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),app=saveApp(store,{name:'Video Dancer',current:'Video editing'});
 const context=appChatContext(store,chat);assert.match(context,/At the start/);assert.match(context,/Video Dancer/);assert.match(context,/Video editing/);
 linkAppChat(store,app.id,chat.id,true,'model');assert.match(appChatContext(store,chat),/"linked":true/);
 linkAppChat(store,app.id,chat.id,false);linkAppChat(store,app.id,chat.id,true,'model');assert.match(appChatContext(store,chat),/"userUnlinked":true/);assert.deepEqual(store.get<any>('saved-app',app.id).chatIds,[]);
 linkAppChat(store,app.id,chat.id,true);assert.match(appChatContext(store,chat),/"linked":true,"userUnlinked":false/);store.db.close();
});

test('only linked development apps advertise map retrieval without injecting full indexes',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),app=saveApp(store,{name:'Mapped',repositories:['I:/DEV/mapped']});
 assert.doesNotMatch(appChatContext(store,chat),/repoMap/);
 linkAppChat(store,app.id,chat.id,true);
 const context=appChatContext(store,chat);assert.match(context,/repoMap/);assert.match(context,/\.repo-map\/index.txt/);assert.match(context,/Map of the last commit/);
 const turn=store.accept('map-context',chat.id,'Find the feature entry point');
 const prompt=handover(store.all('turn'),[],turn,undefined,undefined,'',context).prompt;
 assert.match(prompt,/\.repo-map\/index.txt/);assert.match(prompt,/continue with source search/);
 assert.ok(context.length<2000,'App orientation should advertise retrieval without loading source into the prompt');
 linkAppChat(store,app.id,chat.id,false);assert.doesNotMatch(appChatContext(store,chat),/repoMap/);store.db.close();
});
