import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

// The current commit, read from .git without running Git. Null when the folder is not a Git checkout.
export async function gitHead(root:string):Promise<string|null>{
 try{
  const head=(await fs.readFile(path.join(root,'.git','HEAD'),'utf8')).trim();
  const ref=/^ref: (.+)$/.exec(head)?.[1];if(!ref)return head||null;
  try{return (await fs.readFile(path.join(root,'.git',ref),'utf8')).trim();}
  catch{const packed=await fs.readFile(path.join(root,'.git','packed-refs'),'utf8');return packed.split(/\r?\n/).find(line=>line.endsWith(' '+ref))?.split(' ')[0]||null;}
 }catch{return null;}
}

export interface MapSymbol {name:string;kind:string;line:number;endLine:number;signature:string;}
export interface MapFile {path:string;hash:string;bytes:number;lines:number;status:string;symbols:MapSymbol[];imports:{specifier:string|null;line:number}[];}
export interface RepositoryMap {schema:number;repo:string;generatedAt:string;fingerprint:string;partial:boolean;scope:string;files:MapFile[];edges:{from:string;to:string;line:number;kind:string}[];unresolved:{from:string;line:number;specifier:string;reason:string}[];issues:{path:string;reason:string}[];claims:{kind:string;text:string;status:string;evidence:{path:string;line:number;hash:string}[]}[];notesError:string;stats:{parsed:number;reused:number;bytes:number;milliseconds:number};}

// Run the portable engine outside Electron's main event loop. No server or model calls.
export class RepoMaps {
 private jobs=new Map<string,Promise<RepositoryMap>>();
 constructor(private cli:string,private python:string){}
 // Koan, 2026-10-06: the map rebuilds only when the repo gets a new commit (or the refresh button forces it).
 // The commit it was built from is kept beside the engine's own saved index; a folder without Git builds once.
 async refresh(root:string,force=false):Promise<RepositoryMap>{
  const real=await fs.realpath(root),pending=this.jobs.get(real);if(pending)return pending;
  const head=(await gitHead(real))||'no-git',stamp=path.join(real,'.repo-map','head.txt');
  if(!force)try{
   if((await fs.readFile(stamp,'utf8')).trim()===head){
    const saved=JSON.parse(await fs.readFile(path.join(real,'.repo-map','index.json'),'utf8')) as RepositoryMap;
    if(saved.schema===2&&Array.isArray(saved.files)&&Array.isArray(saved.edges))return saved;
   }
  }catch{}
  // Node workers also work when the packaged Electron RunAsNode fuse is disabled.
  // Windows can briefly lock a just-written index (scanner/indexer); the engine then fails its rename with EPERM.
  // One short retry covers it.
  const run=()=>new Promise<string>((resolve,reject)=>{
   const worker=new Worker(pathToFileURL(this.cli),{argv:[real,'--json','--no-html','--python',this.python],stdout:true,stderr:true,execArgv:[]});
   let stdout='',stderr='';
   const timer=setTimeout(()=>{reject(Error('Repository map timed out.'));void worker.terminate();},90000);
   worker.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>32_000_000){reject(Error('Repository map exceeded its output limit.'));void worker.terminate();}});
   worker.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
   worker.once('error',reject);
   worker.once('exit',code=>{clearTimeout(timer);if(code)reject(Error(stderr||'Repository map worker failed.'));else resolve(stdout);});
  });
  const job=run().catch(async error=>{if(!/EPERM|EBUSY/.test(String(error)))throw error;await new Promise(done=>setTimeout(done,400));return run();}).then(stdout=>{
   const map=JSON.parse(stdout) as RepositoryMap;
   if(map.schema!==2||!Array.isArray(map.files)||!Array.isArray(map.edges))throw Error('Invalid repository map response.');
   return fs.mkdir(path.dirname(stamp),{recursive:true}).then(()=>fs.writeFile(stamp,head)).catch(()=>{}).then(()=>map);
  }).finally(()=>this.jobs.delete(real));
  this.jobs.set(real,job);return job;
 }
}
