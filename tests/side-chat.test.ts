// Side chat, Send to main chat (Koan 2026-11-15): what the summary is written from and where it lands.
import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../app/store';import {Sidebar} from '../app/sidebar';
import {pushText,turnsText} from '../app/handover';import {sideChatDraft,sideChatNew} from '../app/side-chat';
import type {Turn} from '../app/types';

function fixture(t:any){const store=new Store(':memory:');t.after(()=>store.db.close());return {store,sidebar:new Sidebar(store)};}
const done=(store:Store,chatId:string,prompt:string,text:string)=>{const turn=store.accept(crypto.randomUUID(),chatId,prompt,'deepseek-flash');return store.update<Turn>('turn',turn.id,{status:'completed',text});};

test('Send to main chat carries only what the side chat did itself, and only what has finished',t=>{
 const {store,sidebar}=fixture(t),project=store.project('C:/work'),main=store.chat(project.id);
 done(store,main.id,'Remember copperfinch','Noted.');
 const side=sidebar.fork(main.id,{sideChat:true});
 assert.ok(store.all<Turn>('turn').some(turn=>turn.chatId===side),'the thread is copied into the side chat');
 assert.deepEqual(sideChatNew(store.all<Turn>('turn'),side),[],'the copied thread is not the side chat\'s own');
 const first=done(store,side,'What was the word?','Copperfinch.'),running=store.accept(crypto.randomUUID(),side,'And again?','deepseek-flash');
 store.update<Turn>('turn',running.id,{status:'running'});
 const fresh=sideChatNew(store.all<Turn>('turn'),side);assert.deepEqual(fresh.map(turn=>turn.id),[first.id]);
 assert.equal(turnsText(store,fresh),'**User:** What was the word?\n\n**Reply:** Copperfinch.');
 // A handover push reads the same text, under its own first line.
 assert.ok(pushText(store,fresh,'Side',true).endsWith('\n\n**User:** What was the word?\n\n**Reply:** Copperfinch.'));
});

test('the summary goes after his unsent words in the main chat\'s message box',()=>{
 assert.equal(sideChatDraft('','  It was copperfinch. \n'),'From the side chat:\nIt was copperfinch.');
 assert.equal(sideChatDraft('half a thought','It was copperfinch.'),'half a thought\n\nFrom the side chat:\nIt was copperfinch.');
 assert.equal(sideChatDraft('  \n','x'),'From the side chat:\nx');
});
