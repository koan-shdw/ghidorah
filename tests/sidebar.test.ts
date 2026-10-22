import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {Sidebar,chatUnread} from '../app/sidebar';
import {createParallel,settleParallel} from '../app/parallel';
import {handover} from '../app/history';
import type {Chat,Turn,Project} from '../app/types';

test('message retry branches before the selected turn, keeps its attachment draft and records later effects without replay',()=>{
 const store=new Store(':memory:'),sidebar=new Sidebar(store),source=store.chat(store.project('C:/Work').id);
 store.update<Chat>('chat',source.id,{pool:['claude-code:haiku','deepseek-flash']});
 const first=store.accept('first',source.id,'Earlier decision');store.update<Turn>('turn',first.id,{status:'completed',text:'Keep the blue buttons'});
 const attachment={id:crypto.randomUUID(),chatId:source.id,name:'brief.txt',kind:'file' as const,size:1,sha256:'source',contentHash:'prepared'};
 store.update<Chat>('chat',source.id,{attachments:[attachment]});
 const target=store.accept('target',source.id,'Change the app','claude-code:haiku');store.update<Turn>('turn',target.id,{status:'completed',text:'Discarded answer',effort:'low'});
 store.put('tool',{id:'write',turnId:target.id,name:'Write',args:{file_path:'C:/Work/app.js'},result:'Already written',status:'completed'});
 const later=store.accept('later',source.id,'Later prompt');store.update<Turn>('turn',later.id,{status:'completed',text:'Later answer'});
 store.put('tool',{id:'publish',turnId:later.id,name:'publish',args:{},result:'Already published',status:'completed'});
 store.update<Chat>('chat',source.id,{draft:'Keep my unsent text'});store.put('approval',{id:'approved-write',turnId:target.id,chatId:source.id,status:'approved'});
 const sourceBefore=JSON.stringify(store.get('chat',source.id)),turnsBefore=JSON.stringify(store.all('turn'));
 const id=sidebar.fork(source.id,{beforeTurnId:target.id}),branch=store.get<Chat>('chat',id);
 assert.equal(branch.draft,target.prompt);assert.equal(branch.branchTurnId,target.id);assert.equal(branch.attachments?.[0].chatId,id);assert.equal(branch.attachments?.[0].id,attachment.id);
 assert.deepEqual(branch.selectedModels,['claude-code:haiku']);assert.equal(branch.efforts?.['claude-code:haiku'],'low');
 assert.equal(branch.runtimeId,null);assert.equal(store.enginePosition(id,'claude').sessionId,null);assert.equal(store.all('approval').length,1);
 assert.deepEqual(store.snapshot().turns.filter(t=>t.chatId===id).map(t=>t.prompt),['Earlier decision']);
 assert.equal(JSON.stringify(store.get('chat',source.id)),sourceBefore);assert.equal(JSON.stringify(store.all<Turn>('turn').filter(t=>t.chatId===source.id)),turnsBefore);
 const next=store.accept('edited',id,'Explain the current app without changing files','claude-code:haiku'),context=handover(store.all('turn'),store.all('tool'),next);
 assert.match(context.prompt,/Keep the blue buttons/);assert.match(context.prompt,/Already written/);assert.match(context.prompt,/Already published/);assert.match(context.prompt,/Files and external effects have not been reverted/);
 assert.doesNotMatch(context.prompt,/Discarded answer|Later prompt|Later answer/);assert.equal(context.attachments[0].chatId,id);
 store.update<Turn>('turn',next.id,{status:'completed'});sidebar.delete(source.id);assert.ok(handover(store.all('turn'),store.all('tool'),next).prompt.includes('Already published'));store.db.close();
});

