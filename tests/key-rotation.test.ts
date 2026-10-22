import test from 'node:test';
import assert from 'node:assert/strict';
import {rotationRows} from '../app/key-rotation';
import type {Snapshot} from '../app/types';

test('rotate all keys: one row per connected supplier with its key page or sign-in',()=>{
 const base:Snapshot={projects:[],chats:[],turns:[],tools:[],approvals:[],connected:false,backend:'ready',providerStatus:'Not connected'};
 assert.deepEqual(rotationRows(base),[]);
 const rows=rotationRows({...base,connected:true,providerStatus:'Credit exhausted',codex:{connected:true,status:'Signed in',models:[]},jev:{connected:false,status:'Not connected',summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:500},
  apiProviders:[{provider:'gemini',connected:true,status:'Connected',models:[],baseUrl:'',source:'live',checkedAt:null},{provider:'xai-oauth',connected:true,status:'Authentication failed',models:[],baseUrl:'',source:'live',checkedAt:null},{provider:'mistral',connected:false,status:'Not connected',models:[],baseUrl:'',source:'live',checkedAt:null}]});
 assert.deepEqual(rows.map(r=>[r.id,r.health,r.signIn,r.page?.method]),[['deepseek','limited',false,'link'],['openai','ok',true,undefined],['gemini','ok',false,'apiLink'],['xai-oauth','down',true,'apiLink']]);
 assert.deepEqual(rows[2].page?.args,{provider:'gemini'});
});
