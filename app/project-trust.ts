import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {load,CORE_SCHEMA} from 'js-yaml';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pluginTree} from './native-plugins';

const preferences=new Set(['theme','language','preferredNotifChannel','spinnerTipsEnabled','spinnerVerbs','showTurnDuration','terminalProgressBarEnabled','reducedMotionMode','verbose','feedbackSurveyState']);
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return !relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
function ordered(value:any):any{return Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;}
export interface ProjectSourceGrant {sourceHash:string;skillFolders:string[];pending?:Promise<void>;}
export interface ProjectTrustReview {folder:string;hash:string;sourceHash?:string;skillFolders?:string[];definitions?:Record<string,any>;warnings?:string[];settings:Record<string,any>;agents?:{path:string;settings:Record<string,any>}[];skills?:{path:string;kind:string;settings:Record<string,any>}[];commands:string[];files:{path:string;hash:string}[];reviewEveryRun:boolean;error?:string;}

async function projectDirectories(root:string){
  let boundary=path.parse(root).root,main:string|undefined;
  try{const result=await promisify(execFile)('git',['-C',root,'rev-parse','--show-toplevel'],{windowsHide:true,timeout:5000});const repo=await fs.realpath(result.stdout.trim());if(inside(repo,root)){
    boundary=repo;const entry=await fs.lstat(path.join(repo,'.git'));if(entry.isFile()){
      const list=await promisify(execFile)('git',['-C',repo,'worktree','list','--porcelain','-z'],{windowsHide:true,timeout:5000}),first=list.stdout.split('\0\0')[0].split('\0'),location=first.find(line=>line.startsWith('worktree '))?.slice(9);
      if(location&&!first.includes('bare')){const candidate=await fs.realpath(location);if(candidate!==repo)main=candidate;}
    }
  }}
  catch(error){if((error as any).killed||!/(?:not a git repository)/i.test(String((error as any).stderr||'')))throw Error('Could not establish the project definition search boundary.');}
  const directories=[];for(let dir=root;;dir=path.dirname(dir)){directories.push(dir);if(dir===boundary||dir===path.dirname(dir))break;}return {directories:directories.reverse(),main};
}

async function definitionScope(scope:string,dir:string,fallback?:string){
  for(const candidate of [scope,...(fallback?[fallback]:[])])if(await fs.lstat(path.join(candidate,'.claude',dir)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))return candidate;
}

export async function projectSkillFolders(name:string,input:any,directory:string){
  if(!['Read','Write','Edit','MultiEdit','NotebookEdit'].includes(name))return [];
  const file=input?.file_path||input?.notebook_path||input?.path;if(typeof file!=='string'||!file)return [];
  let parent=path.dirname(path.resolve(directory,file));
  while(!await fs.stat(parent).then(stat=>stat.isDirectory(),error=>{if(error.code==='ENOENT')return false;throw error;})){const next=path.dirname(parent);if(next===parent)return [];parent=next;}
  const folders=[],{directories,main}=await projectDirectories(await fs.realpath(parent));for(const scope of directories){const fallback=scope===directories[0]?main:undefined;if(await definitionScope(scope,'skills',fallback)||await definitionScope(scope,'commands',fallback))folders.push(scope);}return folders;
}

