// Real native initialization only; no model prompt or paid request.
import fs from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
import {ClaudeSession,findClaude} from '../app/claude';import {SecretScrubber} from '../app/redaction';import {inspectProjectTrust} from '../app/project-trust';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/worktree-sources-native-')),main=path.join(data,'main'),tree=path.join(data,'tree'),folder=path.join(tree,'app'),cli=await findClaude();if(!cli)throw Error('CLI missing');
await fs.mkdir(main);const git=(...args:string[])=>execFileSync('git',['-C',main,...args],{windowsHide:true,stdio:'pipe'});git('init','-q');await fs.writeFile(path.join(main,'README.md'),'source fixture');git('add','README.md');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');git('worktree','add','--detach',tree,'HEAD');await fs.mkdir(folder);
for(const [kind,file,body] of [['skills','fallback/SKILL.md','---\nname: worktree-probe-fallback\ndescription: Main checkout skill\nallowed-tools: Bash\n---\n!`echo reviewed-fallback`\n'],['agents','fallback.md','---\nname: worktree-probe-agent\ndescription: Main checkout agent\n---\nDo no work.\n'],['commands','fallback.md','---\ndescription: Main checkout command\n---\nDo no work.\n']]){const target=path.join(main,'.claude',kind,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,body);}
const evidence:any={data,version:cli.version,modes:{}};
for(const mode of ['off','fallback','empty-skills','own-skills','empty-agents','own-agents']){
 if(mode==='empty-skills')await fs.mkdir(path.join(tree,'.claude/skills'),{recursive:true});
 if(mode==='own-skills'){const target=path.join(tree,'.claude/skills/own/SKILL.md');await fs.mkdir(path.dirname(target));await fs.writeFile(target,'---\nname: worktree-probe-local\ndescription: Worktree local skill\n---\nDo no work.\n');}
 if(mode==='empty-agents')await fs.mkdir(path.join(tree,'.claude/agents'));
 if(mode==='own-agents')await fs.writeFile(path.join(tree,'.claude/agents/own.md'),'---\nname: worktree-probe-local-agent\ndescription: Worktree local agent\n---\nDo no work.\n');
 const review=await inspectProjectTrust(folder);assert.equal(review.error,undefined);const session=await ClaudeSession.open({executable:cli.executable,python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:folder,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'haiku',effort:'low',mode:'manual',hasFolder:true,trustedProject:mode!=='off',signal:AbortSignal.timeout(30000),scrubber:new SecretScrubber(),event:()=>{},approve:async()=>false,prompt:''});
 try{const init=(session as any).initialized,agents=init.agents?.filter((v:any)=>v.name.startsWith('worktree-probe')).map((v:any)=>v.name).sort(),skills=init.commands?.filter((v:any)=>v.name.startsWith('worktree-probe')).map((v:any)=>v.name).sort();
  assert.deepEqual(agents,mode==='off'?[]:Object.keys(review.definitions||{}).sort());assert.deepEqual(skills,mode==='off'?[]:review.skills?.filter(s=>s.kind==='skill').map(s=>s.settings.name).sort());
  evidence.modes[mode]={reviewedSkills:review.skills?.map(s=>s.path),reviewedAgents:review.agents?.map(a=>a.path),nativeAgents:agents,nativeSkills:skills};
 }finally{await session.close();}
}
await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(evidence,null,2));console.log('PASS real native worktree fallback, independent local skills/agents and sources off match review. '+data);
