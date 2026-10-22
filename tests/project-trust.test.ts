import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {inspectProjectTrust,projectSkillFolders} from '../app/project-trust';
import {execFileSync} from 'node:child_process';

test('skill-folder plugins review and fingerprint their complete bundle and declared hook commands',async()=>{
 const root=await fs.mkdtemp(path.resolve('work','skill-plugin-trust-')),plugin=path.join(root,'.claude/skills/bundle');for(const dir of ['.claude-plugin','hooks','agents'])await fs.mkdir(path.join(plugin,dir),{recursive:true});execFileSync('git',['init','-q',root],{windowsHide:true});
 await fs.writeFile(path.join(plugin,'.claude-plugin/plugin.json'),JSON.stringify({name:'bundle',hooks:'./custom-hooks.json'}));await fs.writeFile(path.join(plugin,'SKILL.md'),'---\nname: bundle\n---\nDo the requested work.\n');
 const command='node "${CLAUDE_PLUGIN_ROOT}/hook.cjs"';await fs.writeFile(path.join(plugin,'hooks/hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command}]}]}}));await fs.writeFile(path.join(plugin,'custom-hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'echo custom-hook'}]}]}}));await fs.writeFile(path.join(plugin,'hook.cjs'),'console.log("{}");');
 const agent=path.join(plugin,'agents/worker.md');await fs.writeFile(agent,'---\nname: worker\ndescription: Plugin agent\npermissionMode: default\n---\n');
 const first=await inspectProjectTrust(root);assert.equal(first.error,undefined);assert.equal(first.skills?.filter(s=>s.kind==='plugin').length,1);assert.equal(first.skills?.find(s=>s.kind==='plugin')?.settings.manifest.name,'bundle');assert.deepEqual(first.commands,[command,'echo custom-hook']);assert.equal(first.reviewEveryRun,true);assert.equal(first.files[0].path,path.join(plugin,'hook.cjs'));assert.notEqual(first.files[0].hash,'unavailable');assert.deepEqual(Object.keys(first.definitions||{}),[],'native plugin agent loading stays native');
 await fs.writeFile(agent,'---\nname: worker\ndescription: Plugin agent\npermissionMode: acceptEdits\n---\n');assert.notEqual((await inspectProjectTrust(root)).hash,first.hash);
 await fs.writeFile(path.join(plugin,'dependency.cjs'),'console.log("dependency")');const dependency=await inspectProjectTrust(root);await fs.writeFile(path.join(plugin,'dependency.cjs'),'console.log("changed dependency")');assert.notEqual((await inspectProjectTrust(root)).hash,dependency.hash);
});

test('linked worktrees review main-checkout definition fallbacks independently of local settings',async()=>{
 const data=await fs.mkdtemp(path.resolve('work','worktree-trust-')),main=path.join(data,'main'),tree=path.join(data,'tree'),root=path.join(tree,'app');await fs.mkdir(main);
 const git=(...args:string[])=>execFileSync('git',['-C',main,...args],{windowsHide:true,stdio:'pipe'});git('init','-q');await fs.writeFile(path.join(main,'README.md'),'fixture');git('add','README.md');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');git('worktree','add','--detach',tree,'HEAD');await fs.mkdir(root);
 for(const dir of ['skills/check','agents','commands'])await fs.mkdir(path.join(main,'.claude',dir),{recursive:true});await fs.writeFile(path.join(main,'.claude/settings.json'),'{"permissions":{"allow":["Bash"]}}');
 const script=path.join(main,'hook.cjs'),skill=path.join(main,'.claude/skills/check/SKILL.md');await fs.writeFile(script,'console.log("one")');await fs.writeFile(skill,'---\nname: fallback\nallowed-tools: Bash\n---\n!`node "'+script.replaceAll('\\','/')+'"`\n');
 await fs.writeFile(path.join(main,'.claude/agents/worker.md'),'---\nname: worker\ndescription: Main worker\npermissionMode: acceptEdits\n---\n');await fs.writeFile(path.join(main,'.claude/commands/legacy.md'),'---\nallowed-tools: Read\n---\n');
 const first=await inspectProjectTrust(root);assert.equal(first.error,undefined);assert.deepEqual(first.settings,{});assert.equal(first.skills?.length,2);assert.equal(first.agents?.length,1);assert.equal(first.definitions?.worker.permissionMode,'acceptEdits');assert.equal(first.files[0].path,script);assert.notEqual(first.files[0].hash,'unavailable');assert.deepEqual(await projectSkillFolders('Read',{file_path:'file.txt'},root),[tree]);assert.equal((await inspectProjectTrust(root,[tree])).sourceHash,first.sourceHash);
 await fs.writeFile(script,'console.log("two")');assert.notEqual((await inspectProjectTrust(root)).hash,first.hash);
 await fs.mkdir(path.join(root,'.claude/agents'),{recursive:true});await fs.writeFile(path.join(root,'.claude/agents/worker.md'),'---\nname: worker\ndescription: Local worker\npermissionMode: default\n---\n');const nested=await inspectProjectTrust(root);assert.equal(nested.agents?.length,2);assert.equal(nested.definitions?.worker.permissionMode,'default');
 await fs.mkdir(path.join(tree,'.claude/skills'),{recursive:true});const ownSkills=await inspectProjectTrust(root);assert.equal(ownSkills.skills?.length,1);assert.equal(ownSkills.skills?.[0].kind,'command');assert.equal(ownSkills.agents?.length,2);
 await fs.mkdir(path.join(tree,'.claude/agents'));await fs.mkdir(path.join(tree,'.claude/commands'));const own=await inspectProjectTrust(root);assert.equal(own.skills?.length,0);assert.equal(own.agents?.length,1);assert.deepEqual(own.settings,{});
 assert.equal((await inspectProjectTrust(root,[path.join(tree,'removed')])).error,undefined);
 const extra=await inspectProjectTrust(main,[tree]);assert.equal(extra.skills?.length,2,'empty worktree source must not duplicate the main definitions');
});

