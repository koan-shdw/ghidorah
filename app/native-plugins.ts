import fs from 'node:fs/promises';
import {watch,type FSWatcher} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ChatCommand} from './types';

export interface PluginConversion {kind:'claude'|'skill';skills:{name:string;path:string;description:string;frontmatter:Record<string,unknown>}[];commands:{name:string;path:string;description:string}[];servers:{name:string;config:Record<string,unknown>}[];unsupported:string[];identifier?:string;}
export interface NativePlugin {id:string;name:string;version:string;source:string;commit:string|null;description:string;hash:string;files:number;hooks:boolean;skills:boolean;commands:boolean;agents:boolean;mcp:boolean;native?:boolean;nativeSubdir?:string;repository?:string;setup?:PluginSetup;conversion?:PluginConversion;hermes?:{prerequisites:string[];scan:{verdict:string;findings:any[]}};}
export interface PluginSetup {fields:{key:string;setting?:string;env?:string;type:string;label:string;description:string;required:boolean;default?:unknown;schema:Record<string,any>}[];python:string[];plugins:{id:string;version_range?:string}[];blockers:string[];}
export interface PluginConfiguration {revision:string;settings:Record<string,unknown>;values:Record<string,unknown>;filled:string[];}
export interface PluginRuntime {directory:string;hash:string;specs:string[];packages:{name:string;version:string}[];}
export interface NativePluginInstall extends NativePlugin {directory:string;enabled:boolean;configuration?:PluginConfiguration;runtime?:PluginRuntime;}
const excluded=new Set(['.git','.in_use','__pycache__']);
const within=(root:string,file:string)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

export async function pluginTree(directory:string){
 const root=await fs.realpath(directory),files:{name:string;body:Buffer}[]=[];let size=0;
 async function visit(folder:string){
  const entries=(await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){
   if(excluded.has(entry.name)||entry.name.endsWith('.pyc'))continue;
   const file=path.join(folder,entry.name),stat=await fs.lstat(file);
   if(stat.isSymbolicLink()||!within(root,await fs.realpath(file)))throw Error('Plugin links need review before import.');
   if(stat.isDirectory())await visit(file);
   else if(stat.isFile()){
    size+=stat.size;if(size>100*1024*1024||files.length>=10000)throw Error('This plugin is too large to import.');
    files.push({name:path.relative(root,file).replaceAll('\\','/'),body:await fs.readFile(file)});
   }
  }
 }
 await visit(root);const hash=createHash('sha256');
 for(const file of files)hash.update(file.name+'\0').update(String(file.body.length)+'\0').update(file.body);
 return {files,hash:hash.digest('hex')};
}

export async function nativePluginCatalog(claudeHome:string){
 const file=path.join(claudeHome,'plugins','installed_plugins.json');
 const registry=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {plugins:{}};throw error;});
 const cache=path.join(claudeHome,'plugins','cache'),rows:{id:string;name:string;version:string;source:string;commit:string|null}[]=[];
 for(const [id,versions] of Object.entries(registry.plugins||{})){
  if(!Array.isArray(versions))continue;
  const item=versions.find(row=>row.scope==='user');if(!item||typeof item.installPath!=='string')continue;
  const source=await fs.realpath(item.installPath).catch(()=>null);if(!source||!within(cache,source))continue;
  rows.push({id,name:id.split('@')[0],version:String(item.version||''),source,commit:/^[a-f0-9]{40}$/i.test(item.gitCommitSha||'')?item.gitCommitSha:null});
 }
 return rows;
}

export async function reviewNativePlugin(row:Awaited<ReturnType<typeof nativePluginCatalog>>[number]):Promise<NativePlugin>{
 const snapshot=await pluginTree(row.source),manifest=JSON.parse(snapshot.files.find(file=>file.name==='.claude-plugin/plugin.json')?.body.toString('utf8')||'{}');
 if(typeof manifest.name!=='string'||!manifest.name.trim())throw Error('This folder has no valid Claude plugin manifest.');
 const has=(prefix:string)=>snapshot.files.some(file=>file.name.startsWith(prefix));
 return {...row,name:manifest.name,description:String(manifest.description||''),hash:snapshot.hash,files:snapshot.files.length,hooks:!!manifest.hooks||has('hooks/'),skills:!!manifest.skills||has('skills/'),commands:!!manifest.commands||has('commands/'),agents:!!manifest.agents||has('agents/'),mcp:!!manifest.mcpServers||has('.mcp.json')};
}

