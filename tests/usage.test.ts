import test from 'node:test';
import assert from 'node:assert/strict';
import {modelUsage,resetLabel,windowLabel,claudeUsage,claudeRateUsage,priceLines} from '../app/usage';
import type {Turn} from '../app/types';

test('usage separates models, adds turn deltas, and keeps context distinct from cumulative tokens',()=>{
  const turns=[
    {model:'deepseek-flash',created:1,usage:{total:100,turn_total:100,turn_cost_usd:.02,context_used:80,context_max:128000}},
    {model:'gpt-6-astra',created:2,usage:{total:220,turn_total:120,context_used:150,context_max:272000}},
    {model:'deepseek-flash',created:3,usage:{total:320,turn_total:100,turn_cost_usd:.03,context_used:250,context_max:128000,context_estimated:true}},
    {model:'deepseek-flash',created:4,usage:null},
  ] as Turn[];
  const deepseek=modelUsage(turns,'deepseek-flash');
  assert.equal(deepseek.tokens,200);assert.equal(deepseek.cost,.05);assert.equal(deepseek.partial,true);
  assert.deepEqual(deepseek.context,{used:250,max:128000,estimated:true,source:'provider_usage',created:3});
  const gpt=modelUsage(turns,'gpt-6-astra');assert.equal(gpt.tokens,120);assert.equal(gpt.cost,null);assert.equal(gpt.partial,false);
  assert.equal(modelUsage(turns,'unused').tokens,null);
  assert.equal(modelUsage([{model:'bad',usage:{turn_total:NaN,context_used:0,context_max:0}} as Turn],'bad').context,null);
  const routed=[...turns,{model:'gpt-6-astra',created:5,usage:{turn_total:230,mixed_models:['deepseek-flash','gpt-6-astra']},routingUsage:{summaryModel:'deepseek-flash',summaryTokens:40,jevTokens:12}}] as Turn[];
  assert.equal(modelUsage(routed,'deepseek-flash').tokens,240);
  assert.equal(modelUsage(routed,'deepseek-flash').summaryTokens,40);
  assert.equal(modelUsage(routed,'gpt-6-astra').tokens,120);
  assert.equal(modelUsage(routed,'gpt-6-astra').partial,true);
  const grouped=[{model:'gpt-6-astra',jobs:['child'],usage:null},{id:'child',model:'gpt-6-astra',usage:{turn_total:120}}] as Turn[];
  assert.equal(modelUsage(grouped,'gpt-6-astra').tokens,120);assert.equal(modelUsage(grouped,'gpt-6-astra').partial,false);
  const compacted=modelUsage(grouped,'gpt-6-astra',[{model:'gpt-6-astra',tokens:60},{model:'gpt-6-astra',tokens:null}]);
  assert.equal(compacted.tokens,180);assert.equal(compacted.contextTokens,60);assert.equal(compacted.partial,true);assert.equal(compacted.costPartial,true);
});
test('Claude control usage preserves percent scale and distinguishes model-specific weekly windows',()=>{
  const result=claudeUsage({subscription_type:'max',private:'not returned',rate_limits_available:true,rate_limits:{five_hour:{utilization:.5,resets_at:'2026-09-29T06:10:00Z'},seven_day:{utilization:16},model_scoped:[{display_name:'Fable',utilization:32}]}});
  assert.deepEqual(result.windows.map(window=>[window.label,window.usedPercent]),[['5-hour limit',.5],['Weekly · all models',16],['Weekly · Fable',32]]);
  assert.equal(claudeUsage({rate_limits_available:false,rate_limits:{five_hour:{utilization:90}}}).windows.length,0);
  assert.equal('private' in result,false);
 const streamed=claudeRateUsage({type:'rate_limit_event',rate_limit_info:{rateLimitType:'five_hour',utilization:1,resetsAt:2000000000}},result.windows);
 assert.equal(streamed[0].usedPercent,100);assert.equal(streamed[1].usedPercent,16);assert.equal(streamed.length,result.windows.length);
});
test('window labels follow reported duration and expired limits do not pretend to have reset',()=>{
  assert.equal(windowLabel('Session',604800),'Weekly');assert.equal(windowLabel('Session',18000),'5-hour limit');
  assert.equal(windowLabel('Monthly'),'Monthly');
  assert.equal(resetLabel('2026-09-29T06:10:00Z',Date.parse('2026-09-29T06:00:00Z')),'Resets in 10 min');
  assert.match(resetLabel('2026-09-29T06:10:00Z',Date.parse('2026-09-29T06:11:00Z')),/refresh/);
  assert.equal(resetLabel(null),'Reset time unavailable');
});

test('price lines show the list price and compare each other priced model in the chat',()=>{
 const prices={'deepseek-flash':{input:0.15,output:0.6},'api:openai-api:gpt-5.6-sol':{input:5,output:30},'api:gemini:gemini-3.6-flash':{input:0.16,output:0.62},'gpt-5.6-sol':{included:true}};
 const label=(id:string)=>id;
 assert.deepEqual(priceLines('deepseek-flash',['deepseek-flash','api:openai-api:gpt-5.6-sol','api:gemini:gemini-3.6-flash','gpt-5.6-sol','api:zai:glm-5.3'],prices,label),
  ['$0.15 in · $0.60 out per million tokens','43× cheaper than api:openai-api:gpt-5.6-sol','About the same price as api:gemini:gemini-3.6-flash']);
 assert.deepEqual(priceLines('api:openai-api:gpt-5.6-sol',['deepseek-flash','api:openai-api:gpt-5.6-sol'],prices,label),['$5 in · $30 out per million tokens','43× pricier than deepseek-flash']);
 assert.deepEqual(priceLines('api:zai:glm-5.3',['deepseek-flash'],prices,label),['Price unavailable']);
 assert.deepEqual(priceLines('gpt-5.6-sol',['deepseek-flash'],prices,label),['Price unavailable']);
});
