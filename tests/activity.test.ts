import test from 'node:test';
import assert from 'node:assert/strict';
import {activeAgents,chatActivity,taskItems} from '../app/activity';

test('active agents are the chat\'s agents still at work, with what a pill needs and nothing from tool rows',()=>{
 const agent=(id:string,status:string,created:number,extra:any={})=>({id,chatId:'main',model:'claude-code:haiku',status,created,activity:'Waiting for model',automatic:{kind:'agent',originTurnId:'t1',taskId:'task-'+id,runtimeId:'run',description:'Task '+id,agentType:'general-purpose',...extra.automatic},...extra.turn});
 const state:any={chats:[{id:'main'},{id:'other'}],jobChats:[{id:'child',parentChatId:'main'}],approvals:[{id:'ask',turnId:'b',chatId:'main',status:'pending'},{id:'old',turnId:'a',chatId:'main',status:'approved'}],
  turns:[{id:'t1',chatId:'main',model:'m1',status:'running',created:1},agent('b','waiting',30),agent('a','running',20,{automatic:{resolvedModel:'claude-haiku-4-5'}}),agent('done','completed',10),agent('failed','failed',11),agent('stopped','stopped',12),
   agent('elsewhere','running',40,{turn:{chatId:'other'}}),agent('child','running',50,{turn:{chatId:'child'},automatic:{description:'',agentType:'reviewer'}}),agent('bare','running',60,{automatic:{description:'',agentType:''},turn:{activity:undefined}})],
  background:[{id:'run:task-a',engine:'claude',chatId:'main',processId:'task-a',generation:'run',status:'running'},{id:'run:task-b',engine:'claude',chatId:'main',processId:'task-b',generation:'run',status:'stopping'},
   {id:'run:task-child',engine:'claude',chatId:'child',processId:'task-child',generation:'run',status:'exited'},{id:'old:task-bare',engine:'claude',chatId:'main',processId:'task-bare',generation:'old',status:'running'}]};
 const rows=activeAgents(state,'main');
 assert.deepEqual(rows.map(row=>row.id),['a','b','child','bare'],'running and waiting only, oldest first, with the chat\'s side jobs and without other chats');
 assert.deepEqual(rows[0],{id:'a',name:'Task a',type:'general-purpose',model:'claude-haiku-4-5',step:'Waiting for model',since:20,status:'running',stopId:'run:task-a'});
 assert.deepEqual(rows[1],{id:'b',name:'Task b',type:'general-purpose',model:'claude-code:haiku',step:'Waiting for model',since:30,status:'waiting',approvalId:'ask',stopId:'run:task-b',stopping:true});
 assert.deepEqual(rows[2],{id:'child',name:'reviewer',type:'reviewer',model:'claude-code:haiku',step:'Waiting for model',since:50,status:'running'},'an ended background row is nothing to stop');
 assert.deepEqual(rows[3],{id:'bare',name:'Agent',type:'',model:'claude-code:haiku',step:'',since:60,status:'running'},'a row from another runtime is not this agent\'s');
 assert.deepEqual(activeAgents({...state,background:undefined},'main').map(row=>row.stopId),[undefined,undefined,undefined,undefined]);
 assert.deepEqual(activeAgents(state,'other').map(row=>row.id),['elsewhere']);
});

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
