import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentSteps,approvalWords,elapsed} from '../app/agent-pills';

test('an agent\'s step is its own running tool in plain words, the latest when several run',()=>{
 const tools:any[]=[
  {id:'1',turnId:'a',name:'Read',args:{file_path:'docs/STATUS.md'},status:'completed',result:null},
  {id:'2',turnId:'a',name:'Bash',args:{command:'python tools/check.py',description:'Run the card check'},status:'running',result:null},
  {id:'3',turnId:'b',name:'Read',args:{file_path:'I:\\DEV\\x\\PLAN.md'},status:'running',result:null},
  {id:'4',turnId:'b',name:'Grep',args:{pattern:'uFreeze'},status:'running',result:null},
  {id:'5',turnId:'c',name:'TodoWrite',args:{todos:[]},status:'running',result:null},
  {id:'6',turnId:'other',name:'Read',args:{file_path:'secret.txt'},status:'running',result:null},
 ];
 assert.deepEqual(agentSteps([{id:'a'},{id:'b'},{id:'c'},{id:'d'}],tools),{a:'Run the card check',b:'Search for "uFreeze"'});
 assert.deepEqual(agentSteps([],tools),{});
});
test('a waiting permission is named by what it would do; a question has no such line',()=>{
 assert.equal(approvalWords({method:'approval',params:{description:'Write\n'+JSON.stringify({file_path:'docs/notes.md',content:'x'},null,2)}}),'Write notes.md');
 assert.equal(approvalWords({method:'approval',params:{description:'Bash\n{"command":"npm test"}'}}),'Run npm test');
 assert.equal(approvalWords({method:'approval',params:{description:'Odd tool\nnot json'}}),'Odd tool');
 assert.equal(approvalWords({method:'approval',params:{}}),'Tool');
 assert.equal(approvalWords({method:'clarify',params:{question:'Which colour?'}}),'');
});
test('time at work is short: seconds, minutes, then hours and minutes',()=>{
 assert.equal(elapsed(0,40000),'40s');assert.equal(elapsed(0,59400),'59s');assert.equal(elapsed(0,240000),'4m');assert.equal(elapsed(0,3900000),'1h 5m');assert.equal(elapsed(10,0),'0s');
});
