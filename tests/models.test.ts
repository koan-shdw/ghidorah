import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newestFirst,modelLabel,modelEfforts,providerFor} from '../app/models';

test('Kimi K3 and its point versions show the levels the engine sends: low, high, max',()=>{
 const k3={low:'Low',high:'High',max:'Max'},older={low:'Low',medium:'Medium',high:'High'};
 for(const id of ['k3','k3-256k','kimi-k3-cot','kimi-k3.1-pro','kimi-k3.1-pro-highspeed'])assert.deepEqual(modelEfforts('api:kimi-coding:'+id),k3,id);
 for(const id of ['kimi-k2.6','kimi-k2-turbo','moonshot-v1-k30'])assert.deepEqual(modelEfforts('api:kimi-coding:'+id),older,id);
});

test('model picker lists the newest models first within each supplier',()=>{
 const rows=[
  {id:'api:openai-api:gpt-old',supplier:'OpenAI · API',created:1700000000000},
  {id:'api:openai-api:gpt-new',supplier:'OpenAI · API',created:1790000000000},
  {id:'api:gemini:gemini-2.5-pro',supplier:'Google · Gemini',created:null},
  {id:'api:gemini:gemini-3.1-pro-preview',supplier:'Google · Gemini',created:null},
  {id:'gpt-5.5',supplier:'OpenAI',created:null},{id:'gpt-6-sol',supplier:'OpenAI',created:null},{id:'gpt-6-luna',supplier:'OpenAI',created:null},
  {id:'claude-code:opus',supplier:'Anthropic',created:null},{id:'claude-code:haiku',supplier:'Anthropic',created:null},
 ];
 const order=newestFirst(rows,id=>modelLabel(id)).map(row=>row.id);
 assert.deepEqual(order,['claude-code:opus','claude-code:haiku','api:gemini:gemini-3.1-pro-preview','api:gemini:gemini-2.5-pro','gpt-6-sol','gpt-6-luna','gpt-5.5','api:openai-api:gpt-new','api:openai-api:gpt-old']);
});
test('every DeepSeek model belongs to DeepSeek and gets a readable name',()=>{
 assert.equal(providerFor('deepseek-flash'),'deepseek');assert.equal(providerFor('deepseek-v4-pro'),'deepseek');
 assert.equal(modelLabel('deepseek-flash'),'DeepSeek');assert.equal(modelLabel('deepseek-v4-pro'),'DeepSeek V4 Pro');assert.equal(modelLabel('deepseek--odd-'),'DeepSeek Odd');
 assert.throws(()=>providerFor('deepseek-'));
});
