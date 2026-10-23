// Publishing pages (4c): Cloudflare Pages (default) or GitHub Pages, both with git. The page and the files it
// links to by relative path inside its own folder go to the page's own folder in the publish repo, and are pushed
// with Koan's existing git sign-in. No API token is stored. The app keeps its own clone in its data folder.
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

import {parser as htmlParser} from '@lezer/html';
import {parser as cssParser} from '@lezer/css';
import {parser as jsParser} from '@lezer/javascript';
import {workspacePath} from './workspace-files';
import {protectedChatPath} from './chat-links';

export type Destination='cloudflare'|'github';
export interface Publishing {destination:Destination;repository:string;branch:string;site:string}
export function validatePublishing(settings:Publishing,local=false){
 if(settings.repository){
  const ssh=/^git@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:[\w./-]+$/i.test(settings.repository);
  if(!ssh&&!(local&&path.isAbsolute(settings.repository))){
   let url:URL;try{url=new URL(settings.repository);}catch{throw Error('Enter the publish repository as an https or git@ address.');}
   if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.search||url.hash||/\s/.test(settings.repository))throw Error('Use an HTTPS repository address without embedded credentials, or a git@ address.');
  }
 }
 if(settings.site){
  let url:URL;try{url=new URL(settings.site);}catch{throw Error('Enter the site address, starting with https://.');}
  if(!(url.protocol==='https:'||local&&url.protocol==='http:'&&url.hostname==='127.0.0.1')||!url.hostname||url.username||url.password||url.search||url.hash||/\s/.test(settings.site))throw Error('Use a site address without credentials, query parameters or fragments.');
 }
 if(!/^[\w./-]{1,100}$/.test(settings.branch)||settings.branch.startsWith('-')||settings.branch.includes('..')||settings.branch.endsWith('.')||settings.branch.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock')))throw Error('Enter a valid publishing branch.');
 return settings;
}

export function readPublishing(row:any):Publishing {
 const destination:Destination=row?.destination==='github'?'github':'cloudflare';
 return {destination,repository:typeof row?.repository==='string'?row.repository.trim():'',branch:typeof row?.branch==='string'&&/^[\w./-]{1,100}$/.test(row.branch)?row.branch:destination==='github'?'gh-pages':'main',site:typeof row?.site==='string'?row.site.trim().replace(/\/+$/,''):''};
}

