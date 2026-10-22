import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runtimeListing,checkRuntimeOnChange,ChangeGate} from '../app/native-plugins';
import {nativePluginCatalog,reviewNativePlugin,installNativePlugin,nativePluginDirectories,reviewHermesPlugin,hermesPluginCopies,pluginCommand,pluginServer,sharedCommands} from '../app/native-plugins';

test('native plugin import fixes reviewed contents, rejects changes and links, and can replace a damaged snapshot',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trismegistus-plugin-')),source=path.join(root,'plugins/cache/example/version'),snapshots=path.join(root,'snapshots');
 await fs.mkdir(path.join(source,'.claude-plugin'),{recursive:true});await fs.mkdir(path.join(source,'skills','hello'),{recursive:true});
 await fs.writeFile(path.join(source,'.claude-plugin/plugin.json'),JSON.stringify({name:'example',version:'1'}));
 await fs.writeFile(path.join(source,'skills/hello/SKILL.md'),'approved contents');
 await fs.writeFile(path.join(root,'plugins/installed_plugins.json'),JSON.stringify({plugins:{'example@local':[{scope:'user',installPath:source,version:'1',gitCommitSha:'a'.repeat(40)}]}}));
 const [row]=await nativePluginCatalog(root);const review=await reviewNativePlugin(row);assert.equal(review.commit,'a'.repeat(40));assert.equal(review.skills,true);
 await fs.writeFile(path.join(source,'skills/hello/SKILL.md'),'changed');await assert.rejects(installNativePlugin(review,snapshots),/changed/);
 await fs.writeFile(path.join(source,'skills/hello/SKILL.md'),'approved contents');const installed=await installNativePlugin(review,snapshots);
 await fs.writeFile(path.join(source,'skills/hello/SKILL.md'),'external update');assert.deepEqual(await nativePluginDirectories([installed],snapshots),[installed.directory]);
 assert.equal(await fs.readFile(path.join(installed.directory,'skills/hello/SKILL.md'),'utf8'),'approved contents');
 await fs.writeFile(path.join(installed.directory,'skills/hello/SKILL.md'),'tampered');await assert.rejects(nativePluginDirectories([installed],snapshots),/changed/);assert.deepEqual(await nativePluginDirectories([{...installed,enabled:false}],snapshots),[]);
 const fresh=await installNativePlugin(await reviewNativePlugin(row),snapshots);assert.deepEqual(await nativePluginDirectories([fresh],snapshots),[fresh.directory]);
 await fs.symlink(snapshots,path.join(source,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(reviewNativePlugin(row),/links/);
});

test('converted commands preserve literal arguments and immutable roots; servers remain reviewable data',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trismegistus-converted-')),source=path.join(root,'source'),snapshots=path.join(root,'snapshots');
 await fs.mkdir(path.join(source,'source'),{recursive:true});
 await fs.writeFile(path.join(source,'source/command.md'),'---\ndescription: Fixture\n---\nRoot ${CLAUDE_PLUGIN_ROOT}\n$ARGUMENTS');
 const conversion={kind:'claude',skills:[],commands:[{name:'run',path:'source/command.md',description:''}],servers:[{name:'local',config:{command:'python',args:['${CLAUDE_PLUGIN_ROOT}/server.py'],env:{TOKEN:'${NEEDS_VALUE}'}}}],unsupported:[]};
 const metadata={source,commit:'a'.repeat(40),repository:'owner/repo',name:'example',version:'1',description:'',native:true,nativeSubdir:'source',conversion,hooks:false,prerequisites:[],scan:{verdict:'safe',findings:[]}};
 const installed=await installNativePlugin(await reviewHermesPlugin(metadata),snapshots);
 assert.deepEqual(sharedCommands([installed]),[{name:'/example:run',description:'',plugin:'example',kind:'Command'}]);
 assert.deepEqual(sharedCommands([{...installed,enabled:false},{...installed,conversion:undefined}]),[]);
 assert.deepEqual(await nativePluginDirectories([installed],snapshots),[path.join(installed.directory,'source')]);
 const invocation='/example:run literal $& $` $1\nsecond line';
 const expanded=await pluginCommand(invocation,[installed],snapshots);
 assert.ok(expanded.endsWith('literal $& $` $1\nsecond line'));assert.ok(expanded.includes(path.join(installed.directory,'source')));assert.doesNotMatch(expanded,/description: Fixture/);
 assert.equal(await pluginCommand(invocation,[{...installed,enabled:false}],snapshots),invocation);
 const server=await pluginServer([installed],snapshots,0);assert.deepEqual(server.config.args,[path.join(installed.directory,'source')+'/server.py']);assert.equal(server.config.env.TOKEN,'${NEEDS_VALUE}');
 await assert.rejects(pluginServer([{...installed,enabled:false}],snapshots,0),/Enable/);
 await fs.appendFile(path.join(installed.directory,'source/command.md'),'changed');await assert.rejects(pluginCommand(invocation,[installed],snapshots),/changed/);
});

