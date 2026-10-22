import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {workspacePath} from './workspace-files';

export type FileRequest={chatFileId?:string;id:string;refresh?:boolean;chatId?:string;root:string;path:string;line?:number;column?:number;directory:boolean};
const inside=(base:string,file:string)=>{const relative=path.relative(base,file);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));};
export const protectedChatPath=(file:string)=>file.split(/[/\\]/).some(part=>/^(?:\.git|\.claude|\.codex|\.ssh|\.aws|\.azure|\.gnupg|mcp-tokens|state-snapshots|auth\.json|credentials(?:\.json)?|config\.yaml|\.env(?:\..*)?)$/i.test(part));
export function resolveChatLink(root:string|null,href:unknown,protectedRoots:string[]=[]){
  if(typeof href!=='string'||!href.trim()||href.length>8192||/[\x00-\x1f\x7f]/.test(href))throw Error('This link is invalid.');
  let value=href.trim();
  if(/^https?:/i.test(value)){
    const url=new URL(value);if(!url.hostname||url.username||url.password)throw Error('This web link contains an unsupported address.');
    return {kind:'web' as const,url:url.href};
  }
  if(!root)throw Error('Choose the root working folder in Settings before opening file links.');
  if(/^[/\\]{2}/.test(value))throw Error('Network file links are unavailable.');
  let line:number|undefined,column:number|undefined;
  const fragment=value.match(/#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i);
  if(fragment){line=Number(fragment[1]);column=fragment[2]?Number(fragment[2]):undefined;value=value.slice(0,fragment.index);}
  const suffix=value.match(/:(\d+)(?::(\d+))?$/);
  if(suffix){line??=Number(suffix[1]);column??=suffix[2]?Number(suffix[2]):undefined;value=value.slice(0,suffix.index);}
  if((line!==undefined&&(!Number.isSafeInteger(line)||line<1))||(column!==undefined&&(!Number.isSafeInteger(column)||column<1)))throw Error('This file link has an invalid line number.');
  if(/^file:/i.test(value)){
    const url=new URL(value);if(url.hostname&&url.hostname!=='localhost')throw Error('Network file links are unavailable.');
    if(url.search||url.hash)throw Error('This file link has an unsupported location.');
    value=fileURLToPath(url);
  }else{
    try{value=decodeURIComponent(value);}catch{throw Error('This file link is invalid.');}
    if(/^\/[a-z]:[/\\]/i.test(value))value=value.slice(1);
    if(/^[a-z][a-z\d+.-]*:/i.test(value)&&!(/^[a-z]:[/\\]/i.test(value)))throw Error('Only web and working-folder file links can be opened.');
  }
  if(/[\x00-\x1f\x7f]/.test(value)||/^[/\\]{2}/.test(value))throw Error('This file link is invalid.');
  const base=fs.realpathSync(root),relative=path.isAbsolute(value)?path.relative(base,value):value;
  const absolute=workspacePath(base,relative);
  if(protectedChatPath(path.resolve(base,relative))||protectedChatPath(absolute)||protectedRoots.some(folder=>inside(path.resolve(folder),absolute)))throw Error('Protected account and configuration files cannot be opened from chat links.');
  return {kind:'file' as const,root:base,path:path.relative(base,absolute),line,column,directory:fs.statSync(absolute).isDirectory()};
}