test('retry keeps earlier parallel results and flattens later tool outcomes without orphaned jobs',()=>{
 const store=new Store(':memory:'),sidebar=new Sidebar(store),source=store.chat(store.project().id);
 const first=store.accept('first-group',source.id,'Earlier group'),a=createParallel(store,first,['deepseek-flash','claude-code:haiku']);
 for(const job of a)store.update<Turn>('turn',job.id,{status:'completed',text:'Earlier '+job.model});settleParallel(store);
 const target=store.accept('target-group',source.id,'Retry this group'),b=createParallel(store,target,['deepseek-flash','claude-code:haiku']);
 for(const job of b){store.update<Turn>('turn',job.id,{status:'completed',text:'Discarded parallel answer'});store.put('tool',{id:'tool-'+job.id,turnId:job.id,name:'Write',args:{},result:'Effect '+job.model,status:'completed'});}settleParallel(store);
 const id=sidebar.fork(source.id,{beforeTurnId:target.id});assert.equal(sidebar.owned(id).length,3);
 const visible=store.snapshot().turns.filter(t=>t.chatId===id);assert.equal(visible.length,1);assert.equal(visible[0].jobs?.length,2);
 const next=store.accept('next-group',id,'Review actual state'),context=handover(store.all('turn'),store.all('tool'),next);
 assert.match(context.prompt,/Earlier claude-code:haiku/);assert.match(context.prompt,/Effect claude-code:haiku/);assert.match(context.prompt,/Effect deepseek-flash/);assert.doesNotMatch(context.prompt,/Discarded parallel answer/);
 for(const chat of sidebar.owned(id).filter(c=>c.parentChatId))assert.ok(store.get<Turn>('turn',chat.groupTurnId!));store.db.close();
});

test('retry rejects active work, foreign messages and automatic updates without creating a partial branch',()=>{
 const store=new Store(':memory:'),sidebar=new Sidebar(store),source=store.chat(store.project().id),other=store.chat(source.projectId);
 const target=store.accept('busy',source.id,'Pending');assert.throws(()=>sidebar.fork(source.id,{beforeTurnId:target.id}),/Finish or stop/);
 store.update<Turn>('turn',target.id,{status:'completed'});const foreign=store.accept('foreign',other.id,'Other chat');store.update<Turn>('turn',foreign.id,{status:'completed'});
 assert.throws(()=>sidebar.fork(source.id,{beforeTurnId:foreign.id}),/ordinary message/);
 store.update<Turn>('turn',target.id,{automatic:{originTurnId:'origin',taskId:'task'}});assert.throws(()=>sidebar.fork(source.id,{beforeTurnId:target.id}),/ordinary message/);
 store.update<Turn>('turn',target.id,{automatic:undefined});store.update<Chat>('chat',source.id,{sideSourceId:other.id});assert.throws(()=>sidebar.fork(source.id,{beforeTurnId:target.id}),/Keep this side chat/);
 assert.equal(store.all('chat').length,2);store.db.close();
});

test('sidebar migrates legacy folders, preserves chats, orders groups and keeps read/archive state independent',()=>{
 const store=new Store(':memory:'),sidebar=new Sidebar(store),project=store.project(),a=store.chat(project.id),b=store.chat(project.id);
 store.update<Project>('project',project.id,{group:'Apps'});store.update<Chat>('chat',a.id,{created:undefined});store.update<Chat>('chat',b.id,{created:undefined});sidebar.initialize();sidebar.initialize();
 assert.equal(sidebar.groups().length,1);const group=sidebar.groups()[0];assert.equal(store.get<Chat>('chat',a.id).groupId,group.id);assert.notEqual(store.get<Chat>('chat',a.id).position,store.get<Chat>('chat',b.id).position);
 sidebar.chat('rename',{chatId:a.id,name:'My app'});sidebar.chat('pin',{chatId:a.id,pinned:true});sidebar.chat('move',{chatId:a.id,groupId:group.id});assert.equal(store.get<Chat>('chat',a.id).pinned,false);
 const other=sidebar.group('create',{name:'Other'})!;sidebar.group('move',{id:other.id,beforeId:group.id});assert.equal(sidebar.groups()[0].id,other.id);sidebar.group('rename',{id:group.id,name:'Builds'});sidebar.group('collapse',{id:group.id,collapsed:true});assert.equal(sidebar.groups()[1].collapsed,true);
 assert.throws(()=>sidebar.group('create',{name:'builds'}));assert.throws(()=>sidebar.chat('move',{chatId:a.id,groupId:'missing'}));assert.throws(()=>sidebar.settings({visibility:'hidden'}));
 const turn=store.accept('sidebar-turn',a.id,'Remember my history');assert.equal(chatUnread(store.get('chat',a.id),store.all('turn')),true);sidebar.chat('read',{chatId:a.id,unread:false});assert.equal(chatUnread(store.get('chat',a.id),store.all('turn')),false);store.update<Turn>('turn',turn.id,{status:'completed',text:'Saved answer'});assert.equal(chatUnread(store.get('chat',a.id),store.all('turn')),true);
 sidebar.chat('archive',{chatId:a.id,archived:true});assert.equal(store.get<Chat>('chat',a.id).archived,true);sidebar.chat('archive',{chatId:a.id,archived:false});sidebar.group('delete',{id:group.id});assert.equal(store.get<Chat>('chat',a.id).groupId,null);assert.equal(store.get<Turn>('turn',turn.id).text,'Saved answer');assert.equal(store.all('chat').length,2);store.db.close();
});

