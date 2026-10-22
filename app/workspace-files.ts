import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export interface WorkspaceFile {path:string;name:string;text:string;revision:string;bom:boolean;lineEnding:string;}
const limit=2*1024*1024;
const revision=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
export function workspacePath(root:string|null,relative:unknown=''){
  if(!root)throw Error('Choose the root working folder in Settings first.');
  if(typeof relative!=='string'||relative.includes('\0')||path.isAbsolute(relative)||relative.split(/[\\/]/).some(part=>part==='..'||part.includes(':')))throw Error('Choose a path inside the working folder.');
  const base=fs.realpathSync(root),file=fs.realpathSync(path.resolve(base,relative)),trail=path.relative(base,file);
  if(trail==='..'||trail.startsWith('..'+path.sep)||path.isAbsolute(trail))throw Error('This link points outside the working folder.');
  return file;
}
export function listWorkspace(root:string|null,relative=''){
  const directory=workspacePath(root,relative);
  const entries=fs.readdirSync(directory,{withFileTypes:true}).filter(item=>item.name!=='.git').sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
  return {path:relative,entries:entries.slice(0,1000).map(item=>({name:item.name,path:path.join(relative,item.name),directory:item.isDirectory(),link:item.isSymbolicLink()})),truncated:entries.length>1000};
}
export function readWorkspaceFile(root:string|null,relative:string):WorkspaceFile{
  const file=workspacePath(root,relative),stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>limit)throw Error('The editor opens text files up to 2 MB.');
  const bytes=fs.readFileSync(file);if(bytes.length>limit||bytes.includes(0))throw Error('The editor opens UTF-8 text files up to 2 MB.');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('This file is not UTF-8 text.');}
  return {path:relative,name:path.basename(relative),text,revision:revision(bytes),bom:bytes.subarray(0,3).equals(Buffer.from([239,187,191])),lineEnding:text.includes('\r\n')?'\r\n':'\n'};
}
export function saveWorkspaceFile(root:string|null,relative:string,text:unknown,expected:unknown){
  if(typeof text!=='string'||Buffer.byteLength(text)>limit||typeof expected!=='string')throw Error('Invalid editor save.');
  const file=workspacePath(root,relative),fd=fs.openSync(file,'r+');
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw Error('The editor opens text files up to 2 MB.');
    const before=fs.readFileSync(fd);
    if(revision(before)!==expected)throw Error('This file changed on disk. Your draft is kept. Reload to inspect the latest version before saving.');
    if(workspacePath(root,relative)!==file)throw Error('The file location changed. Reopen it before saving.');
    const bytes=Buffer.from((before.subarray(0,3).equals(Buffer.from([239,187,191]))?'\uFEFF':'')+text);
    // Keep the existing inode/permissions. Synchronous compare/write prevents an
    // app-owned action interleaving; unrelated external writers can still race.
    let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);
    fs.ftruncateSync(fd,bytes.length);fs.fsyncSync(fd);
    return {...readWorkspaceFile(root,relative),text,revision:revision(bytes)};
  }finally{fs.closeSync(fd);}
}
