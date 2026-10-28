import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {ApiProviders} from '../app/api-providers';

// Koan 2026-10-28: after an update the suppliers looked disconnected until their start-up checks answered.
test('saved suppliers show as connected, marked Checking…, before any check runs',()=>{
 const store=new Store(':memory:');
 store.put('api-connection',{id:'openai-api',provider:'openai-api',connected:true,status:'Connected',models:[{id:'api:openai-api:gpt-6',label:'GPT-6',vision:true}]});
 store.put('api-connection',{id:'gemini',provider:'gemini',connected:false,status:'Not connected',models:[]});
 store.put('api-connection',{id:'not-a-supplier',provider:'x',connected:true,status:'Connected',models:[]});
 const providers=new ApiProviders({} as any,store,{rows:()=>[]} as any,()=>{});
 const rows=providers.rows();
 assert.deepEqual(rows.map(row=>[row.provider,row.connected,row.status]),[['openai-api',true,'Checking…']],'only saved, connected, known suppliers');
 assert.deepEqual(providers.models(),['api:openai-api:gpt-6'],'their models stay choosable while they are checked');
});