test('file discovery extends only skill sources and retains the starting settings and agent scope',async()=>{
 const root=await fs.mkdtemp(path.resolve('work','lazy-trust-')),nested=path.join(root,'app'),skills=path.join(nested,'.claude/skills/check');await fs.mkdir(skills,{recursive:true});await fs.mkdir(path.join(root,'.claude'));await fs.mkdir(path.join(nested,'.claude/agents'));execFileSync('git',['init','-q',root],{windowsHide:true});
 await fs.writeFile(path.join(root,'.claude/settings.json'),'{}');await fs.writeFile(path.join(nested,'.claude/settings.json'),'{"permissions":{"allow":["Bash"]}}');await fs.writeFile(path.join(nested,'.claude/agents/new.md'),'---\nname: new-agent\ndescription: Not an active ancestor agent\n---\n');await fs.writeFile(path.join(skills,'SKILL.md'),'---\nname: check\nallowed-tools: Bash\n---\n!`echo nested`\n');
 const before=await inspectProjectTrust(root);assert.equal(before.skills?.length,0);
 const folders=await projectSkillFolders('Write',{file_path:'app/new-folder/file.txt'},root);assert.deepEqual(folders,[nested]);const after=await inspectProjectTrust(root,folders);
 assert.equal(after.error,undefined);assert.equal(after.skills?.length,1);assert.deepEqual(after.settings,{});assert.equal(after.agents?.length,0);assert.notEqual(after.sourceHash,before.sourceHash);assert.deepEqual(after.skillFolders,[nested]);assert.deepEqual(after.commands,['echo nested']);
 assert.deepEqual(await projectSkillFolders('Bash',{command:'echo app/trigger.txt'},root),[]);assert.equal((await inspectProjectTrust(root,[...folders,...folders])).sourceHash,after.sourceHash);
});

test('review matches repository ancestors, nearest agent override and skill executable sources',async()=>{
 const outer=await fs.mkdtemp(path.resolve('work','source-trust-')),repo=path.join(outer,'repo'),root=path.join(repo,'packages/app');await fs.mkdir(root,{recursive:true});execFileSync('git',['init','-q',repo],{windowsHide:true});
 for(const dir of [outer,repo,root]){await fs.mkdir(path.join(dir,'.claude/agents'),{recursive:true});await fs.writeFile(path.join(dir,'.claude/settings.json'),JSON.stringify({permissions:{allow:[dir===root?'Read':'Bash']}}));await fs.writeFile(path.join(dir,'.claude/agents/worker.md'),`---\nname: worker\ndescription: Worker\npermissionMode: ${dir===root?'default':'acceptEdits'}\n---\nSource ${dir}\n`);}
 const skill=path.join(repo,'.claude/skills/build');await fs.mkdir(skill,{recursive:true});const file=path.join(skill,'SKILL.md'),script=path.join(skill,'hook.cjs');await fs.writeFile(script,'console.log("ready")');
 const write=(body='Build the requested project.',tool='Read')=>fs.writeFile(file,'---\nname: build\ndescription: Build\nallowed-tools: '+tool+'\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: node "${CLAUDE_SKILL_DIR}/hook.cjs"\n---\n'+body+'\n!`node "${CLAUDE_SKILL_DIR}/hook.cjs"`\n');await write();
 const first=await inspectProjectTrust(root);assert.equal(first.error,undefined);assert.deepEqual(first.settings,{permissions:{allow:['Read']}});assert.equal(first.agents?.length,2);assert.equal(first.definitions?.worker.permissionMode,'default');assert.equal(first.skills?.length,1);assert.ok(first.files.every(row=>row.path===script&&row.hash!=='unavailable'));assert.equal(first.commands.length,2);assert.equal(first.reviewEveryRun,true);
 await write('Different prose.');const prose=await inspectProjectTrust(root);assert.equal(prose.hash,first.hash);assert.notEqual(prose.sourceHash,first.sourceHash);
 await write('Different prose.','Write');assert.notEqual((await inspectProjectTrust(root)).hash,first.hash);await write();await fs.writeFile(script,'console.log("changed")');assert.notEqual((await inspectProjectTrust(root)).hash,first.hash);
 const beforeOutside=await inspectProjectTrust(root);await fs.writeFile(path.join(outer,'.claude/agents/worker.md'),'---\nname: outside\npermissionMode: bypassPermissions\n---\n');assert.equal((await inspectProjectTrust(root)).sourceHash,beforeOutside.sourceHash);
 const base=await fs.mkdtemp(path.resolve('work','source-link-'));await fs.symlink(base,path.join(skill,'linked'),'junction');assert.equal((await inspectProjectTrust(root)).hash,'');
});

