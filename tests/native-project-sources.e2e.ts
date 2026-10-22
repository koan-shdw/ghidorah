import os from 'node:os';import fs from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {ClaudeSession,findClaude} from '../app/claude';import {SecretScrubber} from '../app/redaction';
import assert from 'node:assert/strict';import {inspectProjectTrust} from '../app/project-trust';
const root=process.cwd(),data=await fs.mkdtemp(path.join(process.env.TRIS_NON_GIT==='1'?os.tmpdir():path.join(root,'work'),'project-sources-probe-')),repo=path.join(data,'repo'),folder=path.join(repo,'packages','app'),cli=await findClaude();if(!cli)throw Error('CLI missing');await fs.mkdir(folder,{recursive:true});if(process.env.TRIS_NON_GIT!=='1')execFileSync('git',['init','-q',repo],{windowsHide:true});
const scopes=[['outside',data],['repo',repo],['parent',path.dirname(folder)],['start',folder]];
for(const [label,dir] of scopes){
 await fs.mkdir(path.join(dir,'.claude/agents'),{recursive:true});await fs.mkdir(path.join(dir,'.claude/skills','source-'+label),{recursive:true});await fs.mkdir(path.join(dir,'.claude/commands'),{recursive:true});
 await fs.writeFile(path.join(dir,'.claude/settings.json'),JSON.stringify({env:{['SOURCE_PROBE_'+label.toUpperCase()]:'enabled'},permissions:{allow:['Bash(echo source-'+label+')']}}));
 await fs.writeFile(path.join(dir,'.claude/agents','source-'+label+'.md'),`---\nname: source-agent-${label}\ndescription: Source inspection fixture\nmodel: haiku\n---\nDo no work.\n`);
 await fs.writeFile(path.join(dir,'.claude/skills','source-'+label,'SKILL.md'),`---\nname: source-skill-${label}\ndescription: Source inspection fixture\n---\nDo no work.\n`);
 await fs.writeFile(path.join(dir,'.claude/commands','source-'+label+'.md'),'---\ndescription: Source inspection fixture\n---\nDo no work.\n');
}
const evidence:any={data,repo,folder,version:cli.version};
const review=await inspectProjectTrust(folder);assert.equal(review.error,undefined);evidence.reviewedAgents=Object.keys(review.definitions||{}).filter(name=>name.startsWith('source-')).sort();
assert.deepEqual(evidence.reviewedAgents,(process.env.TRIS_NON_GIT==='1'?['outside','parent','repo','start']:['parent','repo','start']).map(scope=>'source-agent-'+scope));
for(const trustedProject of [false,true]){
 const session=await ClaudeSession.open({executable:cli.executable,python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:folder,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'haiku',effort:'low',mode:'manual',hasFolder:true,trustedProject,projectAgents:review.definitions,projectSettingsHash:review.sourceHash,signal:AbortSignal.timeout(30000),scrubber:new SecretScrubber(),event:()=>{},approve:async()=>false,prompt:''});
 try{const init=(session as any).initialized;evidence[trustedProject?'trusted':'untrusted']={agents:init.agents?.filter((v:any)=>v.name.startsWith('source-')),commands:init.commands?.filter((v:any)=>JSON.stringify(v).includes('source-')),keys:Object.keys(init)};}finally{await session.close();}
}
assert.deepEqual(evidence.untrusted.agents,[]);assert.deepEqual(evidence.untrusted.commands,[]);assert.deepEqual(evidence.trusted.agents.map((row:any)=>row.name).sort(),evidence.reviewedAgents);assert.deepEqual(evidence.trusted.commands.map((row:any)=>row.name).sort(),evidence.reviewedAgents.map((name:string)=>name.replace('source-agent-','source-skill-')));
await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(evidence,null,2));console.log('PASS real native project source discovery matches reviewed ancestor agents and skills; untrusted sources off. '+data);
