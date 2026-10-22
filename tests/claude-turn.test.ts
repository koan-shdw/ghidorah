import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeTurnEvent,claudeTurnUsage} from '../app/claude-turn';
import type {Turn} from '../app/types';
test('Claude tools retain their native identity and results; subscription price is not billed cost',()=>{
  const turn={id:'turn',text:'First ',reasoning:''} as Turn;
  assert.equal(claudeTurnEvent(turn,{type:'stream_event',event:{delta:{type:'text_delta',text:'reply'}}}).patch?.text,'First reply');
  const tool=claudeTurnEvent(turn,{type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'Write',input:{file_path:'result.txt'}}]}}).tools![0];
  const result=claudeTurnEvent(turn,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'Saved',is_error:false}]}}).tools![0];
  assert.equal(tool.id,result.id);assert.equal(result.status,'completed');
  const hook=claudeTurnEvent(turn,{type:'runtime.tool',id:'tool',name:'Write',input:{file_path:'result.txt'},status:'completed',result:'Saved by native hook'}).tools![0];
  assert.equal(hook.id,tool.id);assert.equal(hook.status,'completed');assert.equal({...hook,...tool}.result,'Saved by native hook');assert.equal({...hook,...tool}.status,'completed');
  const usage=claudeTurnUsage({usage:{input_tokens:20,output_tokens:5,cache_read_input_tokens:100},total_cost_usd:999,context:{totalTokens:250,maxTokens:200000}});
  assert.equal(usage.turn_total,125);assert.equal(usage.turn_cost_usd,null);assert.equal(usage.context_used,250);
});