test('project trust ignores preferences, detects expanded access and fingerprints invoked scripts',async()=>{
  const root=await fs.mkdtemp(path.resolve('work','trust-'));await fs.mkdir(path.join(root,'.claude'));
  const file=path.join(root,'.claude','settings.json');
  const settings:any={theme:'dark',permissions:{allow:['Read']}};
  await fs.writeFile(file,JSON.stringify(settings));const first=await inspectProjectTrust(root);
  settings.theme='light';await fs.writeFile(file,JSON.stringify(settings));assert.equal((await inspectProjectTrust(root)).hash,first.hash);
  settings.permissions.allow.push('Bash');await fs.writeFile(file,JSON.stringify(settings));assert.notEqual((await inspectProjectTrust(root)).hash,first.hash);
  settings.hooks={SessionStart:[{hooks:[{type:'command',command:'python "hook.py"'}]}]};await fs.writeFile(file,JSON.stringify(settings));
  await fs.writeFile(path.join(root,'hook.py'),'print("first")');const hook=await inspectProjectTrust(root);
  assert.deepEqual(hook.commands,['python "hook.py"']);assert.equal(hook.files.length,1);assert.equal(hook.reviewEveryRun,true);
  await fs.writeFile(path.join(root,'hook.py'),'print("changed")');assert.notEqual((await inspectProjectTrust(root)).hash,hook.hash);
  settings.env={ANTHROPIC_API_KEY:'synthetic-fixture'};await fs.writeFile(file,JSON.stringify(settings));assert.match((await inspectProjectTrust(root)).error!,/connection/);
});

test('custom agent access and hook scripts require review; prose changes reload without granting new access',async()=>{
 const root=await fs.mkdtemp(path.resolve('work','agent-trust-')),dir=path.join(root,'.claude/agents/nested');await fs.mkdir(dir,{recursive:true});
 const agent=path.join(dir,'worker.md'),write=(mode='default',body='Perform the requested work.')=>fs.writeFile(agent,`---\nname: worker\ndescription: Project worker\npermissionMode: ${mode}\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: node hook.cjs\n---\n${body}\n`);
 await fs.writeFile(path.join(root,'hook.cjs'),'console.log("first")');await write();const first=await inspectProjectTrust(root);
 assert.equal(first.error,undefined);assert.equal(first.agents?.[0].settings.permissionMode,'default');assert.deepEqual(first.commands,['node hook.cjs']);assert.equal(first.reviewEveryRun,true);assert.equal(first.files.length,1);
 await write('default','Updated task instructions.');const prose=await inspectProjectTrust(root);assert.equal(prose.hash,first.hash);assert.notEqual(prose.sourceHash,first.sourceHash);
 await write('acceptEdits');assert.notEqual((await inspectProjectTrust(root)).hash,first.hash);
 await write();await fs.writeFile(path.join(root,'hook.cjs'),'console.log("changed")');assert.notEqual((await inspectProjectTrust(root)).hash,first.hash);
 await fs.writeFile(agent,'---\nname: cyclic\nhooks: &loop\n  child: *loop\n---\n');assert.match((await inspectProjectTrust(root)).error!,/agent definitions/);
 await fs.writeFile(agent,'---\nname: invalid\nhooks: [\n---\n');assert.equal((await inspectProjectTrust(root)).hash,'');
 await write();const external=await fs.mkdtemp(path.resolve('work','agent-external-'));await fs.symlink(external,path.join(dir,'linked'),'junction');assert.equal((await inspectProjectTrust(root)).hash,'');
});