// Use the editor's installed parsers so comments and strings are not treated as imports.
function quoted(raw:string,language:'js'|'css'){
 const value=/^["'`]/.test(raw)?raw.slice(1,-1):raw;
 if(language==='css')return value.replace(/\\([a-f0-9]{1,6})(?:\r\n|[ \t\r\n\f])?|\\(\r\n|[\s\S])/gi,(_m,hex,character)=>hex?String.fromCodePoint(parseInt(hex,16)):character.trim()?character:'');
 if(/(?<!\\)\$\{/.test(value)||/\\[1-9]/.test(value))throw Error('Build dynamic module paths before publishing.');
 return value.replace(/\\(?:u\{([a-f0-9]+)\}|u([a-f0-9]{4})|x([a-f0-9]{2})|(\r\n|[\s\S]))/gi,(_m,a,b,c,letter)=>a||b||c?String.fromCodePoint(parseInt(a||b||c,16)):({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0','\n':'','\r':'','\r\n':''} as Record<string,string>)[letter]??letter);
}
function entities(value:string){return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,(_m,code)=>code[0]==='#'?String.fromCodePoint(parseInt(code.slice(code[1].toLowerCase()==='x'?2:1),code[1].toLowerCase()==='x'?16:10)):({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'} as Record<string,string>)[code.toLowerCase()]);}
export function pageReferences(text:string,extension:string){
 const found:string[]=[];
 function parse(source:string,language:'html'|'css'|'js'){
  const tree=({html:htmlParser,css:cssParser,js:jsParser})[language].parse(source);
  const slice=(node:any)=>source.slice(node.from,node.to);
  tree.iterate({enter:node=>{
   if(node.type.isError)throw Error('Fix the '+language.toUpperCase()+' syntax before publishing.');
   const current=node.node,parent=current.parent;
   if(language==='html'){
    if(node.name==='Attribute'){
     const attribute=current.getChild('AttributeName'),value=current.getChild('AttributeValue')||current.getChild('UnquotedAttributeValue');if(!attribute||!value)return;
     const name=slice(attribute).toLowerCase(),raw=slice(value),decoded=entities(value.name==='AttributeValue'?raw.slice(1,-1):raw);
     if(parent?.getChild('TagName')&&slice(parent.getChild('TagName')).toLowerCase()==='base'&&name==='href')throw Error('Use page-relative links without a base element before publishing.');
     if(['src','href','xlink:href','poster','data'].includes(name))found.push(decoded);
     if(name==='srcset'){
      let rest=decoded;
      while(rest.trim()){const match=rest.match(/^\s*(\S+)/)!;const url=match[1];rest=rest.slice(match[0].length);found.push(url.replace(/,+$/,''));if(!url.endsWith(',')){const end=rest.indexOf(',');rest=end<0?'':rest.slice(end+1);}}
     }
     if(name==='style')parse('x{'+decoded+'}','css');
    }
    if(node.name==='StyleText')parse(slice(current),'css');
    if(node.name==='ScriptText'){
     const tag=current.parent?.getChild('OpenTag'),type=tag?.getChildren('Attribute').find(attribute=>slice(attribute.getChild('AttributeName')).toLowerCase()==='type'),value=type?.getChild('AttributeValue')||type?.getChild('UnquotedAttributeValue');
     const kind=value?slice(value).replace(/^["']|["']$/g,'').toLowerCase():'';
     if(!kind||['module','text/javascript','application/javascript'].includes(kind))parse(slice(current),'js');
    }
   }else if(language==='css'){
    if(node.name==='ImportStatement'){const value=current.getChild('StringLiteral');if(value)found.push(quoted(slice(value),'css'));}
    if(node.name==='CallLiteral'&&slice(current.getChild('CallTag')).toLowerCase()==='url'){
     const value=current.getChild('StringLiteral')||current.getChild('ParenthesizedContent');if(value)found.push(quoted(slice(value),'css').trim());
    }
   }else{
    if(['ImportDeclaration','ExportDeclaration','DynamicImport'].includes(node.name)){
     const value=current.getChild('String')||current.getChild('TemplateString');
     if(!value&&node.name==='DynamicImport')throw Error('Build dynamic module paths before publishing.');
     if(value){const reference=quoted(slice(value),'js');if(!/^(?:[./]|[a-z][a-z0-9+.-]*:)/i.test(reference))throw Error('Bundle bare module imports before publishing.');found.push(reference);}
    }
    if(['CallExpression','NewExpression'].includes(node.name)){
     const callee=current.getChild('VariableName')||current.getChild('MemberExpression'),args=current.getChild('ArgList'),first=args?.firstChild?.nextSibling;
     if(callee&&['fetch','URL','Worker','SharedWorker','navigator.serviceWorker.register'].includes(slice(callee))&&first&&['String','TemplateString'].includes(first.name))found.push(quoted(slice(first),'js'));
    }
   }
  }});
 }
 if(/\.(?:html?|svg)$/i.test(extension))parse(text,'html');else if(/\.css$/i.test(extension))parse(text,'css');else if(/\.m?js$/i.test(extension))parse(text,'js');
 return found;
}
export async function pageBundle(page:string){
 const folder=await fs.realpath(path.dirname(page)),pending=[path.basename(page)],files=new Map<string,Buffer>();let bytes=0;
 while(pending.length){
  const relative=pending.shift()!;if(files.has(relative))continue;
  if(protectedChatPath(relative)||relative.split(path.sep).some(part=>part.startsWith('.')))throw Error('Private files cannot be published.');
  const file=workspacePath(folder,relative),actual=path.relative(folder,file);
  if(protectedChatPath(file)||actual.split(path.sep).some(part=>part.startsWith('.')))throw Error('Private files cannot be published.');
  const stat=await fs.stat(file);if(!stat.isFile())throw Error('Publish a built page whose links name files: '+relative);
  if(stat.size+bytes>200*1024*1024||files.size>=10000)throw Error('This page exceeds the 200 MB or 10,000 file publishing limit.');
  const data=await fs.readFile(file);bytes+=data.length;
  if(bytes>200*1024*1024||workspacePath(folder,relative)!==file)throw Error('The page changed while it was being prepared. Try again.');
  files.set(relative,data);
  for(const raw of /\.(?:html?|svg|css|m?js)$/i.test(file)?pageReferences(data.toString('utf8'),file):[]){
   if(!raw||raw.startsWith('#')||/^[a-z][a-z0-9+.-]*:|^\/\//i.test(raw))continue;
   const reference=decodeURIComponent(raw.split(/[?#]/)[0]);if(!reference)continue;
   if(/^[\/\\]/.test(reference))throw Error('Use relative asset links before publishing: '+reference);
   const target=path.relative(folder,path.resolve(path.dirname(path.join(folder,relative)),reference));
   workspacePath(folder,target);pending.push(target);
  }
 }
 return files;
}
export async function pageFiles(page:string){return [...(await pageBundle(page)).keys()].sort();}

// Inspect the actual bytes that will be published, including binary assets.
export function assertNoSecrets(payload:Map<string,Buffer>,secret:(text:string)=>boolean){
 for(const [file,data] of payload)for(let start=0;start<data.length;start+=65536){const part=data.subarray(Math.max(0,start-4096),start+65536);if(secret(part.toString('utf8'))||secret(part.toString('utf16le'))||secret(part.subarray(1).toString('utf16le')))throw Error(file+' holds a credential, so nothing was published.');}
}
const publishing=new Map<string,Promise<unknown>>();
export async function publishPage({page,settings,clone,secret,signal,wait=180000,bundle}:{page:string;settings:Publishing;clone:string;secret:(text:string)=>boolean;signal?:AbortSignal;wait?:number;bundle?:Map<string,Buffer>}){
 if(!settings.repository||!settings.site)throw Error('Connect a destination in Settings, Publishing.');
 if(!/\.html?$/i.test(page))throw Error('Choose an HTML page to publish.');
 const payload=bundle||await pageBundle(page),files=[...payload.keys()].sort();
 assertNoSecrets(payload,secret);
 const previous=publishing.get(clone)||Promise.resolve();
 const operation=previous.catch(()=>{}).then(async()=>{
  signal?.throwIfAborted();
  const name=path.basename(page),slug=name.replace(/\.html?$/i,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)+'-'+createHash('sha256').update(path.resolve(page).toLowerCase()).digest('hex').slice(0,6);
  await fs.mkdir(clone,{recursive:true});if((await fs.realpath(clone)).toLowerCase()!==path.resolve(clone).toLowerCase())throw Error('The publishing cache must not be a link.');
  const index=path.join(clone,'.publish-index-'+randomUUID()),env={...process.env,GIT_INDEX_FILE:index,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',GIT_LITERAL_PATHSPECS:'1'};
  // A private bare repository avoids checkout, clean/smudge filters, and copying
  // over symlinks from a remote tree. Only approved file buffers enter the index.
  const git=(args:string[],input?:Buffer|string)=>new Promise<string>((resolve,reject)=>{
   const child=execFile('git',['-c','core.hooksPath='+path.join(clone,'disabled-hooks'),'-c','commit.gpgSign=false','-c','protocol.ext.allow=never',...args],{cwd:clone,env,windowsHide:true,signal,timeout:180000,maxBuffer:4*1024*1024},(error,stdout)=>error?reject(Error('Publishing Git operation failed: '+args[0],{cause:error})):resolve(stdout.trim()));
   child.stdin?.on('error',()=>{});child.stdin?.end(input);
  });
  try{
   const initialized=await fs.stat(path.join(clone,'HEAD')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
   if(!initialized){if((await fs.readdir(clone)).length)throw Error('The publishing cache contains unexpected files. Choose a fresh cache.');await git(['init','--bare','-q']);await git(['remote','add','origin',settings.repository]);}
   if(await git(['rev-parse','--is-bare-repository'])!=='true'||await git(['remote','get-url','origin'])!==settings.repository)throw Error('The publishing cache does not match this destination.');
   await git(['check-ref-format','refs/heads/'+settings.branch]);
   const remote=await git(['ls-remote','--heads','--refs','origin','refs/heads/'+settings.branch]);let parent='';
   if(remote){await git(['fetch','--no-tags','--no-recurse-submodules','origin','+refs/heads/'+settings.branch+':refs/remotes/origin/'+settings.branch]);parent=await git(['rev-parse','refs/remotes/origin/'+settings.branch]);await git(['read-tree',parent]);}
   else await git(['read-tree','--empty']);
   const old=parent?await git(['ls-tree','-r','-z','--name-only',parent,'--',slug+'/']):'';
   if(old)await git(['update-index','-z','--index-info'],old.split('\0').filter(Boolean).map(file=>'0 '+'0'.repeat(parent.length)+'\t'+file+'\0').join(''));
   const entries:string[]=[];
   for(const [file,data] of payload){const oid=await git(['hash-object','-w','--no-filters','--stdin'],data);entries.push('100644 '+oid+'\t'+slug+'/'+file.split(path.sep).join('/')+'\0');}
   await git(['update-index','-z','--index-info'],entries.join(''));
   const tree=await git(['write-tree']),before=parent?await git(['rev-parse',parent+'^{tree}']):'';
   if(tree!==before){
    const commit=await git(['commit-tree',tree,...(parent?['-p',parent]:[]),'-m','Publish '+name]);
    await git(['update-ref','refs/trismegistus/pending',commit]);
    await git(['push','--no-verify','-q','origin',commit+':refs/heads/'+settings.branch]);
    await git(['update-ref','-d','refs/trismegistus/pending',commit]);
   }
   const url=settings.site+'/'+slug+'/'+encodeURIComponent(name),end=Date.now()+wait;
   while(Date.now()<end){
    signal?.throwIfAborted();
    try{const response=await fetch(url,{redirect:'follow',signal:AbortSignal.any([AbortSignal.timeout(Math.min(10000,end-Date.now())),...(signal?[signal]:[])])});await response.body?.cancel();if(response.ok)return {url,files,live:true};}catch{signal?.throwIfAborted();}
    await delay(Math.min(2000,Math.max(0,end-Date.now())),undefined,{signal});
   }
   return {url,files,live:false};
  }finally{await fs.rm(index,{force:true});await fs.rm(index+'.lock',{force:true});}
 });
 publishing.set(clone,operation);
 try{return await operation;}finally{if(publishing.get(clone)===operation)publishing.delete(clone);}
}

// The model tool (code rule 2: this schema, the permissions plugin's mcp.py, request() and the Claude list).
export const publishTool={name:'publish_page',description:'Publish an HTML page from the working folder to the user\'s publishing destination (Cloudflare Pages or GitHub Pages). The page and the files it links to inside its folder are published; the result is a public link. With client true it is shared with the client instead: a private link with a notes layer, the same link for every new version (Share with clients). Only publish or share when the user asks.',inputSchema:{type:'object',properties:{path:{type:'string',description:'The HTML file, relative to the working folder'},client:{type:'boolean',description:'Share with the client at a private link with notes, instead of publishing publicly'}},required:['path'],additionalProperties:false}};
