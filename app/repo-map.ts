import fs from 'node:fs/promises';
import path from 'node:path';

// The repo map answers "how does this app work" for the app page and for the model that develops it.
// A map that takes a minute to draw is a map nobody keeps updated, so the walk is strictly bounded:
// dependency trees, build output and caches are skipped, and line/import reading stops at a budget.
const MAX_FILES=12000,MAX_READ=4000,MAX_BYTES=200_000,READ_BUDGET=25_000_000,TIME_BUDGET=2500;
const SKIP_DIRS=new Set(['node_modules','dist','build','out','coverage','.next','.turbo','.venv','venv','env','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.svelte-kit','runtime','vendor','third-party','third_party','work','tmp','temp','obj','target','bin_old']);
const CODE=['ts','tsx','mts','cts','js','jsx','mjs','cjs','py','ps1','sh','bash','rs','go','rb','cs','cpp','cc','c','h','hpp','java','kt','swift','html','css','scss','sql'];
const DOCS=['md','mdx','txt','rst','adoc'];
const DATA=['json','jsonl','csv','yaml','yml','toml','ini','cfg','xml'];
const ASSETS=['png','jpg','jpeg','gif','svg','webp','ico','bmp','mp4','mov','mp3','wav','woff','woff2','ttf','otf','pdf','zip','gz','exe','dll','node'];
const LANGUAGES:Record<string,string>={ts:'TypeScript',tsx:'TypeScript',mts:'TypeScript',cts:'TypeScript',js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',py:'Python',ps1:'PowerShell',sh:'Shell',bash:'Shell',rs:'Rust',go:'Go',rb:'Ruby',cs:'C#',cpp:'C++',cc:'C++',c:'C',h:'C header',hpp:'C++ header',java:'Java',kt:'Kotlin',swift:'Swift',html:'HTML',css:'CSS',scss:'CSS',sql:'SQL',json:'JSON',jsonl:'JSON',yaml:'YAML',yml:'YAML',toml:'TOML',ini:'Config',cfg:'Config',md:'Markdown',mdx:'Markdown',txt:'Text',rst:'Text',csv:'CSV',xml:'XML'};
const READABLE=new Set([...CODE,...DOCS,...DATA]);
const CODE_READ=new Set(CODE);

export interface RepoMapNote {path:string;note:string;}
export interface RepoMapFlow {name:string;steps:string[];}
// What a model may write at the repo root. Everything is optional: the scan alone still draws a map.
export interface RepoMapFile {summary?:string;entries?:RepoMapNote[];flows?:RepoMapFlow[];nodes?:Record<string,string>;}
export interface RepoMapNode {id:string;label:string;kind:'code'|'tests'|'docs'|'data'|'other';files:number;lines:number;note?:string;}
export interface RepoMapEdge {from:string;to:string;count:number;}
export interface RepoMap {
 name:string;root:string;files:number;lines:number;updated:number;
 nodes:RepoMapNode[];edges:RepoMapEdge[];languages:{name:string;files:number;lines:number}[];
 entries:RepoMapNote[];flows:RepoMapFlow[];summary:string;described:boolean;truncated:boolean;error:string;fileError:string;
}

export const repoMapFileName='REPO-MAP.json';

const extension=(file:string)=>path.extname(file).slice(1).toLowerCase();
function nodeKind(name:string,code:number,other:number):RepoMapNode['kind']{
 if(/^(tests?|spec|specs|e2e|__tests__)$/i.test(name))return 'tests';
 if(/^(docs?|doc|evidence|website|wiki|manual)$/i.test(name))return 'docs';
 if(/^(assets?|data|fixtures?|public|static|media|images?|samples?)$/i.test(name))return 'data';
 return code>=other?'code':'other';
}
const childKey=(name:string)=>name.startsWith('.')?'(root files)':name;
function readableExtension(file:string){const ext=extension(file);return (READABLE.has(ext)||CODE_READ.has(ext))&&!ASSETS.includes(ext);}

// Import specifiers only count when they leave their own top-level folder, so the map shows areas talking to areas.
function specifierTargets(text:string,ext:string){
 const out:string[]=[];
 if(ext==='py'){
  for(const match of text.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)|import[ \t]+([A-Za-z_][\w.]*))/gm))out.push(match[1]||match[2]);
  return out;
 }
 for(const match of text.matchAll(/(?:from|require\(|import\()\s*['"]([^'"]+)['"]/g))out.push(match[1]);
 return out;
}
function resolvesToKey(specifier:string,fromFile:string,key:string,keys:Set<string>){
 const clean=specifier.replace(/[\\/]+$/,'');
 if(clean.startsWith('.')){
  const parts=clean.split(/[\\/]/).filter(part=>part&&part!=='.'),stack=fromFile.split('/').slice(0,-1).filter(Boolean);
  for(const part of parts){if(part==='..'){stack.pop();continue;}stack.push(part);}
  const top=stack[0]||'(root files)';
  return top===key?'':(keys.has(top)?top:'');
 }
 const top=clean.split(/[\\/.]/)[0];
 return top&&top!==key&&keys.has(top)?top:'';
}
function entryPoints(files:string[]){
 const wanted=/^(?:(.*)\/)?(main|index|server|cli|app)\.(ts|tsx|js|mjs|cjs|py|html)$/;
 const mains:RepoMapNote[]=[];
 if(files.includes('package.json'))mains.push({path:'package.json',note:'Package manifest: scripts, dependencies and build targets'});
 const found=files.filter(file=>wanted.test(file)&&file.split('/').length<=3).sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b)).slice(0,8);
 return [...mains,...found.map(file=>({path:file,note:''}))];
}