test('Hermes copies remain separate, detect profile tampering and permit a newly reviewed replacement',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trismegistus-pinned-')),source=path.join(root,'source'),snapshots=path.join(root,'snapshots');await fs.mkdir(source);
 await fs.writeFile(path.join(source,'plugin.yaml'),'name: example');await fs.writeFile(path.join(source,'__init__.py'),'# fixed contents');
 const metadata={source,commit:'a'.repeat(40),repository:'owner/repo',name:'example',version:'1',description:'',hooks:false,prerequisites:[],scan:{verdict:'safe',findings:[]}};
 const review=await reviewHermesPlugin(metadata),installed=await installNativePlugin(review,snapshots),a=path.join(root,'profile-a'),b=path.join(root,'profile-b');
 assert.deepEqual(await nativePluginDirectories([installed],snapshots),[]);
 const [key]=await hermesPluginCopies([installed],a,true);await hermesPluginCopies([installed],b,true);
 await fs.writeFile(path.join(a,'plugins',key,'__init__.py'),'# tampered profile');await assert.rejects(hermesPluginCopies([installed],a),/changed in this project/);await hermesPluginCopies([installed],b);
 const fresh=await installNativePlugin(review,snapshots);assert.notEqual((await hermesPluginCopies([fresh],a,true))[0],key);
 await assert.rejects(installNativePlugin({...review,hermes:{prerequisites:[],scan:{verdict:'dangerous',findings:[]}}},snapshots),/findings/);
 await assert.rejects(installNativePlugin({...review,hermes:{prerequisites:['requires dependency'],scan:{verdict:'safe',findings:[]}}},snapshots),/findings/);
});

// TRIS-TODO 1.11: the plugin runtime (his: 300 MB, 3,040 files, about 3 s to hash) is checked in full only when its
// file listing changes, not before every GPT message.
test('the plugin runtime is checked in full only when its files change',async()=>{
 await fs.mkdir('work',{recursive:true});const dir=await fs.mkdtemp(path.resolve('work','unit-runtime-'));
 try{
  await fs.mkdir(path.join(dir,'pkg'));await fs.writeFile(path.join(dir,'pkg','a.py'),'a = 1');await fs.writeFile(path.join(dir,'b.pyd'),'bin');
  const first=await runtimeListing(dir);
  assert.equal(first,await runtimeListing(dir),'the same files give the same listing');
  assert.match(first,/pkg\/a\.py:5:/);
  await fs.writeFile(path.join(dir,'pkg','a.py'),'a = 22');assert.notEqual(await runtimeListing(dir),first,'a changed size');
  const sized=await runtimeListing(dir);await fs.utimes(path.join(dir,'b.pyd'),new Date(2001,1,1),new Date(2001,1,1));assert.notEqual(await runtimeListing(dir),sized,'a changed time');
  const timed=await runtimeListing(dir);await fs.mkdir(path.join(dir,'pkg','__pycache__'));await fs.writeFile(path.join(dir,'pkg','__pycache__','a.cpython-312.pyc'),'x');assert.notEqual(await runtimeListing(dir),timed,'a new bytecode file');
  let checks=0;const cache={};const runtime={directory:dir,hash:'h1'},check=async()=>{checks++;await fs.rm(path.join(dir,'pkg','__pycache__'),{recursive:true,force:true});};
  await checkRuntimeOnChange(cache,runtime,check);assert.equal(checks,1,'the first message checks in full');
  await checkRuntimeOnChange(cache,runtime,check);await checkRuntimeOnChange(cache,runtime,check);assert.equal(checks,1,'then nothing changed, nothing is hashed');
  await fs.writeFile(path.join(dir,'c.py'),'new');await checkRuntimeOnChange(cache,runtime,check);assert.equal(checks,2,'a new file: in full again');
  await checkRuntimeOnChange(cache,{directory:dir,hash:'h2'},check);assert.equal(checks,3,'a new reviewed runtime: in full again');
  await assert.rejects(checkRuntimeOnChange({},runtime,async()=>{throw Error('Plugin dependencies changed or are missing.');}),/changed or are missing/,'a failed check still fails the message');
  const failed:any={};await checkRuntimeOnChange(failed,runtime,async()=>{throw Error('x');}).catch(()=>{});assert.equal(failed.listing,undefined,'a failed check is not remembered');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

// 10-13..20: the plugin checks cost about 1.6 s per GPT message though nothing changed.
test('a plugin check is skipped while its folder and inputs are unchanged',async()=>{
 await fs.mkdir('work',{recursive:true});const dir=await fs.mkdtemp(path.resolve('work','unit-gate-')),gate=new ChangeGate();
 const settle=async(until:()=>boolean)=>{for(let n=0;n<40&&!until();n++)await new Promise(resolve=>setTimeout(resolve,50));};
 try{
  assert.equal(gate.quiet('files',[dir],'v1'),false,'the first message checks');gate.pass('files','v1');
  assert.equal(gate.quiet('files',[dir],'v1'),true,'then nothing changed: skipped');
  await fs.writeFile(path.join(dir,'plugin.py'),'changed');let quiet=true;await settle(()=>!(quiet=gate.quiet('files',[dir],'v1')));
  assert.equal(quiet,false,'a write to the folder: checked again');gate.pass('files','v1');
  assert.equal(gate.quiet('files',[dir],'v2'),false,'new inputs (a plugin enabled, a new Hermes start): checked again');
  assert.equal(gate.quiet('files',[dir],'v2'),false,'a check that did not pass is never remembered');
  assert.equal(gate.quiet('gone',[path.join(dir,'missing')],'v1'),false);gate.pass('gone','v1');
  assert.equal(gate.quiet('gone',[path.join(dir,'missing')],'v1'),false,'a folder that cannot be watched is checked every time');
 }finally{gate.close();await fs.rm(dir,{recursive:true,force:true});}
});
