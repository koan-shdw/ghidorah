import test from 'node:test';import assert from 'node:assert/strict';import {mcpExchange} from '../app/mcp-exchange';
test('local MCP inspection retains the tool directory and refuses replay in another directory',async()=>{
 const directories:(string|undefined)[]=[],exchange=mcpExchange({} as any,[],{tools:[],call:async(_name,_args,_signal,directory)=>{directories.push(directory);return {directory};}}),signal=new AbortController().signal;
 const message={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'inspect_action',arguments:{}}};
 assert.deepEqual((await exchange.handle('ghidorah',message,signal,'one')).result,{directory:'one'});
 await exchange.handle('ghidorah',message,signal,'one');assert.deepEqual(directories,['one']);
 const refused=await exchange.handle('ghidorah',message,signal,'two');assert.ok('error' in refused&&refused.error);assert.match(refused.error.message,/cannot be changed/);assert.deepEqual(directories,['one']);
 await exchange.handle('ghidorah',{...message,id:2},signal,'two');assert.deepEqual(directories,['one','two']);
});
