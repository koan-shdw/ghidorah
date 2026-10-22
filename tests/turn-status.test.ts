import test from 'node:test';
import assert from 'node:assert/strict';
import {turnActivity,turnModelLabel} from '../app/turn-status';
import type {Turn} from '../app/types';

// TURN-REVIEW part 7: the status comes from the engine record; no message shows "Queued" without its reason.
test('every waiting or sent message says what is happening to it',()=>{
  const turn=(patch:Partial<Turn>)=>({id:'t',chatId:'c',prompt:'',text:'',reasoning:'',model:'claude-code:opus',status:'queued',error:null,usage:null,created:0,...patch}) as Turn;
  assert.equal(turnActivity(turn({hold:'Waiting for Opus to finish before GPT-6 takes over'}),[],[]),'Waiting for Opus to finish before GPT-6 takes over');
  assert.equal(turnActivity(turn({paused:true}),[],[]),'Paused after restart');
  assert.notEqual(turnActivity(turn({}),[],[]),'Queued');
  assert.equal(turnActivity(turn({status:'running',delivery:'sent',activity:'Sent, Opus reads it after the current step'}),[],[]),'Sent, Opus reads it after the current step');
  assert.equal(turnActivity(turn({status:'completed',answeredIn:'owner'}),[],[]),'Completed');
  assert.equal(turnActivity(turn({status:'dispatching',preparation:'Checking plugins'}),[],[]),'Checking plugins');
});

test('while a message is routed its label names whoever picks; then the model picked (Koan 2026-10-15)',()=>{
  const turn=(patch:Partial<Turn>)=>({id:'t',chatId:'c',prompt:'',text:'',reasoning:'',model:'deepseek-flash',status:'dispatching',error:null,usage:null,created:0,...patch}) as Turn;
  const label=(model:string)=>({'deepseek-flash':'DeepSeek','gemini-3.8-flash':'gemini-3.8-flash','claude-code:fable':'Fable 5.1'} as Record<string,string>)[model]||model;
  assert.equal(turnModelLabel(turn({routePending:true,routeBy:'gemini-3.8-flash'}),label),'gemini-3.8-flash picking','not the chat default (DeepSeek)');
  assert.equal(turnModelLabel(turn({routePending:true,routeBy:'jev'}),label),'Jev picking');
  assert.equal(turnModelLabel(turn({routePending:false,routeBy:'gemini-3.8-flash',model:'claude-code:fable'}),label),'Fable 5.1','after the pick: the model picked');
});
