import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../app/store';
import {AccountHealth,blockedFor,healthOf} from '../app/availability';

test('OpenAI API credit and ChatGPT subscription refusals remain separate across restart',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tris-openai-health-')),file=path.join(directory,'chat.sqlite');let store=new Store(file),health=new AccountHealth(store);
 const api='api:openai-api:gpt-6-astra',subscription='gpt-6-astra';
 try{
  health.hermes(api,{error_surface:{provider:'openai-api',layer:'billing',code:'insufficient_quota'}});
  assert.equal(blockedFor(health.rows(),api)?.reason,'credit');assert.equal(blockedFor(health.rows(),subscription),undefined);
  health.hermes(subscription,{error_surface:{provider:'openai-codex',layer:'auth',code:'auth'}});
  store.db.close();store=new Store(file);health=new AccountHealth(store);
  health.clear('openai-api',['billing'],Date.now());
  assert.equal(blockedFor(health.rows(),api),undefined);assert.equal(blockedFor(health.rows(),subscription)?.reason,'auth');
 }finally{store.db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('account evidence persists, stale checks cannot clear it, and model windows release only their own scope',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tris-health-')),file=path.join(directory,'chat.sqlite');let store=new Store(file),health=new AccountHealth(store);
 try{
  const now=Date.now(),model='claude-code:opus';
  health.observe('deepseek','billing','credit',true,now);health.observe('deepseek','billing','credit',false,now-1);
  assert.equal(blockedFor(health.rows(),'deepseek-flash')?.reason,'credit');
  health.claude(model,{type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'seven_day_opus',resetsAt:(now+60000)/1000}},now);
  assert.equal(blockedFor(health.rows(),model)?.reason,'limit');assert.equal(blockedFor(health.rows(),'claude-code:haiku'),undefined);
  health.claudeUsage({rate_limits_available:false},now+1);assert.ok(blockedFor(health.rows(),model));
  health.claudeUsage({rate_limits_available:true,rate_limits:{five_hour:{utilization:12}}},now+1);assert.ok(blockedFor(health.rows(),model),'An available five-hour window cannot clear exhausted weekly usage');
  assert.equal(blockedFor(health.rows(),model,now+60001),undefined);
  health.hermes('gpt-6-astra',{error_surface:{provider:'openai-codex',layer:'billing',code:'billing_unverified'}});assert.equal(blockedFor(health.rows(),'gpt-6-astra'),undefined);
  health.hermes('gpt-6-astra',{error_surface:{provider:'openai-codex',layer:'auth',code:'auth'}});
  store.db.close();store=new Store(file);health=new AccountHealth(store);assert.equal(blockedFor(health.rows(),'gpt-6-astra')?.reason,'auth');assert.ok(blockedFor(health.rows(),'deepseek-flash'));
  health.observe('deepseek','billing','credit',false,now+2);assert.equal(blockedFor(health.rows(),'deepseek-flash'),undefined);assert.ok(blockedFor(health.rows(),'gpt-6-astra'));
 }finally{store.db.close();fs.rmSync(directory,{recursive:true,force:true});}
});


test('Alibaba free-tier quota and entitlement failures affect only the refused model',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tris-alibaba-health-')),store=new Store(path.join(directory,'chat.sqlite')),health=new AccountHealth(store);
 const model='api:alibaba:qwen-plus',other='api:alibaba:qwen-turbo';
 try{
  health.hermes(model,{error_surface:{provider:'alibaba',layer:'provider',code:'model_quota_exhausted'}});
  assert.equal(blockedFor(health.rows(),model)?.reason,'limit');assert.equal(blockedFor(health.rows(),other),undefined);
  health.clear('alibaba',['auth'],Date.now());assert.ok(blockedFor(health.rows(),model));
  health.clear('alibaba',['limit'],Date.now());assert.equal(blockedFor(health.rows(),model),undefined);
  health.hermes(model,{error_surface:{provider:'alibaba',layer:'provider',code:'model_entitlement'}});
  assert.equal(blockedFor(health.rows(),model)?.reason,'model');assert.equal(blockedFor(health.rows(),other),undefined);
 }finally{store.db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('pill health reads the 5-minute check results',()=>{
 for(const status of ['Connected','Signed in'])assert.equal(healthOf(status),'ok');
 for(const status of ['Credit exhausted','Usage limit reached'])assert.equal(healthOf(status),'limited');
 for(const status of ['Authentication failed','Not connected','Sign in again','Sign in to Claude Code with your subscription','Claude Code is signed out','Access denied','Claude Code not installed'])assert.equal(healthOf(status),'down');
 for(const status of ['Unverified','Waiting for sign-in','Model check unavailable','Last turn failed',undefined])assert.equal(healthOf(status),'unknown');
 const row={id:'deepseek:billing:account',provider:'deepseek',key:'billing',scope:'account',blocked:true,reason:'credit' as const,resetAt:null,observedAt:0};
 assert.equal(healthOf('Connected',row),'limited');assert.equal(healthOf('Connected',{...row,reason:'model'}),'down');
});

test('Gemini quota preserves model scope, shared quota and explicit recovery without implying prepaid credit',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tris-gemini-health-')),store=new Store(path.join(directory,'chat.sqlite')),health=new AccountHealth(store);
 const model='api:gemini:gemini-3.8-flash',other='api:gemini:gemini-3.8-pro';
 try{
  health.hermes(model,{error_surface:{provider:'gemini',layer:'provider',code:'model_quota_exhausted'}});
  assert.equal(blockedFor(health.rows(),model)?.reason,'limit');assert.equal(blockedFor(health.rows(),model)?.resetAt,null);assert.equal(blockedFor(health.rows(),other),undefined);
  health.clear('gemini',['auth'],Date.now());assert.ok(blockedFor(health.rows(),model));assert.equal(healthOf('Connected',blockedFor(health.rows(),model)),'limited');
  health.hermes(model,{error_surface:{provider:'gemini',layer:'provider',code:'rate_limit'}});assert.equal(blockedFor(health.rows(),other),undefined);
  health.hermes(model,{error_surface:{provider:'gemini',layer:'provider',code:'quota_exhausted'}});assert.equal(blockedFor(health.rows(),other)?.reason,'limit');assert.equal(blockedFor(health.rows(),'api:xai:grok-4.6'),undefined);
  health.clear('gemini',['limit'],Date.now());assert.equal(blockedFor(health.rows(),model),undefined);assert.equal(blockedFor(health.rows(),other),undefined);
 }finally{store.db.close();fs.rmSync(directory,{recursive:true,force:true});}
});
