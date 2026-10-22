// Chrome and computer use (4e). Hermes's browser tools run through agent-browser and its computer use through
// cua-driver. Both install on Koan's click from a pinned release checked by hash, never by npx or a web script.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {existsSync,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';

const run=promisify(execFile);
export const windowsTar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
export type ToolProgram='agent-browser'|'cua-driver';
// Pins read 2 October: npm's published integrity for agent-browser, GitHub's published digest for cua-driver.
export const programs:Record<ToolProgram,{version:string;url:string;size:number;hash:{algorithm:'sha512'|'sha256';encoding:'base64'|'hex';value:string};binary:string;name:string}>={
 'agent-browser':{version:'0.38.2',url:'https://registry.npmjs.org/agent-browser/-/agent-browser-0.38.2.tgz',size:0,hash:{algorithm:'sha512',encoding:'base64',value:'b/7hvo2RrqocvybjB9kwpX12kGkxkFvtdJ4XPDoott5TLK2n3aPX+lYg7ALd+2YvPi2LrTKGzQYu/rxZC2Y7ZA=='},binary:'package/bin/agent-browser-win32-x64.exe',name:'agent-browser.exe'},
 'cua-driver':{version:'0.32.0',url:'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/cua-driver-rs-0.32.0-windows-x86_64.zip',size:30885377,hash:{algorithm:'sha256',encoding:'hex',value:'6d70b45c8c901db773010dd720c8bb9d58c59bb301e9891c58ca1d3860e75652'},binary:'cua-driver.exe',name:'cua-driver.exe'},
};
export type BrowserChoice='hermes'|'claude';
export const readBrowserChoice=(row:any):BrowserChoice=>row?.choice==='claude'?'claude':'hermes';

// Installed programs live in the data folder; each one's folder holds the program under a fixed name on PATH.
export const programFolder=(data:string,program:ToolProgram)=>path.join(data,'tools',program,programs[program].version);
export const installedProgram=(data:string,program:ToolProgram)=>{const file=path.join(programFolder(data,program),'bin',programs[program].name);try{const expected=path.join(programFolder(realpathSync(data),program),'bin',programs[program].name);return lstatSync(file).isFile()&&realpathSync(file).toLowerCase()===expected.toLowerCase()?file:null;}catch{return null;}};

export async function installProgram(data:string,program:ToolProgram,progress:(status:string)=>void,signal?:AbortSignal){
 if(!Object.hasOwn(programs,program))throw Error('Unknown program.');
 const pin=programs[program];signal?.throwIfAborted();
 await fs.mkdir(data,{recursive:true});const base=await fs.realpath(data);
 const realDirectory=async(folder:string)=>{await fs.mkdir(folder,{recursive:true});if((await fs.realpath(folder)).toLowerCase()!==folder.toLowerCase())throw Error('The program installation folder must not be a link.');};
 const tools=path.join(base,'tools');await realDirectory(tools);const parent=path.join(tools,program);await realDirectory(parent);
 const folder=programFolder(base,program),before=await fs.lstat(folder).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(before&&(!before.isDirectory()||before.isSymbolicLink()))throw Error('The program installation folder must be a real directory.');
 const stage=await fs.mkdtemp(path.join(parent,'.install-')),archive=path.join(stage,'download'+(pin.url.endsWith('.zip')?'.zip':'.tgz')),backup=folder+'.previous-'+randomUUID();let moved=false;
 try{
  progress('Downloading '+program+' '+pin.version+'…');
  const downloading=AbortSignal.any([AbortSignal.timeout(10*60*1000),...(signal?[signal]:[])]);
  const response=await fetch(pin.url,{redirect:'follow',signal:downloading});if(!response.ok||!response.body)throw Error(program+' download failed (HTTP '+response.status+').');
  const hash=createHash(pin.hash.algorithm),handle=await fs.open(archive,'wx');let size=0;
  try{for await(const chunk of response.body as any){size+=chunk.length;if(size>200*1024*1024)throw Error(program+' download is larger than expected.');hash.update(chunk);await handle.writeFile(chunk);}}finally{await handle.close();}
  if(hash.digest(pin.hash.encoding)!==pin.hash.value||pin.size&&size!==pin.size)throw Error(program+' download did not match its pinned hash.');
  signal?.throwIfAborted();progress('Unpacking '+program+'…');
  // Read only the pinned executable to stdout. Archive entries never write paths
  // or links into the filesystem, and duplicate binary names are refused.
  const list=(await run(windowsTar,['-tf',archive],{windowsHide:true,signal,maxBuffer:4*1024*1024})).stdout.trim().split(/\r?\n/);
  const members=list.filter(name=>name===pin.binary||name.endsWith('/'+pin.binary));
  if(members.length!==1||/[?*\[\]\x00-\x1f]/.test(members[0]))throw Error(program+' archive does not contain one unambiguous '+pin.binary+'.');
  const bytes=(await run(windowsTar,['-xOf',archive,'--',members[0]],{windowsHide:true,signal,encoding:'buffer',maxBuffer:200*1024*1024})).stdout;
  if(bytes.length<2||bytes.subarray(0,2).toString()!=='MZ')throw Error(program+' archive has no Windows executable.');
  await fs.mkdir(path.join(stage,'bin'));await fs.writeFile(path.join(stage,'bin',pin.name),bytes,{flag:'wx'});
  await fs.writeFile(path.join(stage,'installed.json'),JSON.stringify({version:pin.version,archiveHash:pin.hash,binarySha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
  await fs.rm(archive);signal?.throwIfAborted();
  if(before){await fs.rename(folder,backup);moved=true;}
  try{await fs.rename(stage,folder);}catch(error){if(moved)await fs.rename(backup,folder);throw error;}
  progress('Installed');return path.join(folder,'bin',pin.name);
 }finally{
  // Only this call's staging directory is removed; a previous working version is
  // retained beside the installed version after a successful replacement.
  const remaining=await fs.realpath(stage).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(remaining&&remaining.toLowerCase()===stage.toLowerCase()&&path.dirname(stage)===parent)await fs.rm(stage,{recursive:true,force:true});
 }
}

// The installed Google Chrome agent-browser drives; agent-browser never downloads a browser of its own here.
export function installedChrome(){
 for(const root of [process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA]){if(!root)continue;const file=path.join(root,'Google','Chrome','Application','chrome.exe');if(existsSync(file))return file;}
 return null;
}
