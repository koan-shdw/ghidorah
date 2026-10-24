import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';
import {Store} from '../app/store';import {Sidebar} from '../app/sidebar';import {chatToolCall} from '../app/chat-coordination';
import {handoverRequest,handoverStart,pushText,seriesBefore,seriesTitles,unpushed} from '../app/handover';import {checkHandover} from '../app/handover-check';
import type {Chat,Project,Turn} from '../app/types';

function fixture(t:any){const store=new Store(':memory:');t.after(()=>store.db.close());return {store,sidebar:new Sidebar(store)};}
const done=(store:Store,chatId:string,prompt:string,text:string,extra:Partial<Turn>={})=>{const turn=store.accept(crypto.randomUUID(),chatId,prompt,'claude-code:opus',extra.handoff?{handoff:extra.handoff}:undefined);return store.update<Turn>('turn',turn.id,{status:'completed',text,...extra});};

test('series numbering: an unnumbered chat becomes 1 and the next 2; a numbered one counts on',()=>{
 assert.deepEqual(seriesTitles('Ghidorah updates'),{old:'Ghidorah updates 1',next:'Ghidorah updates 2'});
 assert.deepEqual(seriesTitles('Ghidorah updates 3'),{old:'Ghidorah updates 3',next:'Ghidorah updates 4'});
 assert.deepEqual(seriesTitles(' Plan 9 '),{old:'Plan 9',next:'Plan 10'});
 assert.match(handoverRequest('keep it short'),/depoison[\s\S]*From the user: keep it short$/);
 assert.match(handoverStart('A 1','## Goal\nShip it'),/continues "A 1"[\s\S]*## Goal\nShip it$/);
});

test('the handover fork copies every setting and the goal, none of the messages, and gets its own project',t=>{
 const {store,sidebar}=fixture(t),project=store.project('C:/work');store.update<Project>('project',project.id,{mode:'auto',worktree:'C:/work-tree'});
 const old=store.chat(project.id);
 store.update<Chat>('chat',old.id,{title:'Updates',pool:['claude-code:opus','deepseek-flash'],model:'claude-code:opus',effort:'high',efforts:{'claude-code:opus':'xhigh'},autoCompact:true,rlm:true,wakeUps:true,screenApps:['notepad'],groupId:null,lockedModel:'claude-code:opus',runtimeId:'live',storedId:'stored',pinned:true,compressed:true,handover:{stage:'writing'},contextNotice:'Context compacted.'});
 done(store,old.id,'Build it','Built.');
 store.put('goal',{id:old.id,key:'k',runId:'r',objective:'Ship handover mode',models:[],status:'active',tokenBudget:null,tokens:5,usageIncomplete:false,accounted:[],turns:2,cursor:null,summary:'',evidence:'',created:1,updated:1});
 const id=sidebar.fork(old.id,{handover:true}),fresh=store.get<Chat>('chat',id),source=store.get<Chat>('chat',old.id);
 for(const key of ['pool','model','effort','efforts','autoCompact','rlm','wakeUps','screenApps','groupId','lockedModel'] as const)assert.deepEqual(fresh[key],source[key],key);
 assert.equal(store.all<Turn>('turn').filter(turn=>turn.chatId===id).length,0);
 assert.equal(fresh.runtimeId,null);assert.equal(fresh.storedId,null);assert.equal(fresh.handover,undefined);assert.equal(fresh.compressed,false);assert.equal(fresh.contextNotice,undefined);assert.equal(fresh.context,undefined);
 const next=store.get<Project>('project',fresh.projectId);assert.notEqual(next.id,project.id);assert.equal(next.folder,'C:/work');assert.equal(next.mode,'auto');assert.equal(next.worktree,'C:/work-tree');
 assert.equal(store.all<any>('goal').find(goal=>goal.id===id)?.status,'paused');
 // An ordinary fork never carries a handover along.
 assert.equal(store.get<Chat>('chat',sidebar.fork(old.id)).handover,undefined);
});

test('pushes carry only what is new, stop at unfinished work, and leave out what came from the other chat',t=>{
 const {store}=fixture(t),chat=store.chat(store.project().id);
 const first=done(store,chat.id,'Handover text','I restate the goal.',{handoff:{id:'h',sourceChatId:'old',sourceTurnId:'x',title:'Old 1',push:true}});
 store.put('tool',{id:'tool-1',turnId:first.id,name:'read_file',args:{path:'app/ui.tsx'},result:null,status:'completed'});
 const second=done(store,chat.id,'Now plan the tests','Plan: one unit test.');
 const running=store.accept(crypto.randomUUID(),chat.id,'And the e2e?');store.update<Turn>('turn',running.id,{status:'running'});
 const turns=()=>store.all<Turn>('turn');
 assert.deepEqual(unpushed(turns(),chat.id,null).map(turn=>turn.id),[first.id,second.id]);
 assert.deepEqual(unpushed(turns(),chat.id,first.id).map(turn=>turn.id),[second.id]);
 assert.deepEqual(unpushed(turns(),chat.id,null,first.id).map(turn=>turn.id),[first.id]);
 assert.deepEqual(unpushed(turns(),chat.id,second.id),[]);
 const text=pushText(store,unpushed(turns(),chat.id,null),'New 2',true);
 assert.match(text,/^Update from the new chat "New 2"/);
 assert.doesNotMatch(text,/Handover text/);
 assert.match(text,/\*\*Actions:\*\*\n- read_file app\/ui\.tsx/);
 assert.match(text,/\*\*Reply:\*\* I restate the goal\.[\s\S]*\*\*User:\*\* Now plan the tests[\s\S]*\*\*Reply:\*\* Plan: one unit test\./);
 assert.match(pushText(store,[second],'Old 1',false),/^Comments from the old chat "Old 1"/);
});

test('decision 9: a chat never reads or finds the chats before it in its series, even with approval',async t=>{
 const {store}=fixture(t),first=store.chat(store.project().id),second=store.chat(store.project().id),third=store.chat(store.project().id),other=store.chat(store.project().id);
 store.update<Chat>('chat',first.id,{title:'Work 1'});store.update<Chat>('chat',second.id,{title:'Work 2',handoverFrom:first.id});store.update<Chat>('chat',third.id,{title:'Work 3',handoverFrom:second.id});store.update<Chat>('chat',other.id,{title:'Work notes'});
 for(const chat of [first,second,other])done(store,chat.id,'Work','Work done.');
 assert.deepEqual([...seriesBefore(store,third.id)].sort(),[first.id,second.id].sort());
 const current=store.accept(crypto.randomUUID(),third.id,'Look back'),approvals:string[]=[];
 const access={approve:async(text:string)=>{approvals.push(text);return true;},mode:()=>'bypass',submit:async()=>{}};
 const call=(name:string,args:any)=>chatToolCall(store,current,name,args,access,new AbortController().signal);
 await assert.rejects(call('read_other_chat',{chatId:first.id}),/handover is its only context/);
 await assert.rejects(call('read_other_chat',{chatId:second.id}),/handover is its only context/);
 assert.equal(approvals.length,0);
 const found=await call('search_chats',{query:'Work'}) as any;
 assert.deepEqual(found.chats.map((row:any)=>row.chatId),[other.id]);
 assert.equal((await call('read_other_chat',{chatId:other.id}) as any).chatId,other.id);
});

test('the check lists missing files, missing names and unmarked claims, and never the sections that are his',async t=>{
 const folder=fs.mkdtempSync(path.join(path.resolve('work'),'handover-check-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 fs.mkdirSync(path.join(folder,'app'));fs.writeFileSync(path.join(folder,'app','sidebar.ts'),'export function fork(){}\n');
 execFileSync('git',['init','-q'],{cwd:folder});
 const text=['## Goal','- Ship handover mode','## How it works','- `app/sidebar.ts:59` has `sidebar.fork()` (PROVEN, read)','- `app/missing.ts` holds `noSuchThing` (OPEN)','- The pool copies as is','## Open questions','- Where does the button go?'].join('\n');
 const result=await checkHandover(text,folder);
 assert.deepEqual(result.missingPaths,['app/missing.ts']);
 assert.equal(result.namesChecked,true);assert.deepEqual(result.missingNames,['noSuchThing']);
 assert.deepEqual(result.unmarked,['The pool copies as is']);
});
