import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSelector,selectorSummary} from '../app/selector';
import type {JevState} from '../app/jev';

const state:JevState={summary:'Fix the parser',current:null,selected:[],health:[],attachmentTypes:[],models:[{id:'gpt-6-sol',label:'GPT-6 Sol',available:true,capabilities:['coding']},{id:'deepseek-flash',label:'DeepSeek Flash',available:true,capabilities:['coding']}]};
const settings={summaryModel:'claude-code:opus',confidence:0.7,timeoutMs:30000};

test('a model on select duty picks through the same rules as Jev',()=>{
 const text='Here you go:\n```json\n{"answers":{"primary":{"choice":"gpt-6-sol","confidence":0.92},"execution":{"choice":"single","confidence":0.9},"after_0":{"choice":"deepseek-flash","confidence":0.8},"after_1":{"choice":"ask","confidence":0.9}}}\n```';
 const pick=parseSelector(text,state,settings,1200,{input_tokens:10,output_tokens:5},'Opus');
 assert.equal(pick.model,'gpt-6-sol');assert.deepEqual(pick.order,['gpt-6-sol','deepseek-flash']);assert.match(pick.message,/Opus/);
 const unsure=parseSelector('{"answers":{"primary":{"choice":"gpt-6-sol","confidence":0.4}}}',state,settings,10,null,'Opus');
 assert.equal(unsure.model,null);assert.match(unsure.message,/Opus is unsure/);
});
test('an unreadable or incomplete answer names the selector and never picks',()=>{
 assert.throws(()=>parseSelector('I think GPT is best.',state,settings,10,null,'Haiku'),/Haiku did not return/);
 assert.throws(()=>parseSelector('{"answers":{"primary":{"choice":"gpt-6-sol","confidence":0.9}}}',state,settings,10,null,'Haiku'),/Haiku returned an invalid decision/);
 assert.throws(()=>parseSelector('{"answers":{"primary":{"choice":"not-in-chat","confidence":0.9}}}',state,settings,10,null,'Haiku'),/Haiku/);
});
test('the selector reads a short recent history instead of a separate summary call',()=>{
 const history=Array.from({length:9},(_,i)=>({prompt:'ask '+i,text:'x'.repeat(2000),model:'gpt-6-sol'}));
 const summary=JSON.parse(selectorSummary(history,'next'));
 assert.equal(summary.recent.length,6);assert.equal(summary.recent[0].request,'ask 3');assert.equal(summary.recent[0].reply.length,600);assert.equal(summary.message,'next');
});
