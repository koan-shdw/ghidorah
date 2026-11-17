import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planLists,planPrice} from '../app/plan-prices';

test('a plan is priced by the name its supplier reports, in any spelling',()=>{
 assert.deepEqual(planPrice('claude-code','max'),{usd:100,page:'https://claude.com/pricing',read:planLists['claude-code'].read});
 assert.equal((planPrice('claude-code','Max') as {usd:number}).usd,100);
 assert.equal((planPrice('claude-code','claude_pro') as {usd:number}).usd,20);
 assert.equal((planPrice('openai-codex','chatgpt_plus') as {usd:number}).usd,20);
 assert.equal((planPrice('openai-codex','Go') as {usd:number}).usd,8);
});
test('a plan name that covers several prices gives the choices, never a guess',()=>{
 const price=planPrice('openai-codex','pro');
 assert.ok(price&&'choices' in price);assert.deepEqual(price.choices,[100,200,500]);
 price.choices.push(1);assert.deepEqual((planPrice('openai-codex','pro') as {choices:number[]}).choices,[100,200,500]);
});
test('the longest plan name that fits wins, and an unknown supplier or plan has no price',()=>{
 assert.equal((planPrice('xai-oauth','premium') as {usd:number}).usd,30);
 assert.equal(planPrice('claude-code','team'),null);
 assert.equal(planPrice('claude-code',undefined),null);assert.equal(planPrice('claude-code',''),null);
 assert.equal(planPrice('toString','max'),null);assert.equal(planPrice('deepseek','max'),null);
});
test('every list names its supplier page, the date it was read and real prices',()=>{
 for(const [supplier,list] of Object.entries(planLists)){
  assert.match(list.page,/^https:\/\/[a-z0-9.-]+\//,supplier);assert.match(list.read,/^2026-\d\d-\d\d$/,supplier);assert.ok(list.name,supplier);
  for(const [plan,price] of Object.entries(list.plans)){
   assert.match(plan,/^[a-z0-9]+$/,supplier+' '+plan);
   for(const usd of Array.isArray(price)?price:[price])assert.ok(Number.isFinite(usd)&&usd>=0,supplier+' '+plan);
  }
 }
});
