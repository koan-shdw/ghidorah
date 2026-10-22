import test from 'node:test';
import assert from 'node:assert/strict';
import {chatActivity,taskItems} from '../app/activity';

test('activity keeps owner scopes, completed task snapshots, explicit clears and plan approvals',()=>{
 const state:any={chats:[{id:'main'},{id:'other'}],jobChats:[{id:'child',parentChatId:'main'}],turns:[{id:'t1',chatId:'main',model:'m1'},{id:'t2',chatId:'child',model:'m2'},{id:'t3',chatId:'other',model:'m3'},{id:'agent',chatId:'main',model:'m4',automatic:{kind:'agent'}}],approvals:[{id:'p1',chatId:'main',turnId:'t1',params:{plan:'Owned plan'},status:'pending'},{id:'p2',chatId:'other',turnId:'t3',params:{plan:'Foreign plan'},status:'pending'}],tools:[
  {turnId:'t1',name:'todo',status:'completed',result:{todos:[{id:'one',content:'First',status:'pending'}]}},
  {turnId:'t2',name:'TodoWrite',status:'completed',args:JSON.stringify({todos:[{content:'Second',status:'in_progress'}]})},
  {turnId:'t3',name:'todo',status:'completed',result:{todos:[{content:'Foreign',status:'pending'}]}},
  {turnId:'t1',name:'todo',status:'failed',result:{todos:[]}},
  {turnId:'t2',name:'TodoWrite',status:'running',args:{todos:[]}},
  {turnId:'agent',name:'todo_list',status:'completed',result:JSON.stringify({todos:[{content:'Agent task',status:'completed'}]})},
 ]};
 const view=chatActivity(state,'main');assert.deepEqual(view.plans.map(row=>row.approval.id),['p1']);assert.deepEqual(view.tasks.map(row=>[row.owner,row.items[0].content]),[['main','First'],['child','Second'],['agent','Agent task']]);assert.equal(view.agents.length,1);
 state.tools.push({turnId:'t1',name:'todo',status:'completed',result:{todos:[]}});assert.deepEqual(chatActivity(state,'main').tasks[0].items,[]);
 assert.equal(taskItems([{content:'Bad status',status:'invented'}]),null);assert.equal(taskItems([{content:'x'.repeat(20001),status:'pending'}]),null);assert.equal(taskItems(new Array(1001).fill({content:'x',status:'pending'})),null);
});
