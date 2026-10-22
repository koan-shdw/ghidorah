// Runs the safe desktop tests one after another: on the source build, or on a packaged exe when TRISMEGISTUS_EXE is set.
// Usage: node scripts/desktop-tests.mjs [name ...]   (names without .e2e.ts; none = the whole safe set)
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {removeNew} from './work-cleanup.mjs';

// Real-account tests and tests that fetch unapproved third-party repositories stay excluded.
// requests-1oct fetches Unlazy and cursor/plugins; replace those downloads with fixtures before enabling it.
const NEVER=['claude','claude-usage','claude-modes','claude-memory','claude-plugins','mcp-claude','native-project-sources','native-worktree-sources','skills-conversion','pinned-plugins','requests-1oct'];
const LIMIT=8*60*1000,root=path.resolve(import.meta.dirname,'..'),logs=path.join(root,'work','desktop-tests',new Date().toISOString().replaceAll(':','-'));
// Adding a test requires reviewing its account, process and download behavior first.
const safe=JSON.parse(fs.readFileSync(path.join(root,'scripts','desktop-test-list.json'),'utf8')).filter(n=>!n.includes('live')&&!NEVER.includes(n)).sort();
const asked=process.argv.slice(2).map(n=>n.replace(/\.e2e\.ts$/,'').replace(/^tests[\\/]/,''));
const refused=asked.filter(n=>!safe.includes(n));
if(refused.length){console.error('Not in the safe set: '+refused.join(', '));process.exit(2);}
const names=asked.length?asked:safe;
fs.mkdirSync(logs,{recursive:true});
const fingerprint=()=>{
  const names=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root}).toString().split('\0').filter(Boolean);
  names.push('runtime/hermes-manifest.json');
  const files=Object.fromEntries([...new Set(names)].sort().filter(name=>fs.existsSync(path.join(root,name))&&fs.statSync(path.join(root,name)).isFile()).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
  return {head:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),files};
};
const source=fingerprint();
fs.writeFileSync(path.join(logs,'source.json'),JSON.stringify({node:process.version,executable:process.env.TRISMEGISTUS_EXE||null,tests:names,...source},null,2));
if(!process.env.TRISMEGISTUS_EXE)execFileSync(process.execPath,['scripts/build.mjs'],{cwd:root,stdio:'inherit'});
const summary=path.join(logs,'summary.txt');fs.writeFileSync(summary,'');
const line=text=>{console.log(text);fs.appendFileSync(summary,text+'\n');};
line(`${names.length} tests on ${process.env.TRISMEGISTUS_EXE||'the source build'}, ${new Date().toISOString()}`);

const run=name=>new Promise(resolve=>{
  const start=Date.now(),log=fs.createWriteStream(path.join(logs,name+'.log')),before=new Set(fs.readdirSync(path.join(root,'work')));
  const child=spawn(process.execPath,['--import','tsx',path.join('tests',name+'.e2e.ts')],{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.on('error',error=>log.write(String(error)+'\n'));
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}},LIMIT);
  child.on('close',code=>{clearTimeout(timer);log.end();const seconds=Math.round((Date.now()-start)/1000);const result=timedOut?'TIMEOUT':code===0?'PASS':'FAIL';if(result==='PASS')removeNew(path.join(root,'work'),before);resolve({name,result,seconds});});
});

const results=[];
for(const name of names){const r=await run(name);results.push(r);line(`${r.result.padEnd(7)} ${name} ${r.seconds}s`);}

// Most older tests leave their keys behind; a full Credential Manager fails every test with WinError 8.
// Only Trismegistus/Test/* names are enumerated and removed; real keys are never read or touched.
const python=path.join(root,'runtime','python','cpython-3.12.10-windows-x86_64-none','python.exe');
const sweep=`import ctypes,sys
from ctypes import wintypes as w
sys.path.insert(0,'backend')
import windows_credentials as v
api=ctypes.WinDLL('Advapi32',use_last_error=True)
api.CredEnumerateW.argtypes=[w.LPCWSTR,w.DWORD,ctypes.POINTER(w.DWORD),ctypes.POINTER(ctypes.POINTER(ctypes.POINTER(v.Credential)))]
api.CredFree.argtypes=[ctypes.c_void_p]
count=w.DWORD();items=ctypes.POINTER(ctypes.POINTER(v.Credential))();names=[]
if api.CredEnumerateW('Trismegistus/Test/*',0,ctypes.byref(count),ctypes.byref(items)):
    names=[items[i].contents.TargetName for i in range(count.value)];api.CredFree(items)
elif ctypes.get_last_error()!=1168: raise ctypes.WinError(ctypes.get_last_error())
for name in names:
    if name.startswith('Trismegistus/Test/'): v.delete(name)
print(len(names))`;
const removed=execFileSync(python,['-c',sweep],{cwd:root,windowsHide:true}).toString().trim();

const failed=results.filter(r=>r.result!=='PASS');
const changed=JSON.stringify(fingerprint())!==JSON.stringify(source);
if(changed)line('INVALID: source files changed during this run. Results do not certify one source state.');
line(`${results.length-failed.length} passed, ${failed.length} failed${failed.length?': '+failed.map(r=>r.name).join(', '):''}. ${Math.round(results.reduce((t,r)=>t+r.seconds,0)/60)} min. Removed ${removed} test keys. Logs in work/desktop-tests.`);
line('Evidence: '+logs);
process.exit(failed.length||changed?1:0);
