import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Every app action a window asks for must be on preload's list, or the window's click is refused.
// run(key, fn) in the MCP page is a local busy helper, not an app action.
test('every action the windows call is allowed by preload',()=>{
 const allowed=new Set([...fs.readFileSync('app/preload.ts','utf8').matchAll(/'(\w+)'/g)].map(match=>match[1])),missing:string[]=[];
 for(const file of fs.readdirSync('app').filter(name=>name.endsWith('.tsx'))){
  const text=fs.readFileSync('app/'+file,'utf8');
  for(const match of text.matchAll(/\b(call|run|invoke)\('(\w+)'/g))if(!(file==='mcp-settings.tsx'&&match[1]==='run')&&!allowed.has(match[2]))missing.push(file+': '+match[2]);
 }
 assert.deepEqual(missing,[]);
});
