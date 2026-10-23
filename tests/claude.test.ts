import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeSession,claudeEnvironment,protectedClaudeAction,protectedClaudeTool,claudeSettings,nativePlanFile} from '../app/claude';
import {SecretScrubber} from '../app/redaction';
import fs from 'node:fs/promises';
import path from 'node:path';

test('native file checks inspect destinations, not source text mentioning credentials',async()=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'work/permission-path-')),privateRoot=path.join(directory,'private');
  for(const name of ['Write','Edit','MultiEdit','NotebookEdit'])assert.equal(await protectedClaudeTool({file_path:'verify.js',content:'process.env.TEMP // auth.json',new_string:'auth.json'},privateRoot,directory,undefined,name),false);
  assert.equal(await protectedClaudeTool({file_path:'auth.json',content:'ordinary'},privateRoot,directory,undefined,'Write'),true);
  assert.equal(await protectedClaudeTool({command:'cat auth.json'},privateRoot,directory,undefined,'Bash'),true);
});

test('native Plan permits only Markdown documents in its owned folder, never a redirected target',async()=>{
  const root=await fs.mkdtemp(path.join(process.cwd(),'work/plan-path-')),plans=path.join(root,'plans'),outside=path.join(root,'outside'),file=path.join(plans,'proposal.md');await fs.mkdir(plans);await fs.mkdir(outside);
  assert.equal(await nativePlanFile('Write',{file_path:file},plans),true);
  assert.equal(await nativePlanFile('Edit',{file_path:file},plans),true);
  for(const [name,target] of [['Write',path.join(outside,'proposal.md')],['Write',path.join(plans,'command.ps1')],['Write',path.join(plans,'sub','proposal.md')],['Bash',file]])assert.equal(await nativePlanFile(name,{file_path:target},plans),false);
  await fs.rmdir(plans);await fs.symlink(outside,plans,process.platform==='win32'?'junction':'dir');assert.equal(await nativePlanFile('Write',{file_path:file},plans),false);
});

test('Claude inherits only OS essentials, never provider keys, alternate endpoints or Node options',()=>{
  const env=claudeEnvironment({Path:'C:\\tools',USERPROFILE:'C:\\Users\\fixture',ANTHROPIC_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'secret',ANTHROPIC_BASE_URL:'https://wrong.invalid',DEEPSEEK_API_KEY:'secret',JEV_API_KEY:'secret',NODE_OPTIONS:'--require bad.js',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'0',PYTHONDONTWRITEBYTECODE:'0'});
  assert.deepEqual(env,{PATH:'C:\\tools',USERPROFILE:'C:\\Users\\fixture',PYTHONDONTWRITEBYTECODE:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',PSExecutionPolicyPreference:'Bypass'});
});
test('Claude fixed protection catches credential paths and stores independently of permission mode',()=>{
  const root='C:\\Users\\fixture\\AppData\\Local\\Trismegistus';
  for(const input of [{file_path:'C:\\Users\\fixture\\.claude\\credentials.json'},{command:'cmdkey /list'},{command:'security find-generic-password'},{file_path:root+'\\hermes\\auth.json'}])assert.equal(protectedClaudeAction(input,root),true);
  assert.equal(protectedClaudeAction({file_path:'C:\\Projects\\readme.md'},root),false);
  assert.ok(claudeSettings(root).permissions.deny.includes('Read(~/.claude/**)'));
});

test('the data folder guard covers the folder and what is in it, never a sibling whose name starts the same (TRIS-TODO 0.14: Trismegistus2)',()=>{
  const root='C:\\Users\\fixture\\AppData\\Local\\Trismegistus';
  for(const input of [{directory:root},{file_path:root+'\\chat.sqlite'},{command:'cd "'+root+'" && dir'},{command:'type '+root+'\\queue.log'},{command:'dir '+root}])assert.equal(protectedClaudeAction(input,root),true,JSON.stringify(input));
  for(const input of [{directory:root+'2'},{file_path:root+'2\\notes.md'},{directory:root+'-old\\x'},{command:'dir '+root+'Backup'}])assert.equal(protectedClaudeAction(input,root),false,JSON.stringify(input));
});

test('Opus gets the fixed rules and memory block once per session, again only when it changes (Koan, 2026-10-08)',async()=>{
  const scrubber=new SecretScrubber(),base:any={model:'opus',scrubber,event:()=>{},signal:new AbortController().signal,mode:'default'},session:any=new (ClaudeSession as any)(base);
  const sent:any[]=[];session.initial=base;session.send=(m:any)=>sent.push(m);session.setMode=async()=>{};session.command=async()=>({});session.model='opus';
  let n=0;const run=(memory:string)=>{void session.submit({...base,turnId:'message-'+(n++),prompt:'Next',projectMemory:memory}).catch(()=>{});return new Promise(setImmediate);};
  await run('RULES+MEMORY v1');await run('RULES+MEMORY v1');await run('RULES+MEMORY v2');
  const blocks=sent.map(m=>m.message.content.length);
  assert.deepEqual(blocks,[2,1,2],'first turn and changed memory carry the block; an unchanged one does not');
});

test('a Claude model switch reuses the live session; other chats keep their idle sessions (Koan, 2026-10-08)',async()=>{
  const {NativeSessions}=await import('../app/native-sessions');
  const sessions:any=new NativeSessions({} as any,{} as any,()=>{});let closed=0;
  const live=(id:string)=>({id,sessionId:id,live:true,hasPendingWork:false,compatible:()=>true,close:async()=>{closed++;}});
  sessions.runtimes.set('a',{chatId:'chat-a',model:'opus',session:live('a')});sessions.runtimes.set('b',{chatId:'chat-b',model:'opus',session:live('b')});
  const picked=await sessions.acquire({id:'chat-a'},{sessionId:'a',model:'sonnet'},()=>{throw Error('no reseed expected');});
  assert.equal(picked.session.id,'a');assert.equal(sessions.runtimes.get('a').model,'sonnet');assert.equal(closed,0,'chat-b stays warm');
});
