import {test} from 'node:test';
import assert from 'node:assert/strict';
import {jevQuestions,parseJev,type JevState} from '../app/jev';
const settings={summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:500};
test('typed Jev choices preserve explicit requests, uncertainty and its own fallback order over 50 scripted states',()=>{
 const tasks=['Explain an error','Build a web form','Review a patch','Write tests','Plan a migration','Summarize a document','Debug a race','Translate text','Compare implementations','Inspect a failed build'];
 for(let index=0;index<50;index++){
  const state:JevState={summary:tasks[index%tasks.length],current:'a',selected:index%5===0?['a']:[],models:['a','b','c'].map(id=>({id,label:id,available:true,capabilities:['text','tools']})),health:[],attachmentTypes:[]};
  const answer=(choice:string,confidence=0.9)=>({type:'choice',choice,confidence});
  const body={answers:{primary:answer('b'),execution:answer('single'),after_0:answer('c'),after_1:answer('c'),after_2:answer('a')}};
  const result=parseJev(body,state,settings);
  assert.deepEqual(result.order,state.selected.length?[]:['b','c','a']);
  assert.equal(result.model,state.selected.length?null:'b');
  assert.equal(parseJev({answers:{primary:answer('b',0.2)}},state,settings).model,null);
  state.models[0].available=false;
  assert.deepEqual(parseJev({answers:{primary:answer('b'),execution:answer('single'),after_0:answer('c'),after_1:answer('ask')}},state,settings).order,['b','c']);
  assert.ok(!Object.hasOwn((jevQuestions(state).primary as any).criteria,'a'));
 }
 const state:JevState={summary:'task',current:null,selected:[],models:[{id:'a',label:'A',available:true,capabilities:['text']}],health:[],attachmentTypes:[]};
 assert.throws(()=>jevQuestions({...state,models:[]}));
 for(const bad of [{choice:'foreign',confidence:0.9},{choice:'a',confidence:NaN},{choice:'a',confidence:2}])assert.throws(()=>parseJev({answers:{primary:{type:'choice',...bad}}},state,settings));
});

test('composed choices preserve selected sets and require a confident participating lead',()=>{
 const state:JevState={summary:'Implement with reviews',current:null,selected:['a','b'],models:['a','b','c'].map(id=>({id,label:id,available:true,capabilities:['coding','tools']})),health:[],attachmentTypes:[]};
 const choice=(choice:string,confidence=0.95)=>({type:'choice',choice,confidence});
 const answers={primary:choice('a'),execution:choice('parallel'),include_0:choice('include'),include_1:choice('include'),include_2:choice('omit'),collaboration:choice('review'),lead:choice('a')};
 const result=parseJev({answers},state,settings);assert.deepEqual(result.models,['a','b']);assert.deepEqual(result.collaboration,{strategy:'review',lead:'a'});assert.deepEqual(result.order,[]);
 assert.equal(parseJev({answers:{...answers,include_1:choice('omit')}},state,settings).model,null);
 assert.equal(parseJev({answers:{...answers,lead:choice('c')}},state,settings).model,null);
 assert.equal(parseJev({answers:{...answers,collaboration:choice('ownership',0.2)}},state,settings).model,null);
 assert.deepEqual(parseJev({answers},{...state,selected:[]},settings).models,['a','b']);
});