export async function inspectProjectTrust(folder:string,additionalSkillFolders:string[]=[]):Promise<ProjectTrustReview>{
  const root=await fs.realpath(folder),settingsFile=path.join(root,'.claude','settings.json');
  let settings:Record<string,any>={};
  try{
    const resolved=await fs.realpath(settingsFile);
    if(!inside(root,resolved)||['.claude','.codex'].some(name=>inside(path.join(os.homedir(),name),resolved))||(await fs.stat(resolved)).size>1024*1024)throw Error('Settings need review');
    settings=JSON.parse(await fs.readFile(resolved,'utf8'));if(!settings||Array.isArray(settings)||typeof settings!=='object')throw Error('Invalid settings');
  }
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return {folder:root,hash:'',settings:{},commands:[],files:[],reviewEveryRun:true,error:'Project settings could not be read. They will remain off.'};}
  const security=Object.fromEntries(Object.entries(settings).filter(([key])=>!preferences.has(key)));
  const commands:string[]=[],commandSources:{command:string;skillDirectory?:string;pluginDirectory?:string}[]=[],files:{path:string;hash:string}[]=[],agents:NonNullable<ProjectTrustReview['agents']>=[],skills:NonNullable<ProjectTrustReview['skills']>=[],definitionSources:{path:string;hash:string}[]=[],definitions:Record<string,any>=Object.create(null);
  const recordCommand=(command:string,skillDirectory?:string,pluginDirectory?:string)=>{commands.push(command);commandSources.push({command,skillDirectory,pluginDirectory});};
  const seen=new WeakSet<object>();
  const visit=(value:any,skillDirectory?:string,pluginDirectory?:string)=>{if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);if(value.type==='command'&&typeof value.command==='string')recordCommand(value.command,skillDirectory,pluginDirectory);for(const child of Object.values(value))if(typeof child==='object')visit(child,skillDirectory,pluginDirectory);};
  visit(settings.hooks);
  let definitionBytes=0,definitionEntries=0,hasProjectPlugins=false;const skillFolders:string[]=[],definitionRoots=new Set([root]),visitedDirectories=new Set<string>();
  async function readDefinitions(scope:string,directory:string,kind:'agent'|'skill'|'command',names=new Set<string>()){
    const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)return;
    const resolved=await fs.realpath(directory);
    if(stat.isSymbolicLink()||!inside(scope,resolved))throw Error('Definition links need review');
    const identity=kind+'\0'+resolved;if(visitedDirectories.has(identity))return;visitedDirectories.add(identity);
    if(kind==='skill'&&await fs.lstat(path.join(directory,'.claude-plugin/plugin.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})){
      const snapshot=await pluginTree(directory),json=(name:string)=>{const file=snapshot.files.find(file=>file.name===name.replace(/^\.\//,''));return file?JSON.parse(file.body.toString('utf8')):undefined;},manifest=json('.claude-plugin/plugin.json');
      if(typeof manifest?.name!=='string'||!manifest.name.trim())throw Error('Invalid skill plugin');
      const hooks={default:json('hooks/hooks.json'),manifest:typeof manifest.hooks==='string'?json(manifest.hooks):manifest.hooks};
      // Like imported plugins, approve the complete bundle: native plugins can
      // load agents, custom definition paths and other executable dependencies.
      skills.push({path:path.join(directory,'.claude-plugin/plugin.json'),kind:'plugin',settings:{manifest,hooks,hash:snapshot.hash,files:snapshot.files.length,settings:json('settings.json'),mcp:json('.mcp.json')}});
      definitionSources.push({path:directory,hash:snapshot.hash});hasProjectPlugins=true;visit(hooks,undefined,directory);
    }
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(directory,entry.name),stat=await fs.lstat(file);
      if(++definitionEntries>10000)throw Error('Too many definition files');
      if(stat.isSymbolicLink())throw Error('Definition links need review');
      if(stat.isDirectory()){await readDefinitions(scope,file,kind,names);continue;}if(kind==='skill'?entry.name!=='SKILL.md':!entry.name.endsWith('.md'))continue;
      definitionBytes+=stat.size;if(!stat.isFile()||stat.size>1024*1024||definitionBytes>8*1024*1024||definitionSources.length>=1000)throw Error('Definition needs review');
      const text=await fs.readFile(file,'utf8'),header=/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text),parsed=header?load(header[1],{schema:CORE_SCHEMA}):{};
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Invalid agent definition');
      let nodes=0;JSON.stringify(parsed,(_key,value)=>{if(++nodes>10000)throw Error('Agent YAML expands too far');return value;});
      const access=Object.fromEntries(Object.entries(parsed).filter(([key])=>!['description','color'].includes(key)));
      if(kind==='agent')agents.push({path:file,settings:access});else skills.push({path:file,kind,settings:access});definitionSources.push({path:file,hash:digest(text)});visit(access.hooks,kind==='skill'?path.dirname(file):undefined);
      if(kind!=='agent')for(const command of text.slice(header?.[0].length||0).matchAll(/!`([\s\S]*?)`/g))recordCommand(command[1],kind==='skill'?path.dirname(file):undefined);
      const {name,...definition}=parsed as Record<string,any>;
      if(kind==='agent'&&header&&typeof name==='string'&&name&&typeof definition.description==='string'){
        if(name.startsWith('-')||names.has(name))throw Error('Agent names must be unique within their directory');names.add(name);
        definitions[name]={...definition,prompt:text.slice(header[0].length),...Object.fromEntries(['tools','disallowedTools','skills'].filter(key=>typeof definition[key]==='string').map(key=>[key,definition[key].split(',').map((v:string)=>v.trim()).filter(Boolean)]))};
      }
    }
  }
  async function readScope(scope:string,kind:'agent'|'skill'|'command',dir:string,fallback?:string){
    const origin=await definitionScope(scope,dir,fallback);if(!origin)return;
    const config=path.join(origin,'.claude');if((await fs.lstat(config)).isSymbolicLink())throw Error('Linked project definitions need review');
    definitionRoots.add(origin);await readDefinitions(origin,path.join(config,dir),kind);
  }
  try{const {directories,main}=await projectDirectories(root);definitionRoots.add(directories[0]);for(const scope of directories){
    for(const [kind,dir] of [['agent','agents'],['skill','skills'],['command','commands']] as const)await readScope(scope,kind,dir,scope===directories[0]?main:undefined);
  }
    for(const extra of [...new Set(additionalSkillFolders)].sort()){
      const scope=await fs.realpath(extra).catch(error=>{if(error.code==='ENOENT')return path.resolve(extra);throw error;});if(directories.includes(scope)||skillFolders.includes(scope))continue;skillFolders.push(scope);
      if(!await fs.stat(scope).then(stat=>stat.isDirectory(),error=>{if(error.code==='ENOENT')return false;throw error;}))continue;
      const source=await projectDirectories(scope);for(const [kind,dir] of [['skill','skills'],['command','commands']] as const)await readScope(scope,kind,dir,scope===source.directories[0]?source.main:undefined);
    }
  }
  catch{return {folder:root,hash:'',settings:security,agents,skills,commands,files,reviewEveryRun:true,error:'Project agent definitions, skills or skill plugins could not be reviewed. Check their files, links and repository before enabling project settings.'};}
  // Static script paths are fingerprinted. Shell expansion and imported code need
  // a per-run review because their dependency set cannot be established here.
  let reviewEveryRun=hasProjectPlugins;
  for(const {command,skillDirectory,pluginDirectory} of commandSources){
    let expanded=command.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR|%CLAUDE_PROJECT_DIR%|\$env:CLAUDE_PROJECT_DIR/g,()=>root);
    if(skillDirectory)expanded=expanded.replace(/\$\{CLAUDE_SKILL_DIR\}|\$CLAUDE_SKILL_DIR|%CLAUDE_SKILL_DIR%|\$env:CLAUDE_SKILL_DIR/g,()=>skillDirectory);
    if(pluginDirectory)expanded=expanded.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT|%CLAUDE_PLUGIN_ROOT%|\$env:CLAUDE_PLUGIN_ROOT/g,()=>pluginDirectory);
    const tokens=Array.from(expanded.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g),match=>match[1]||match[2]||match[3]);
    const scripts=tokens.filter(token=>/\.(?:py|js|cjs|mjs|ps1|sh|bat|cmd)$/i.test(token));
    if(!scripts.length&&!/^\s*(?:echo|printf)\s+[\w .,'"-]+\s*$/.test(expanded))reviewEveryRun=true;
    for(const script of scripts){
      try{
        const resolved=await fs.realpath(path.resolve(root,script));
        if(![...definitionRoots].some(folder=>inside(folder,resolved))||['.claude','.codex'].some(name=>inside(path.join(os.homedir(),name),resolved))||(await fs.stat(resolved)).size>1024*1024)throw Error('Script needs review');
        const body=await fs.readFile(resolved);
        files.push({path:resolved,hash:digest(body)});
        // An arbitrary script can load code dynamically. Never infer that hashing
        // only its entry point proves all of its executable dependencies unchanged.
        reviewEveryRun=true;
      }catch{files.push({path:path.resolve(root,script),hash:'unavailable'});reviewEveryRun=true;}
    }
    if(/[|;&`]|\$\(|%[^%]+%/.test(expanded))reviewEveryRun=true;
  }
  const connectionOverride=Object.keys(settings.env||{}).some(key=>/^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR|NODE_OPTIONS)/i.test(key));
  const hash=digest(JSON.stringify(ordered({security,files,...(agents.length?{agents}:{}),...(skills.length?{skills,commands}:{})})));
  const warnings=agents.some(agent=>agent.settings.mcpServers)?['Agent-defined MCP connections stay off. Use the servers connected in this app.']:[];
  return {folder:root,hash,sourceHash:digest(JSON.stringify({hash,definitionSources})),skillFolders,definitions,warnings,settings:security,agents,skills,commands,files,reviewEveryRun,
    ...(connectionOverride?{error:'Project settings override the Claude connection. Remove those connection overrides before enabling project settings.'}:{})};
}