test('fork snapshots parallel history with fresh ownership and paused direction; deleting one branch preserves the other',()=>{
 const store=new Store(':memory:'),sidebar=new Sidebar(store),p=store.project(),chat=store.chat(p.id);
 const parent=store.accept('parallel-source',chat.id,'Build this');const jobs=createParallel(store,parent,['deepseek-flash','claude-code:haiku']);assert.throws(()=>sidebar.fork(chat.id));assert.throws(()=>sidebar.delete(chat.id));
 for(const job of jobs){store.update<Turn>('turn',job.id,{status:'completed',text:'Result '+job.model});store.put('tool',{id:'tool-'+job.id,turnId:job.id,name:'write_file',args:{path:job.model},result:'Written already',status:'completed'});}settleParallel(store);
 store.put('goal',{id:chat.id,key:'goal-source',runId:'run-source',objective:'Build an app',status:'complete',tokens:100,turns:1});store.put('engine',{id:chat.id+':claude',chatId:chat.id,sessionId:'source-private-session'});
 const fork=sidebar.fork(chat.id),cloned=store.all<Turn>('turn').find(t=>t.chatId===fork)!;assert.notEqual(cloned.id,parent.id);assert.equal(cloned.jobs?.length,2);assert.ok(cloned.jobs?.every(id=>!jobs.some(j=>j.id===id)));assert.equal(store.enginePosition(fork,'claude').sessionId,null);assert.equal(store.get<any>('goal',fork).status,'paused');
 const next=store.accept('fork-new-message',fork,'Continue');const context=handover(store.all('turn'),store.all('tool'),next);assert.match(context.prompt,/Written already/);assert.match(context.prompt,/Result claude-code:haiku/);assert.match(context.prompt,/not new actions to execute/);
 store.update<Turn>('turn',next.id,{status:'completed'});sidebar.delete(chat.id);assert.equal(store.snapshot().chats.length,1);assert.equal(store.snapshot().chats[0].id,fork);assert.ok(store.get<Turn>('turn',cloned.id));assert.throws(()=>store.get('goal',chat.id));assert.equal(store.all('engine').length,0);assert.equal(store.all('tool').length,2);assert.equal(store.get<any>('goal',fork).status,'paused');store.db.close();
});

