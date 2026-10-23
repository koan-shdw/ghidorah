// Share work with clients, the Tris side (FEATURE-SPECS 3). Tris keeps its own copy of the share site in its data
// folder (share-site\), publishes a project's page under that project's private id, deploys it with Cloudflare's
// wrangler on Koan's own sign-in (no token is stored), reads clients' notes back, and keeps the "for your AI" page
// that Koan approves version by version.
import {spawn,execFile} from 'node:child_process';
import {randomBytes,pbkdf2Sync} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ShareSettings {site:string;databaseId:string;ready:boolean;wrangler?:string;checked?:number}
export interface ShareProject {id:string;shareId:string;chatId:string;title:string;page:string;version:number;aiKey:string;password?:{salt:string;hash:string};sections:string[];published:number;since:number;
 ai?:{text:string;version:number};draft?:{text:string;version:number;status:'writing'|'ready'|'failed'};seenVersion?:number}
export interface ShareNote {id:string;shareId:string;projectId:string;page:string;name:string;text:string;anchor:string|null;version:number|null;created:number;handled?:boolean}

export const DATABASE='koan-share-notes',WORKER='koan-share';
export const privateId=()=>randomBytes(16).toString('base64url');
// The Worker derives the same way (share/src/worker.js); 100,000 rounds is the most Workers allow.
export function hashPassword(password:string,salt=randomBytes(16).toString('hex')){return {salt,hash:pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')};}

// Section names = the page's h1 to h3 headings, the same ones the notes layer pins pasted lines to.
const entity=(text:string)=>text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(_m,code:string)=>code[0]==='#'?String.fromCodePoint(parseInt(code.slice(code[1].toLowerCase()==='x'?2:1),code[1].toLowerCase()==='x'?16:10)):({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '} as Record<string,string>)[code.toLowerCase()]);
export function sections(html:string){return [...new Set([...html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,'').matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match=>entity(match[2].replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim()).filter(Boolean))].slice(0,40);}

export const pageLink=(site:string,project:Pick<ShareProject,'shareId'|'page'>)=>site+'/'+project.shareId+'/'+(/^index\.html?$/i.test(project.page)?'':encodeURIComponent(project.page));
export const aiAddress=(site:string,project:Pick<ShareProject,'shareId'|'aiKey'|'password'>)=>site+'/'+project.shareId+'/for-ai'+(project.password?'?key='+project.aiKey:'');
export const readyMessage=(site:string,project:ShareProject)=>'Read '+aiAddress(site,project)+' and help me give notes on '+pageLink(site,project)+'.';
// What Tris adds under Koan's approved text: how the client's AI writes notes the "Paste notes" box understands.
export const aiPage=(text:string,project:Pick<ShareProject,'sections'|'version'>)=>text.trim()+'\n\nHOW TO WRITE NOTES\nWrite one line per note, as: Section: note\n'+(project.sections.length?'Sections on this page: '+project.sections.join('; ')+'\n':'')+'The client pastes your lines into the "Paste notes" box at the bottom right of the page (version '+project.version+').\n';
export const aiSystem='Write a short plain-text page that a client\'s AI assistant will read, so it can help the client give notes on a web page we shared with them. Use these headings in capitals, each followed by a few short plain lines: WHAT THIS PROJECT IS; THE BRIEF; DECISIONS SO FAR; WHAT CHANGED IN THIS VERSION; HOW WE WORK; OPEN QUESTIONS. Use only what the records show. Leave out anything private: keys, passwords, file paths, prices, other clients, and internal tools. Do not explain how to write notes; that part is added after yours.';

// "Koan: Ana left 2 notes on index.html" for each person, newest first.
export function noteMessages(title:string,notes:ShareNote[]){
 const people=new Map<string,ShareNote[]>();for(const note of notes)people.set(note.name,[...(people.get(note.name)||[]),note]);
 return [...people].map(([name,rows])=>title+': '+name+' left '+rows.length+' note'+(rows.length===1?'':'s')+' on '+(rows[0].page.split('/').filter(Boolean).slice(1).join('/')||'the page'));
}
export const notesForModel=(link:string,version:number,notes:ShareNote[])=>'Client notes on '+link+' (version '+version+'):\n'+notes.map(note=>'- '+note.name+(note.version!=null&&note.version<version?' (on version '+note.version+')':'')+': '+note.text).join('\n');

// The site: the app's share\ folder (Worker, notes layer, schema) copied in; published pages are never overwritten.
export async function stageSite(template:string,site:string,databaseId:string){
 await fs.mkdir(site,{recursive:true});
 // Only the notes layer comes from the app's public\ (the installed app ships nothing else there).
 await fs.cp(path.join(template,'public','_notes'),path.join(site,'public','_notes'),{recursive:true,force:true});
 for(const file of ['src/worker.js','schema.sql','package.json']){await fs.mkdir(path.dirname(path.join(site,file)),{recursive:true});await fs.copyFile(path.join(template,file),path.join(site,file));}
 await fs.writeFile(path.join(site,'migrate.sql'),'ALTER TABLE notes ADD COLUMN version INTEGER;\n');
 await fs.writeFile(path.join(site,'wrangler.jsonc'),JSON.stringify({name:WORKER,main:'src/worker.js',compatibility_date:'2026-06-01',assets:{directory:'./public',binding:'ASSETS',run_worker_first:true},d1_databases:[{binding:'NOTES',database_name:DATABASE,database_id:databaseId}]},null,2)+'\n');
}
// A project's folder holds its latest version: the page bundle, its settings and the approved AI page.
export async function writeProject(site:string,project:ShareProject,bundle?:Map<string,Buffer>){
 const folder=path.join(site,'public',project.shareId);await fs.mkdir(folder,{recursive:true});
 if(bundle){
  for(const entry of await fs.readdir(folder))if(!['for-ai.txt','_share.json'].includes(entry))await fs.rm(path.join(folder,entry),{recursive:true,force:true});
  for(const [file,data] of bundle){const target=path.join(folder,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);}
 }
 await fs.writeFile(path.join(folder,'_share.json'),JSON.stringify({version:project.version,aiKey:project.aiKey,...(project.password?{password:project.password}:{})}));
 if(project.ai)await fs.writeFile(path.join(folder,'for-ai.txt'),aiPage(project.ai.text,{sections:project.sections,version:project.ai.version}));
}

// wrangler, the npm-installed copy in the site folder or one on PATH. Arguments never hold spaces (Windows .cmd).
export async function findWrangler(site:string,saved?:string){
 for(const candidate of [saved,process.env.TRISMEGISTUS_TEST_WRANGLER,path.join(site,'node_modules','.bin','wrangler.cmd')])if(candidate&&await fs.access(candidate).then(()=>true,()=>false))return candidate;
 return await new Promise<string|null>(resolve=>execFile('where',['wrangler.cmd'],{windowsHide:true,timeout:10000},(error,stdout)=>resolve(error?null:stdout.split(/\r?\n/).find(Boolean)||null)));
}
export function run(command:string,args:string[],cwd:string,signal?:AbortSignal,timeout=300000){
 if(args.some(arg=>/[\s"&|<>^%]/.test(arg)))throw Error('Share commands take simple arguments only.');
 return new Promise<string>((resolve,reject)=>{
  const child=spawn(command,args,{cwd,windowsHide:true,shell:/\.(cmd|bat)$/i.test(command),env:{...process.env,WRANGLER_SEND_METRICS:'false',NO_COLOR:'1',FORCE_COLOR:'0'},stdio:['ignore','pipe','pipe']});
  let out='';const add=(chunk:Buffer)=>{out=(out+chunk.toString()).slice(-200000);};child.stdout.on('data',add);child.stderr.on('data',add);
  const stop=()=>{if(child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});};
  const timer=setTimeout(stop,timeout);signal?.addEventListener('abort',stop,{once:true});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(signal?.aborted)reject(Error('Stopped.'));else if(code===0)resolve(out);else reject(Error(out.trim().split(/\r?\n/).slice(-6).join('\n')||'wrangler failed ('+code+').'));});
 });
}
// What wrangler prints: the database id ("database_id": "…" or database_id = "…") and the deployed address.
export const databaseIdOf=(output:string)=>/database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i.exec(output)?.[1]||null;
export function deployedUrl(output:string,test=false){return /https:\/\/[\w.-]+\.workers\.dev\b/.exec(output)?.[0]||(test?/http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]:undefined)||null;}
