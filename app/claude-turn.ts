import type {Turn,ToolCall} from './types';
import {toolResultFailed} from './tool-result';

export function claudeTurnUsage(result:any){
  const measured=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
  const total=measured.some(key=>typeof result?.usage?.[key]==='number')?measured.reduce((sum,key)=>sum+(result.usage[key]||0),0):null;
  const context=result?.context;
  return {turn_total:total,turn_cost_usd:null,context_used:context?.totalTokens,context_max:context?.maxTokens,context_estimated:false,context_source:'claude_code',...(result?.native_task_usage?{native_task_usage:result.native_task_usage}:{})};
}

export function claudeTurnEvent(turn:Turn,event:any):{patch?:Partial<Turn>;tools?:Partial<ToolCall>[]} {
  const delta=event.type==='stream_event'?event.event?.delta:null;
  if(delta?.type==='text_delta')return {patch:{text:turn.text+delta.text,activity:'Writing reply'}};
  if(delta?.type==='thinking_delta')return {patch:{reasoning:turn.reasoning+delta.thinking,activity:'Thinking'}};
  if(event.type==='runtime.tool')return {tools:[{id:turn.id+':'+event.id,turnId:turn.id,name:event.name,args:event.input,...(event.status==='running'?{}:{status:event.status,result:event.result})}]};
  const content=event.message?.content;
  if(!Array.isArray(content))return {};
  if(event.type==='assistant')return {tools:content.filter(block=>block.type==='tool_use').map(block=>({id:turn.id+':'+block.id,turnId:turn.id,name:block.name,args:block.input}))};
  if(event.type==='user')return {tools:content.filter(block=>block.type==='tool_result').map(block=>({id:turn.id+':'+block.tool_use_id,turnId:turn.id,result:block.content,status:block.is_error||toolResultFailed({content:block.content})?'failed':'completed'}))};
  return {};
}
