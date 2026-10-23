// Share work with clients, the Tris side (FEATURE-SPECS 3). Tris keeps its own copy of the share site in its data
// folder (share-site\), publishes a project's page under that project's private id, deploys it with Cloudflare's
// wrangler on Koan's own sign-in (no token is stored), reads clients' notes back, and keeps the "for your AI" page
// that Koan approves version by version. The same site holds Koan's own preview pages (FEATURE-SPECS 4).
import {spawn,execFile} from 'node:child_process';
import {randomBytes,pbkdf2Sync,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {crc32,deflateRawSync} from 'node:zlib';
import previewTools from '../plugins/trismegistus-permissions/preview-tools.json';

export interface ShareSettings {site:string;databaseId:string;ready:boolean;wrangler?:string;checked?:number;ownerKey?:string;pagesSince?:number}
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
export const notesForModel=(link:string,version:number,notes:ShareNote[],who='Client notes')=>who+' on '+link+' (version '+version+'):\n'+notes.map(note=>'- '+note.name+(note.version!=null&&note.version<version?' (on version '+note.version+')':'')+': '+note.text).join('\n');

// The site: the app's share\ folder (Worker, notes layer, schema) copied in; published pages are never overwritten.
export async function stageSite(template:string,site:string,databaseId:string){
 await fs.mkdir(site,{recursive:true});
 // Only the notes layer comes from the app's public\ (the installed app ships nothing else there).
 await fs.cp(path.join(template,'public','_notes'),path.join(site,'public','_notes'),{recursive:true,force:true});
 await fs.cp(path.join(template,'src'),path.join(site,'src'),{recursive:true,force:true});
 for(const file of ['schema.sql','package.json']){await fs.mkdir(path.dirname(path.join(site,file)),{recursive:true});await fs.copyFile(path.join(template,file),path.join(site,file));}
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

// Preview pages (FEATURE-SPECS 4), like Claude Code's artifacts: a model publishes an interactive page to a private
// link on Koan's share site. The site knows Koan by a key only Tris holds; it keeps each page's settings, Tris keeps
// which chat made it and where its file is.
export interface PreviewPage {id:string;chatId:string;sourcePath:string;title:string;description:string;entry:string;version:number;files:number;published:number;model:string;seenNotes?:number}
export const previewLink=(site:string,id:string)=>site+'/'+id+'/';
// A link to one of the pages (or its bare id) to the page's id.
export function previewIdOf(site:string,link:unknown){
 const text=typeof link==='string'?link.trim():'';if(/^[A-Za-z0-9_-]{16,64}$/.test(text))return text;
 if(!site||!text.startsWith(site+'/'))return null;return /^\/([A-Za-z0-9_-]{16,64})(?:\/|$)/.exec(text.slice(site.length))?.[1]||null;
}
export const ownerHash=(key:string)=>createHash('sha256').update(key).digest('hex');
// The page's folder holds exactly this version; a page of several files also gets the zip that Export hands out.
export async function writePreview(site:string,id:string,bundle:Map<string,Buffer>){
 const folder=path.join(site,'public',id);await fs.rm(folder,{recursive:true,force:true});await fs.mkdir(folder,{recursive:true});
 for(const [file,data] of bundle){const target=path.join(folder,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);}
 if(bundle.size>1)await fs.writeFile(path.join(folder,'_export.zip'),zip(bundle));
}
// A plain zip (deflate, no extras) of the page's files.
export function zip(files:Map<string,Buffer>){
 const parts:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [file,data] of files){
  const name=Buffer.from(file.split(path.sep).join('/')),packed=deflateRawSync(data),crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const head=Buffer.alloc(46);head.writeUInt32LE(0x02014b50,0);head.writeUInt16LE(20,4);head.writeUInt16LE(20,6);head.writeUInt16LE(0x0800,8);head.writeUInt16LE(8,10);head.writeUInt16LE(33,14);
  head.writeUInt32LE(crc,16);head.writeUInt32LE(packed.length,20);head.writeUInt32LE(data.length,24);head.writeUInt16LE(name.length,28);head.writeUInt32LE(offset,42);
  parts.push(local,name,packed);central.push(head,name);offset+=30+name.length+packed.length;
 }
 const size=central.reduce((total,part)=>total+part.length,0),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...parts,...central,end]);
}

// How a good page is made: Claude Code's artifact design fundamentals and Koan's mockup method (memory: mockup-method).
export const previewGuide=`MAKING A PREVIEW PAGE
A preview page is one self-contained HTML file (plus any images or scripts it links to in its own folder) that shows work better than text: a mockup, a comparison, a prototype, a dashboard, a report. The user opens it at a private link, can share it, and leaves notes on it that come back to you.

CONTENT
- Real content only: the user's real names, numbers, screenshots and words. Never lorem ipsum, never invented data presented as real.
- One clear job per page. The title is a short name of two to four words; the description is one sentence.
- Say what the page is for in its first lines; put the decision or result first.

LOOK
- A deliberate look that fits the subject, not a generic template: pick type, spacing and one accent color on purpose.
- Define colors as CSS variables on :root, with a dark theme under @media (prefers-color-scheme: dark), and give body an explicit background.
- Works at phone width: a 16px side gutter, no sideways scrolling, tap targets of at least 40px.
- Use h1 to h3 headings for the sections: notes are pinned to them.
- Scripts from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm or unpkg.com at an exact version; everything else inline. Keep it under 15 MB.
- The page runs in a sandbox: no cookies, and localStorage may be missing, so wrap storage in try/catch and work without it.

A VISUAL CHOICE (THE MOCKUP METHOD)
- "Now" first: the real app as it is, from real screenshots, never rebuilt from code.
- Then numbered versions side by side (V1, V2, ...). Keep the old versions when you add new ones.
- Show desktop and phone (a Both / Full switch), light and dark, and a Tune panel of sliders for the values the user may want to adjust (sizes, spacing, colors), showing their current values.
- Label every version with what changed, so the user can answer with a number.

PUBLISHING
- preview_page with action publish, the file's path, a title and a description. Publishing the same file again from this chat, or passing the page's link, updates that page and keeps its link.
- You do not need to ask first: a new page is private. Put the link in your reply; Ghidorah also shows it as a card with Open.
`;

// The model tool (code rule 2: this schema, the permissions plugin's mcp.py, request() and the Claude list).
export const previewTool={...previewTools[0],_meta:{'anthropic/alwaysLoad':true}};
