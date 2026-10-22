// Native catalogue selection and reported settings, using the supervised CLI fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ClaudeSession,type ClaudeRun,type ClaudeResult} from '../app/claude';
import {SecretScrubber} from '../app/redaction';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-agent-config-')),tasks=new Map<string,any>(),completed=new Map<string,ClaudeResult|Error>(),events=new Map<string,any[]>();
await fs.writeFile(path.join(data,'source.txt'),'read-only configuration check');
const scrubber=new SecretScrubber();scrubber.register('private-native-marker');
const base={executable:process.execPath,prefixArgs:[path.join(root,'tests/fixtures/claude-cli.mjs')],python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'parent-fixture',effort:'high',mode:'manual' as const,hasFolder:true,scrubber,work:{before:async()=>{},after:async()=>{}}};
const options=(spec:any,label='parent'):ClaudeRun=>({...base,prompt:JSON.stringify(spec),signal:new AbortController().signal,event:e=>{const rows=events.get(label)||[];rows.push(e);events.set(label,rows);},approve:async(_id,name)=>name==='Read',delegation:async task=>{tasks.set(task.description,task);return {options:{...options({},task.description),model:task.model},complete:value=>completed.set(task.description,value)};}});
const cases=[
 {description:'definition',agentType:'fixture:haiku',model:null,expected:'haiku',effort:'low',permissionMode:'acceptEdits'},
 {description:'full-id',agentType:'fixture:full',model:null,expected:'claude-haiku-4-5-20251001'},
 {description:'override',agentType:'fixture:haiku',model:'sonnet',expected:'sonnet',resolvedModel:'claude-sonnet-5',effort:'medium',permissionMode:'plan'},
 {description:'explicit-inherit',agentType:'fixture:haiku',model:'inherit',expected:'parent-fixture',resolvedModel:'parent-resolved'},
 {description:'definition-inherit',agentType:'fixture:inherit',model:null,expected:'parent-fixture'},
 {description:'missing-definition',agentType:'general-purpose',model:null,expected:'parent-fixture'},
 {description:'redaction',agentType:'private-native-marker',model:null,expected:'parent-fixture',resolvedModel:'private-native-marker'},
 {description:'model-redaction',agentType:'fixture:haiku',model:'private-native-marker',expected:scrubber.text('private-native-marker')},
];
const session=await ClaudeSession.open(options({action:'reply'}));
try{
 await session.submit(options({action:'agent',children:cases.map(c=>({...c,path:'source.txt',read:true,readOnly:true}))}));
 const until=Date.now()+15000;while(completed.size<cases.length){if(Date.now()>until)throw Error('Agent checks timed out');await new Promise(r=>setTimeout(r,20));}
 for(const c of cases){
  assert.equal(tasks.get(c.description).model,c.expected);assert.equal(tasks.get(c.description).agentType,scrubber.text(c.agentType));assert.equal((completed.get(c.description) as ClaudeResult).status,'completed');
  const reported=Object.assign({},...events.get(c.description)!.filter(e=>e.type==='runtime.agentConfig'));
  assert.equal(reported.resolvedModel,scrubber.text(c.resolvedModel||'claude-haiku-4-5-20251001'));assert.equal(reported.effort,c.effort);assert.equal(reported.permissionMode,c.permissionMode||'default');
 }
 assert.ok(!events.get('parent')!.some(e=>e.type==='runtime.agentConfig'));
 assert.ok(!JSON.stringify([...events]).includes('private-native-marker'));
 assert.ok(!JSON.stringify([...tasks]).includes('private-native-marker'));
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({definitionModel:true,fullModelId:true,invocationOverride:true,explicitInheritance:true,missingEffortUnknown:true,reportedSettingsOwned:true,metadataScrubbed:true},null,2));
 console.log('PASS native definition/override/inheritance, separate reported settings, unknown effort and scrubbed metadata. Evidence: '+data);
}finally{await session.close();}