test('side chat snapshots active thread context without copying execution, approvals, goals or memory ownership',()=>{
 const store=new Store(':memory:'),sidebar=new Sidebar(store),p=store.project('C:/shared'),source=store.chat(p.id),unrelated=store.chat(p.id);
 store.update<Project>('project',p.id,{mode:'plan'});store.update<Chat>('chat',source.id,{title:'App build',draft:'unsent source draft',pool:['deepseek-flash','claude-code:haiku'],selectedModels:['deepseek-flash'],runtimeId:'source-session'});
 const old=store.accept('source-history',source.id,'Remember copperfinch');store.update<Turn>('turn',old.id,{status:'completed',text:'Saved source answer',usage:{total_tokens:50}});
 const parent=store.accept('source-live',source.id,'Still building');const jobs=createParallel(store,parent,['deepseek-flash','claude-code:haiku']);
 store.update<Turn>('turn',jobs[0].id,{status:'completed',text:'Finished peer work'});store.update<Turn>('turn',jobs[1].id,{status:'waiting',text:'Waiting peer work'});
 store.put('tool',{id:'live-tool',turnId:jobs[1].id,name:'write_file',args:{path:'pending.txt'},result:null,status:'running'});
 store.put('approval',{id:'source-approval',chatId:jobs[1].chatId,turnId:jobs[1].id,method:'permission',params:{},status:'pending'});
 store.put('goal',{id:source.id,status:'active',objective:'Finish the source'});store.put('engine',{id:source.id+':hermes',chatId:source.id,sessionId:'private-source-session'});
 store.accept('unrelated-history',unrelated.id,'unrelated-secret-marker');
 store.update<Chat>('chat',source.id,{selectedModels:['deepseek-flash'],draft:'unsent source draft'});
 const sourceBefore=JSON.stringify(sidebar.owned(source.id).map(c=>store.get('chat',c.id))),turnsBefore=JSON.stringify(store.all<Turn>('turn').filter(t=>sidebar.owned(source.id).some(c=>c.id===t.chatId)));
 const sideId=sidebar.fork(source.id,{sideChat:true}),side=store.get<Chat>('chat',sideId),sideProject=store.get<Project>('project',side.projectId);
 assert.equal(side.sideSourceId,source.id);assert.equal(side.draft,'');assert.deepEqual(side.selectedModels,['deepseek-flash']);assert.notEqual(side.projectId,source.projectId);assert.notEqual(sideProject.profile,p.profile);assert.equal(sideProject.folder,p.folder);assert.equal(sideProject.mode,'plan');assert.equal(side.runtimeId,null);
 assert.throws(()=>store.get('goal',sideId));assert.equal(store.enginePosition(sideId,'hermes').sessionId,null);assert.equal(store.all('approval').length,1);
 const owned=new Set(sidebar.owned(sideId).map(c=>c.id)),snapshots=store.all<Turn>('turn').filter(t=>owned.has(t.chatId));assert.equal(snapshots.length,4);assert.ok(snapshots.every(t=>t.status==='context'&&t.contextSnapshot&&t.usage===null));
 assert.ok(store.snapshot().turns.every(t=>!owned.has(t.chatId)));assert.equal(store.snapshot().tools.length,1);
 const question=store.accept('side-question',sideId,'What remains?');const context=handover(store.all('turn'),store.all('tool'),question);
 assert.match(context.prompt,/copperfinch/);assert.match(context.prompt,/Finished peer work/);assert.match(context.prompt,/Waiting peer work/);assert.match(context.prompt,/"status":"waiting"/);assert.match(context.prompt,/not new actions to execute/);assert.doesNotMatch(context.prompt,/unrelated-secret-marker/);
 assert.equal(JSON.stringify(sidebar.owned(source.id).map(c=>store.get('chat',c.id))),sourceBefore);assert.equal(JSON.stringify(store.all<Turn>('turn').filter(t=>sidebar.owned(source.id).some(c=>c.id===t.chatId))),turnsBefore);
 store.update<Turn>('turn',question.id,{status:'completed',text:'Private side reply'});assert.equal(store.snapshot().turns.filter(t=>t.chatId===sideId).length,1);
 assert.throws(()=>sidebar.delete(source.id));sidebar.delete(sideId);assert.equal(store.all('approval').length,1);assert.equal(store.get<Turn>('turn',jobs[1].id).status,'waiting');assert.equal(store.get<any>('goal',source.id).status,'active');assert.equal(store.get<Turn>('turn',old.id).text,'Saved source answer');assert.throws(()=>store.get('turn',question.id));store.db.close();
});

test('side context attachment ownership and source snapshot remain independent of later source changes',()=>{
 const store=new Store(':memory:'),sidebar=new Sidebar(store),p=store.project(),source=store.chat(p.id);
 const attachment={id:'11111111-1111-1111-1111-111111111111',chatId:source.id,name:'reference.png',kind:'image' as const,size:1,sha256:'source-hash',contentHash:'prepared-hash'};
 store.update<Chat>('chat',source.id,{attachments:[attachment]});const original=store.accept('image-turn',source.id,'Image context');store.update<Turn>('turn',original.id,{status:'running',text:'Initial partial answer'});
 const sideId=sidebar.fork(source.id,{sideChat:true});store.update<Turn>('turn',original.id,{status:'completed',text:'Later source answer'});store.accept('later-source',source.id,'Later source message');
 const question=store.accept('side-image-question',sideId,'Explain the image'),context=handover(store.all('turn'),store.all('tool'),question);
 assert.equal(context.attachments.length,1);assert.equal(context.attachments[0].chatId,sideId);assert.equal(context.attachments[0].id,attachment.id);assert.equal(store.get<Turn>('turn',original.id).attachments![0].chatId,source.id);
 assert.match(context.prompt,/Initial partial answer/);assert.doesNotMatch(context.prompt,/Later source answer|Later source message/);
 store.update<Turn>('turn',question.id,{status:'completed'});const continuation=store.accept('side-followup',sideId,'Continue');const delta=handover(store.all('turn'),store.all('tool'),continuation,{id:sideId+':hermes',chatId:sideId,engine:'hermes',sessionId:'side-private-session',throughTurnId:question.id,uncertain:false});assert.match(delta.prompt,/Current user message:\nContinue$/);assert.doesNotMatch(delta.prompt,/Image context|Initial partial answer/);assert.equal(delta.attachments.length,0);store.db.close();
});
