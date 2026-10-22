import type {McpOwner} from './mcp-owner';
import type {McpConnection} from './types';

// Each run owns this map and its cancellation scope. It carries no credentials.
export function mcpExchange(owner:McpOwner,rows:McpConnection[],memory?:{tools:any[];call:(name:string,args:any,signal:AbortSignal,directory?:string)=>Promise<any>}){
 const servers=new Map(rows.filter(row=>row.enabled).map(row=>['connection_'+row.id,row.id]));
 const calls=new Map<string,{input:string;result:Promise<any>}>();
 return {
  names:[...servers.keys(),...(memory?['ghidorah']:[])],
  managedTools:memory?memory.tools.map(tool=>'mcp__ghidorah__'+tool.name):[],
  async handle(server:string,message:any,signal:AbortSignal,directory?:string){
   const id=servers.get(server),reply=(result:any)=>({jsonrpc:'2.0',id:message?.id,result});
   try{
    const local=server==='ghidorah'?memory:undefined;
    if(!id&&!local)throw Error('This connection is not part of this exchange.');
    if(signal.aborted)throw Error('Exchange ended.');
    if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')throw Error('Invalid MCP request.');
    if(!Object.hasOwn(message,'id'))return {jsonrpc:'2.0',result:{}};
    if(message.method==='initialize')return reply({protocolVersion:message.params?.protocolVersion||'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Ghidorah',version:'0.1.0'}});
    if(message.method==='ping')return reply({});
    if(message.method==='tools/list')return reply({tools:local?local.tools:await owner.request('tools',{id},signal)});
    if(message.method==='tools/call'&&local){
     const key=JSON.stringify(message.id),input=JSON.stringify([message.params,directory]),previous=calls.get(key);
     if(previous&&previous.input!==input)throw Error('A completed request cannot be changed.');
     if(!previous)calls.set(key,{input,result:local.call(message.params?.name,message.params?.arguments||{},signal,directory)});
     return reply(await calls.get(key)!.result);
    }
    if(message.method==='tools/call')return reply(await owner.request('call',{id,name:message.params?.name,arguments:message.params?.arguments||{}},signal));
    return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported MCP method.'}};
   }catch(error){return {jsonrpc:'2.0',id:message?.id??null,error:{code:-32603,message:String(error)}};}
  }
 };
}
