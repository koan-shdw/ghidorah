import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newsText,workspaceNews} from '../app/workspace-news';

// The dot on the title bar's Workspace switch: what happened in the chat after its panel was last open.
const state=(tools:any[],turns:any[]=[]):any=>({chats:[{id:'c',pool:[]},{id:'other',pool:[]}],jobChats:[],turns:[{id:'t1',chatId:'c',status:'completed'},{id:'o1',chatId:'other',status:'completed'},...turns],tools});
const tool=(id:string,name:string,args:any,finished:number,turnId='t1',status='completed')=>({id,turnId,name,args,result:null,status,finished});

test('files a reply wrote, outputs it saved and agents that ended after the panel was last open are news',()=>{
 const tools=[
  tool('1','Edit',{file_path:'app/a.ts'},2000),tool('2','Write',{file_path:'app/a.ts'},2100),tool('3','mcp__hermes__write_file',{path:'notes.md'},2200),tool('4','patch',{},2300),
  tool('5','Read',{file_path:'app/b.ts'},2400),tool('6','mcp__ghidorah__save_chat_output',{path:'out.pdf'},2500),
  tool('7','Edit',{file_path:'app/old.ts'},900),tool('8','Edit',{file_path:'app/running.ts'},2600,'t1','running'),tool('9','Edit',{file_path:'elsewhere.ts'},2700,'o1'),
 ];
 const turns=[
  {id:'a1',chatId:'c',status:'completed',finished:2500,automatic:{kind:'agent',originTurnId:'t1',taskId:'x'}},
  {id:'a2',chatId:'c',status:'failed',finished:2600,automatic:{kind:'agent',originTurnId:'t1',taskId:'y'}},
  {id:'a3',chatId:'c',status:'running',automatic:{kind:'agent',originTurnId:'t1',taskId:'z'}},
  {id:'a4',chatId:'c',status:'completed',finished:500,automatic:{kind:'agent',originTurnId:'t1',taskId:'w'}},
 ];
 // a.ts counts once though two tools wrote it; the patch names no file and counts as one; reads, old rows, rows still
 // running and another chat's rows count nothing.
 assert.deepEqual(workspaceNews(state(tools,turns),'c',1000),{files:3,outputs:1,agents:2});
 assert.equal(newsText(workspaceNews(state(tools,turns),'c',1000)),'3 files changed · 1 output saved · 2 agents finished');
});

test('nothing after the panel was last open is no news, and one of a kind reads in the singular',()=>{
 assert.deepEqual(workspaceNews(state([tool('1','Edit',{file_path:'a.ts'},2000)]),'c',3000),{files:0,outputs:0,agents:0});
 assert.equal(newsText({files:0,outputs:0,agents:0}),'');
 assert.equal(newsText({files:1,outputs:0,agents:1}),'1 file changed · 1 agent finished');
});