export async function installNativePlugin(review:NativePlugin,directory:string):Promise<NativePluginInstall>{
 if(review.hermes&&(review.hermes.prerequisites.length||review.hermes.scan.verdict==='dangerous'))throw Error('Resolve the plugin review findings before installing.');
 const snapshot=await pluginTree(review.source);if(snapshot.hash!==review.hash)throw Error('The plugin changed. Review it again before importing.');
 await fs.mkdir(directory,{recursive:true});const destination=await fs.mkdtemp(path.join(directory,review.hash+'-'));
 for(const file of snapshot.files){const target=path.join(destination,file.name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.body,{flag:'wx'});}
 if((await pluginTree(destination)).hash!==review.hash)throw Error('The saved plugin differs from the reviewed version. It has not been enabled.');
 return {...review,directory:destination,enabled:true};
}

export async function verifyPlugins(records:NativePluginInstall[],directory:string){
 for(const record of records.filter(row=>row.enabled)){
  if(!/^[a-f0-9]{64}$/.test(record.hash)||path.dirname(record.directory)!==directory||!path.basename(record.directory).startsWith(record.hash+'-')||(await fs.lstat(record.directory)).isSymbolicLink()||(await pluginTree(record.directory)).hash!==record.hash)throw Error('The saved '+record.name+' plugin changed. Review and import it again in Plugins.');
 }
}

// A check is skipped while its folders are unchanged since it last passed with the same inputs (TURN-REVIEW rule 5:
// 10-13..20 the plugin checks cost about 1.6 s per GPT message though nothing changed). Watchers mark a folder
// changed; a folder that cannot be watched counts as changed every time, so the full check runs as before.
export class ChangeGate{
 private folders=new Map<string,{changed:boolean;watcher:FSWatcher}>();private passed=new Map<string,string>();
 private changed(folder:string){
  const entry=this.folders.get(folder);if(entry){const changed=entry.changed;entry.changed=false;return changed;}
  try{
   const created={changed:false,watcher:watch(folder,{recursive:true},()=>{created.changed=true;})};
   created.watcher.on('error',()=>{created.watcher.close();this.folders.delete(folder);});
   this.folders.set(folder,created);
  }catch{}
  return true;
 }
 // True: nothing to check. False: run the check, then pass() it.
 quiet(key:string,folders:string[],inputs:string){
  const changed=folders.map(folder=>this.changed(folder)).includes(true);
  if(!changed&&this.passed.get(key)===inputs)return true;
  this.passed.delete(key);return false;
 }
 pass(key:string,inputs:string){this.passed.set(key,inputs);}
 close(){for(const entry of this.folders.values())entry.watcher.close();this.folders.clear();this.passed.clear();}
}

// The plugin runtime's files as one line each (path, size, time, links marked), to notice any change cheaply
// (TRIS-TODO 1.11: his runtime is 3,040 files, 0.1 s to list against about 3 s to hash in full).
export async function runtimeListing(directory:string){
 const lines:string[]=[];
 for(const entry of await fs.readdir(directory,{recursive:true,withFileTypes:true})){
  const file=path.join(entry.parentPath,entry.name),stat=await fs.lstat(file);
  if(!stat.isDirectory())lines.push(path.relative(directory,file).split(path.sep).join('/')+':'+stat.size+':'+stat.mtimeMs+(stat.isSymbolicLink()?':link':''));
 }
 return lines.sort().join('\n');
}
// The full check (every file hashed, bytecode cleared) runs when the reviewed runtime or its listing changed since
// the last one that passed. ponytail: a change that keeps every file's size and time slips by until Hermes starts
// again (its start always checks in full); hash a sample per message if that ever matters.
export async function checkRuntimeOnChange(cache:{hash?:string;listing?:string},runtime:{directory:string;hash:string},check:()=>Promise<unknown>){
 const listing=await runtimeListing(runtime.directory).catch(()=>null);
 if(listing!==null&&cache.hash===runtime.hash&&cache.listing===listing)return;
 cache.hash=cache.listing=undefined;
 await check();
 Object.assign(cache,{hash:runtime.hash,listing:await runtimeListing(runtime.directory)});
}

export async function nativePluginDirectories(records:NativePluginInstall[],directory:string){
 await verifyPlugins(records,directory);
 return records.filter(row=>row.enabled&&row.native!==false).map(row=>{if(row.nativeSubdir&&!['source','native'].includes(row.nativeSubdir))throw Error('Invalid native plugin folder.');return path.join(row.directory,row.nativeSubdir||'');});
}

