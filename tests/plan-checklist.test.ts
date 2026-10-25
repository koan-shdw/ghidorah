import test from 'node:test';import assert from 'node:assert/strict';
import {planSteps,foldText} from '../app/plan-checklist';import {chatActivity} from '../app/activity';
import type {ToolCall} from '../app/types';

let n=0;const tool=(name:string,args:any,result:any=null,status='completed'):ToolCall=>({id:'t'+(++n),turnId:'turn',name,args,result,status});

test('a whole list per call: the reply shows its latest TodoWrite or Hermes todo list',()=>{
 const first=tool('TodoWrite',{todos:[{content:'Read the code',status:'in_progress'},{content:'Write the fix',status:'pending'}]});
 const second=tool('TodoWrite',{todos:[{content:'Read the code',status:'completed'},{content:'Write the fix',status:'in_progress'}]});
 assert.deepEqual(planSteps([first,second])!.map(step=>step.status),['completed','in_progress']);
 const hermes=tool('todo',{todos:[]},JSON.stringify({todos:[{id:'1',content:'Run the tests',status:'cancelled'},{id:'2',content:'Notes',status:'completed'}]}));
 assert.deepEqual(planSteps([hermes])!.map(step=>step.content),['Run the tests','Notes']);
 assert.equal(planSteps([tool('Read',{file_path:'a.ts'})]),null,'no task list, no checklist');
 assert.equal(planSteps([tool('TodoWrite',{todos:[{content:'x',status:'pending'}]},null,'running')]),null,'only finished calls count');
});

test('Claude Code task tools are replayed across the chat, with deletes, list resets and the "doing" words',()=>{
 const earlier=[
  tool('TaskCreate',{subject:'Read the code',activeForm:'Reading the code'},{task:{id:'1',subject:'Read the code'}}),
  tool('TaskCreate',{subject:'Write the fix'},{content:[{type:'text',text:JSON.stringify({task:{id:'2',subject:'Write the fix'}})}]}),
  tool('TaskCreate',{subject:'Dropped idea'},{task:{id:'3',subject:'Dropped idea'}}),
  tool('TaskUpdate',{taskId:'1',status:'completed'},{success:true,taskId:'1'})];
 const now=[tool('TaskUpdate',{taskId:'3',status:'deleted'},{success:true,taskId:'3'}),tool('TaskUpdate',{taskId:'2',status:'in_progress',activeForm:'Writing the fix'},{success:true,taskId:'2'}),tool('TaskUpdate',{taskId:'9',status:'completed'},{success:false,error:'No task'})];
 const steps=planSteps(now,()=>earlier)!;
 assert.deepEqual(steps.map(step=>[step.content,step.status,step.now]),[['Read the code','completed','Reading the code'],['Write the fix','in_progress','Writing the fix']]);
 assert.equal(planSteps([tool('Read',{})],()=>earlier),null,'a reply that touched no task shows none');
 const reset=planSteps([tool('TaskList',{},{tasks:[{id:'2',subject:'Write the fix',status:'completed'}]})],()=>earlier)!;
 assert.deepEqual(reset.map(step=>[step.content,step.status]),[['Write the fix','completed']]);
});

test('the folded line counts finished steps and leaves dropped ones out',()=>{
 assert.equal(foldText([{id:'1',content:'a',status:'completed'},{id:'2',content:'b',status:'completed'}]),'2 of 2 steps done');
 assert.equal(foldText([{id:'1',content:'a',status:'completed'},{id:'2',content:'b',status:'cancelled'},{id:'3',content:'c',status:'pending'}]),'1 of 2 steps done');
 assert.equal(foldText([{id:'1',content:'a',status:'completed'}]),'1 of 1 step done');
});

test('the Tasks panel shows the same steps, Claude Code task tools included, and an emptied list as cleared',()=>{
 const turn=(id:string,created:number):any=>({id,chatId:'chat',prompt:'',text:'',status:'completed',model:'claude-code:opus',created});
 const at=(t:ToolCall,turnId:string)=>({...t,turnId});
 const tools=[at(tool('TaskCreate',{subject:'Read the code'},{task:{id:'1',subject:'Read the code'}}),'a'),at(tool('TaskCreate',{subject:'Write the fix'},{task:{id:'2',subject:'Write the fix'}}),'a'),at(tool('TaskUpdate',{taskId:'1',status:'completed'},{success:true,taskId:'1'}),'b')];
 const state:any={chats:[{id:'chat'}],jobChats:[],turns:[turn('a',1),turn('b',2)],tools,approvals:[]};
 assert.deepEqual(chatActivity(state,'chat').tasks[0].items.map(item=>[item.content,item.status]),[['Read the code','completed'],['Write the fix','pending']]);
 state.tools=[...tools,at(tool('TodoWrite',{todos:[]}),'b')];
 assert.deepEqual(chatActivity(state,'chat').tasks[0].items,[],'an emptied list shows as cleared');
});