// A repo map file is model-written, so every field is read defensively and a bad file only costs its own description.
export function readRepoMapFile(text:string):{file:RepoMapFile;error:string}{
 const fail=(error:string)=>({file:{},error});
 if(text.length>20_000)return fail(`${repoMapFileName} is larger than 20 KB.`);
 let raw:unknown;
 try{raw=JSON.parse(text);}catch{return fail(`${repoMapFileName} is not valid JSON.`);}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail(`${repoMapFileName} must be a JSON object.`);
 const value=raw as Record<string,unknown>,file:RepoMapFile={};
 if(value.summary!==undefined){if(typeof value.summary!=='string'||value.summary.length>400||!value.summary.trim())return fail(`${repoMapFileName} summary must be text up to 400 characters.`);file.summary=value.summary.trim();}
 if(value.entries!==undefined){if(!Array.isArray(value.entries)||value.entries.length>30)return fail(`${repoMapFileName} entries must be a list of up to 30 files.`);const entries:RepoMapNote[]=[];for(const row of value.entries){const item=row as Record<string,unknown>;if(!item||typeof item.path!=='string'||!item.path.trim()||item.path.length>300)return fail(`${repoMapFileName} entries need a file path.`);if(item.note!==undefined&&(typeof item.note!=='string'||item.note.length>200))return fail(`${repoMapFileName} entry notes must be text up to 200 characters.`);entries.push({path:item.path.trim().replace(/\\/g,'/').replace(/^\.\//,''),note:typeof item.note==='string'?item.note.trim():''});}file.entries=entries;}
 if(value.flows!==undefined){if(!Array.isArray(value.flows)||value.flows.length>12)return fail(`${repoMapFileName} flows must be a list of up to 12.`);const flows:RepoMapFlow[]=[];for(const row of value.flows){const item=row as Record<string,unknown>;if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.length>120)return fail(`${repoMapFileName} flows need a short name.`);if(!Array.isArray(item.steps)||!item.steps.length||item.steps.length>10)return fail(`${repoMapFileName} flows need one to ten steps.`);const steps:string[]=[];for(const step of item.steps){if(typeof step!=='string'||!step.trim()||step.length>200)return fail(`${repoMapFileName} steps must be text up to 200 characters.`);steps.push(step.trim());}flows.push({name:item.name.trim(),steps});}file.flows=flows;}
 if(value.nodes!==undefined){if(!value.nodes||typeof value.nodes!=='object'||Array.isArray(value.nodes))return fail(`${repoMapFileName} nodes must map a folder name to what it does.`);const nodes:Record<string,string>={};for(const [key,note] of Object.entries(value.nodes as Record<string,unknown>)){if(!key.trim()||key.length>60||typeof note!=='string'||!note.trim()||note.length>300)return fail(`${repoMapFileName} node notes must be text up to 300 characters.`);nodes[key.trim()]=note.trim();}file.nodes=nodes;}
 return {file,error:''};
}

interface Scan {name:string;files:number;lines:number;truncated:boolean;nodes:Map<string,{files:number;lines:number;code:number;other:number}>;edges:Map<string,number>;languages:Map<string,{files:number;lines:number}>;filesList:string[];}

async function walk(root:string,onFile:(absolute:string,relative:string,size:number)=>Promise<boolean>){
 const queue:[string,string][]=[[root,'']];let visited=0;let truncated=false;
 while(queue.length){
  const [absolute,relative]=queue.shift()!;
  let entries;
  try{entries=await fs.readdir(absolute,{withFileTypes:true});}catch{continue;}
  for(const entry of entries){
   const child=relative?relative+'/'+entry.name:entry.name;
   if(entry.isSymbolicLink())continue;
   if(entry.isDirectory()){if(SKIP_DIRS.has(entry.name)||entry.name.startsWith('.')||entry.name.startsWith('release-'))continue;queue.push([path.join(absolute,entry.name),child]);continue;}
   if(!entry.isFile())continue;
   visited++;
   if(visited>MAX_FILES){truncated=true;return truncated;}
   let size=0;
   try{size=(await fs.stat(path.join(absolute,entry.name))).size;}catch{continue;}
   if(await onFile(path.join(absolute,entry.name),child,size))return true;
  }
 }
 return truncated;
}

// Only the repo root is walked; readFile is injected so tests need no real repository.
export async function scanRepo(root:string,readFile:(file:string)=>Promise<string>=file=>fs.readFile(file,'utf8')):Promise<Scan>{
 const nodes:Scan['nodes']=new Map(),edges=new Map<string,number>(),languages=new Map<string,{files:number;lines:number}>(),filesList:string[]=[];
 let files=0,lines=0,read=0,bytes=0;const started=Date.now();
 const stats=(node:string)=>{const row=nodes.get(node)||{files:0,lines:0,code:0,other:0};nodes.set(node,row);return row;};
 const truncated=await walk(root,async(absolute,relative,size)=>{
  files++;filesList.push(relative);
  const node=childKey(relative.split('/')[0]),ext=extension(relative),language=LANGUAGES[ext],row=stats(node);
  row.files++;
  if(!language||!READABLE.has(ext))return false;
  if(read>=MAX_READ||bytes>READ_BUDGET||size>MAX_BYTES||Date.now()-started>TIME_BUDGET)return true;
  let text='';try{text=await readFile(absolute);}catch{return false;}
  read++;bytes+=text.length;
  const count=text?text.split('\n').length:0;
  lines+=count;
  row.lines+=count;if(CODE_READ.has(ext))row.code+=count;else row.other+=count;
  const languageRow=languages.get(language)||{files:0,lines:0};languageRow.files++;languageRow.lines+=count;languages.set(language,languageRow);
  if(!CODE_READ.has(ext))return false;
  const keys=new Set([...nodes.keys(),'(root files)']);
  for(const specifier of specifierTargets(text,ext)){const target=resolvesToKey(specifier,relative,node,keys);if(target)edges.set(node+'→'+target,(edges.get(node+'→'+target)||0)+1);}
  return false;
 });
 return {name:path.basename(root)||root,files,lines,truncated,nodes,edges,languages,filesList};
}

export async function buildRepoMap(root:string,readFile?:(file:string)=>Promise<string>):Promise<RepoMap>{
 const empty:RepoMap={name:path.basename(root)||root,root,files:0,lines:0,updated:Date.now(),nodes:[],edges:[],languages:[],entries:[],flows:[],summary:'',described:false,truncated:false,error:'',fileError:''};
 try{
  const scan=await scanRepo(root,readFile);
  let file:RepoMapFile={},fileError='';
  try{const parsed=readRepoMapFile(await (readFile||(file=>fs.readFile(file,'utf8')))(path.join(root,repoMapFileName)));file=parsed.file;fileError=parsed.error;}catch{}
  const described=!!(file.summary||file.entries?.length||file.flows?.length||file.nodes);
  const nodes=[...scan.nodes].map(([id,row])=>({id,label:id,kind:nodeKind(id,row.code,row.other),files:row.files,lines:row.code+row.other,note:file.nodes?.[id]||file.nodes?.[id==='(root files)'?'.':id]})).sort((a,b)=>b.lines-a.lines||b.files-a.files||a.id.localeCompare(b.id));
  const edges=[...scan.edges].map(([id,count])=>{const [from,to]=id.split('→');return {from,to,count};}).filter(edge=>nodes.some(node=>node.id===edge.from)&&nodes.some(node=>node.id===edge.to)).sort((a,b)=>b.count-a.count).slice(0,40);
  const entries=(file.entries?.length?file.entries:entryPoints(scan.filesList)).slice(0,12);
  return {...empty,name:scan.name,files:scan.files,lines:scan.lines,truncated:scan.truncated,nodes,edges,entries,flows:file.flows||[],summary:file.summary||'',described,fileError,languages:[...scan.languages].map(([name,row])=>({name,...row})).sort((a,b)=>b.lines-a.lines||b.files-a.files).slice(0,8)};
 }catch(error){return {...empty,error:String(error instanceof Error?error.message:error).slice(0,200)};}
}

export interface RepoMapLayoutNode {node:RepoMapNode;x:number;y:number;width:number;height:number;}
export interface RepoMapLayoutEdge {edge:RepoMapEdge;x1:number;y1:number;x2:number;y2:number;curve:string;}
export interface RepoMapLayout {width:number;height:number;nodes:RepoMapLayoutNode[];edges:RepoMapLayoutEdge[];}

// Foundations on the left, their users on the right: a folder's column is one past the deepest folder it imports.
export function repoMapLayout(nodes:RepoMapNode[],edges:RepoMapEdge[]){
 const width=176,height=78,gapX=110,gapY=24,pad=18,columns=new Map<number,RepoMapNode[]>(),depth=new Map(nodes.map(node=>[node.id,0]));
 for(let pass=0;pass<12;pass++){let moved=false;for(const edge of edges){const from=depth.get(edge.from),to=depth.get(edge.to);if(from===undefined||to===undefined||from===to)continue;if(from<=to){depth.set(edge.from,to+1);moved=true;}}if(!moved)break;}
 for(const node of nodes){const column=depth.get(node.id)||0;columns.set(column,[...(columns.get(column)||[]),node]);}
 const placed:RepoMapLayoutNode[]=[],points=new Map<string,RepoMapLayoutNode>();let tallest=0,columns_used=0;
 for(const [column,rows] of [...columns].sort((a,b)=>a[0]-b[0])){columns_used++;rows.forEach((node,index)=>{const box={node,x:pad+column*(width+gapX),y:pad+index*(height+gapY),width,height};placed.push(box);points.set(node.id,box);});tallest=Math.max(tallest,rows.length);}
 const links:RepoMapLayoutEdge[]=edges.map(edge=>{const from=points.get(edge.from)!,to=points.get(edge.to)!;const backward=to.x<from.x,x1=backward?from.x:from.x+from.width,y1=from.y+from.height/2,x2=backward?to.x+to.width:to.x,y2=to.y+to.height/2,span=Math.max(30,Math.abs(x2-x1)/2);return {edge,x1,y1,x2,y2,curve:backward?`M ${x1} ${y1} C ${x1+span} ${y1} ${x2-span} ${y2} ${x2} ${y2}`:`M ${x1} ${y1} C ${x1+span} ${y1} ${x2-span} ${y2} ${x2} ${y2}`};});
 const layout:RepoMapLayout={width:pad*2+columns_used*width+(columns_used-1)*gapX,height:pad*2+tallest*height+Math.max(0,tallest-1)*gapY,nodes:placed,edges:links};
 return layout;
}