export async function reviewHermesPlugin(metadata:any):Promise<NativePlugin>{
 const snapshot=await pluginTree(metadata.source),has=(prefix:string)=>snapshot.files.some(file=>file.name.startsWith(prefix));
 if(!/^[a-f0-9]{40}$/i.test(metadata.commit))throw Error('The repository did not resolve to a fixed commit.');
 const conversion=metadata.conversion as PluginConversion|undefined;
 return {id:conversion?.kind==='skill'?'skill:'+conversion.identifier:'git:'+metadata.repository.toLowerCase(),name:metadata.name,version:metadata.version,description:metadata.description,source:metadata.source,repository:metadata.repository,commit:metadata.commit,hash:snapshot.hash,files:snapshot.files.length,native:metadata.native??has('.claude-plugin/plugin.json'),nativeSubdir:metadata.nativeSubdir||undefined,setup:metadata.setup,conversion,hooks:metadata.hooks,skills:conversion?!!conversion.skills.length:has('skills/'),commands:conversion?!!conversion.commands.length:has('commands/'),agents:has('agents/'),mcp:conversion?!!conversion.servers.length:has('.mcp.json'),hermes:{prerequisites:metadata.prerequisites,scan:metadata.scan}};
}

export function sharedCommands(records:NativePluginInstall[]):ChatCommand[]{
 return records.filter(row=>row.enabled).flatMap(row=>(row.conversion?.commands||[]).map(command=>({name:`/${row.name}:${command.name}`,description:command.description,plugin:row.name,kind:row.conversion!.skills.some(skill=>skill.path===command.path)?'Skill' as const:'Command' as const}))).sort((a,b)=>a.name.localeCompare(b.name));
}

export async function pluginCommand(prompt:string,records:NativePluginInstall[],directory:string){
 const match=/^\/([\w-]+):([\w-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());if(!match)return prompt;
 const record=records.find(row=>row.enabled&&row.name===match[1]&&row.conversion?.commands.some(command=>command.name===match[2]));if(!record)return prompt;
 await verifyPlugins([record],directory);
 const command=record.conversion!.commands.find(command=>command.name===match[2])!,file=path.resolve(record.directory,command.path);
 if(!within(record.directory,file))throw Error('The plugin command path escapes its reviewed folder.');
 const body=(await fs.readFile(file,'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
 const args=match[3]||'',root=path.join(record.directory,'source');
 return `The user invoked /${record.name}:${command.name}.\nPlugin files: ${root}\n\n`+body.replaceAll('${CLAUDE_PLUGIN_ROOT}',()=>root).replaceAll('$ARGUMENTS',()=>args)+(args&&!body.includes('$ARGUMENTS')?'\n\nUser arguments:\n'+args:'');
}

export async function pluginServer(record:NativePluginInstall[],directory:string,index:number){
 await verifyPlugins(record,directory);const row=record[0];if(!row?.enabled)throw Error('Enable this plugin before reviewing its servers.');
 const server=row.conversion?.servers[index];if(!server)throw Error('Plugin server not found.');
 const root=path.join(row.directory,'source');
 function expand(value:any):any{if(typeof value==='string')return value.replaceAll('${CLAUDE_PLUGIN_ROOT}',()=>root);if(Array.isArray(value))return value.map(expand);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,value])=>[key,expand(value)]));return value;}
 return {name:row.name+' · '+server.name,config:expand(server.config)};
}

// Copies preserve profile isolation. Old versions stay disabled; no live source or credentials are shared.
export const hermesPluginKey=(record:NativePluginInstall)=>'reviewed/'+path.basename(record.directory);
export async function hermesPluginCopies(records:NativePluginInstall[],home:string,copy=false){
 const keys:string[]=[];
 for(const record of records.filter(row=>row.enabled&&row.hermes)){
  const key=hermesPluginKey(record),destination=path.join(home,'plugins',key);
  if(copy){
   await fs.mkdir(path.dirname(destination),{recursive:true});
   if((await fs.lstat(path.dirname(destination))).isSymbolicLink())throw Error('Plugin links need review before import.');
   if(!await fs.stat(destination).then(()=>true,()=>false)){
    const snapshot=await pluginTree(record.directory);
    if(snapshot.hash!==record.hash)throw Error('The saved '+record.name+' plugin changed. Review it again.');
    await fs.mkdir(destination);
    for(const file of snapshot.files){const target=path.join(destination,file.name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.body,{flag:'wx'});}
   }
  }
  if((await fs.lstat(destination)).isSymbolicLink()||!within(await fs.realpath(home),await fs.realpath(destination))||(await pluginTree(destination)).hash!==record.hash)throw Error('The saved '+record.name+' plugin changed in this project. Review it again in Plugins.');
  keys.push(key);
 }
 return keys;
}
