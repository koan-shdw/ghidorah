import {test} from 'node:test';
import assert from 'node:assert/strict';
import {monthUsage,monthBounds} from '../app/usage-months';
import type {Turn} from '../app/types';

const day=(time:number)=>'d'+Math.floor(time/100);
const turn=(id:string,chatId:string,created:number,model:string,total:number|null,extra:Partial<Turn>={})=>({id,chatId,created,model,prompt:'',text:'',reasoning:'',status:'completed',error:null,usage:total===null?null:{turn_total:total},...extra}) as Turn;
const chats=[{id:'a'},{id:'b'},{id:'side',parentChatId:'a'},{id:'lone'}];
const apps=[{id:'app1',chatIds:['a']},{id:'app2',chatIds:['a','b']}];

test('a stretch sums replies per model, app, chat and day, and leaves out what is outside it',()=>{
 const use=monthUsage({turns:[
  turn('1','a',100,'m1',10),turn('2','a',150,'m2',20),turn('3','b',210,'m1',5),turn('4','lone',220,'m1',7),
  turn('before','a',99,'m1',1000),turn('after','a',300,'m1',1000),
 ],chats,apps,from:100,to:300,dayOf:day});
 assert.equal(use.tokens,42);assert.deepEqual(use.models,{m1:22,m2:20});assert.equal(use.partial,false);
 assert.deepEqual(use.apps,{app1:{tokens:30,models:{m1:10,m2:20}},app2:{tokens:35,models:{m1:15,m2:20}}});
 assert.equal(use.unlinked,7);assert.equal(use.shared,30);
 assert.deepEqual(use.days,{d1:30,d2:12});
 assert.deepEqual(use.chats.map(row=>[row.chatId,row.tokens,row.replies]),[['a',30,2],['lone',7,1],['b',5,1]]);
});
test('a side chat and a job chat count for the chat they came from',()=>{
 const use=monthUsage({turns:[
  turn('group','a',100,'m1',null,{jobs:['j1','j2']}),
  turn('j1','job-one',110,'m1',4,{parentTurnId:'group'}),turn('j2','job-two',120,'m2',6,{parentTurnId:'group'}),
  turn('s','side',130,'m1',3),
 ],chats,apps,from:0,to:1000,dayOf:day});
 assert.equal(use.tokens,13);assert.deepEqual(use.chats.map(row=>[row.chatId,row.tokens,row.replies]),[['a',13,3]]);
 assert.equal(use.apps.app1.tokens,13);assert.equal(use.partial,false,'a group parent saves no usage of its own and is not a gap');
});
test('a reply with no count, or shared by several models, marks the sums as a floor',()=>{
 assert.equal(monthUsage({turns:[turn('1','a',100,'m1',null)],chats,apps,from:0,to:1000,dayOf:day}).partial,true);
 const mixed=monthUsage({turns:[turn('1','a',100,'m1',9,{usage:{turn_total:9,mixed_models:['m1','m2']}})],chats,apps,from:0,to:1000,dayOf:day});
 assert.equal(mixed.tokens,9);assert.deepEqual(mixed.models,{});assert.equal(mixed.partial,true);
 assert.equal(monthUsage({turns:[turn('1','a',100,'command:ponytail',null)],chats,apps,from:0,to:1000,dayOf:day}).partial,false,'a plugin command is not a model reply');
});
test('routing tokens count for the model that wrote the summary; agents are kept apart',()=>{
 const use=monthUsage({turns:[
  turn('1','a',100,'m1',10,{routingUsage:{summaryModel:'m2',summaryTokens:3,pickerTokens:2}}),
  turn('agent','a',110,'m1',null,{automatic:{kind:'agent',originTurnId:'1',taskId:'t'},usage:{turn_total:null,native_task_usage:{total_tokens:50}}}),
 ],chats,apps,from:0,to:1000,dayOf:day});
 assert.equal(use.tokens,15);assert.deepEqual(use.models,{m1:10,m2:3});assert.equal(use.routing,5);
 assert.equal(use.agents,50);assert.equal(use.partial,false);assert.equal(use.chats[0].replies,1);
});
test('month bounds are the first of the month and of the next, in local time',()=>{
 const {from,to}=monthBounds(new Date(2026,10,17,23,40).getTime());
 assert.equal(from,new Date(2026,10,1).getTime());assert.equal(to,new Date(2026,11,1).getTime());
 const december=monthBounds(new Date(2026,11,31,23,59).getTime());assert.equal(december.to,new Date(2027,0,1).getTime());
});
