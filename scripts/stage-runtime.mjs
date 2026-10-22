import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rename,writeFile,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const roots=new Set(['acp_adapter','agent','assets','cron','gateway','hermes_cli','hermes_platform','locales','native','plugins','providers','scripts','skills','tools','tui_gateway']);
const eligible=file=>!file.includes('__pycache__')&&!file.endsWith('.pyc')&&(roots.has(file.split('/')[0])||(!file.includes('/')&&(/\.(py|json|toml|lock)$/.test(file)||['LICENSE','README.md'].includes(file))));

// Hermes is the Git repository at `fork`, or its `folder` (hermes/ inside Ghidorah's own repository).
export async function stageRuntime(appRoot,fork,folder=''){
  appRoot=path.resolve(appRoot);fork=path.resolve(fork);
  const git=(args,options={})=>execFileSync('git',args,{cwd:fork,windowsHide:true,maxBuffer:32*1024*1024,...options});
  const pin=git(['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  // Stage commit objects, never working-tree or untracked contents.
  try{git(['diff','--quiet',pin,'--',folder||'.']);}catch{throw Error('Commit or restore tracked Hermes changes before staging its runtime.');}
  const files=git(['ls-tree','-rz',folder?pin+':'+folder:pin],{encoding:'utf8'}).split('\0').filter(Boolean).map(row=>{
    const [meta,file]=row.split('\t'),[mode,type,oid]=meta.split(' ');return {mode,type,oid,file};
  }).filter(row=>eligible(row.file));
  for(const {mode,type,file} of files){
    if(type!=='blob'||!['100644','100755'].includes(mode)||file.split('/').some(part=>!part||part==='..')||file.includes('\\')||file.includes(':'))throw Error('Unsupported runtime entry: '+file);
  }
  const runtime=path.join(appRoot,'runtime'),work=path.join(appRoot,'work');
  await mkdir(runtime,{recursive:true});await mkdir(work,{recursive:true});
  // Refuse junctions before moving runtime directories on Windows.
  for(const directory of [runtime,work,path.join(runtime,'hermes')]){
    const entry=await lstat(directory).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(entry&&(!entry.isDirectory()||entry.isSymbolicLink()))throw Error('Runtime staging requires a real directory: '+directory);
  }
  const saved=await mkdtemp(path.join(work,'stage-runtime-')),staged=path.join(saved,'next'),target=path.join(runtime,'hermes'),previous=path.join(saved,'previous');
  await mkdir(staged);const hashes={};
  for(let start=0;start<files.length;start+=128){
    const batch=files.slice(start,start+128),data=git(['cat-file','--batch'],{input:batch.map(row=>row.oid+'\n').join(''),maxBuffer:128*1024*1024});
    let offset=0;
    for(const row of batch){
      const end=data.indexOf(10,offset),[oid,type,length]=data.subarray(offset,end).toString().split(' '),size=Number(length);
      if(end<offset||oid!==row.oid||type!=='blob'||!Number.isSafeInteger(size)||size<0||end+size+1>=data.length||data[end+size+1]!==10)throw Error('Invalid Git object: '+row.file);
      const bytes=data.subarray(end+1,end+1+size),destination=path.join(staged,...row.file.split('/'));
      await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes);
      hashes[row.file]=createHash('sha256').update(bytes).digest('hex');offset=end+size+2;
    }
    if(offset!==data.length)throw Error('Unexpected Git object data');
  }
  const manifest={upstream:'f97608f178d1ffeca59860195ab7da295f7c8e5f',upstreamTag:'v2026.9.24',upstreamVersion:'0.21.5',upstreamPublished:'2026-09-24T10:09:38Z',fork:pin,files:hashes};
  await writeFile(path.join(saved,'manifest.json'),JSON.stringify(manifest,null,2));
  const oldManifest=await readFile(path.join(runtime,'hermes-manifest.json')).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if(oldManifest)await writeFile(path.join(saved,'previous-manifest.json'),oldManifest);
  let moved=false,installed=false;
  try{
    try{await rename(target,previous);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    await rename(staged,target);installed=true;
    await rename(path.join(saved,'manifest.json'),path.join(runtime,'hermes-manifest.json'));
  }catch(error){
    if(installed)await rename(target,staged);
    if(moved)await rename(previous,target);
    throw error;
  }
  console.log(`Staged ${files.length} Hermes runtime files from ${pin}; previous runtime retained in ${saved}`);
  return manifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const root=path.resolve(import.meta.dirname,'..');
  try{await stageRuntime(root,root,'hermes');}
  catch(error){console.error(error.stack||error.message);process.exitCode=1;}
}
