import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Marked} from 'marked';
import type {Backend} from './backend';
import type {Store} from './store';
import type {Chat,Turn,ToolCall} from './types';
import {chatFiles,readChatFile,type ChatFile} from './chat-files';
import {protectedChatPath} from './chat-links';
import {modelLabel} from './models';

export type ExportOptions={files:boolean;tools:boolean;reasoning:boolean};
export const exportDefaults:ExportOptions={files:true,tools:false,reasoning:false};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const safeName=(s:string)=>s.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'-').slice(0,120).replace(/[. ]+$/,'')||'file';
const inside=(base:string,target:string)=>{const p=path.relative(base,target);return !p||!path.isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+path.sep);};
type ExportFile=ChatFile&{path:string};

export function captureExport(store:Store,chatId:string,options:ExportOptions,clean:(text:string)=>string){
 if(!options||Object.keys(options).length!==3||Object.values(options).some(v=>typeof v!=='boolean')||!['files','tools','reasoning'].every(k=>Object.hasOwn(options,k)))throw Error('Invalid export options.');
 const chat=store.get<Chat>('chat',chatId),owned=new Set([chat.id,...(!chat.parentChatId?store.all<Chat>('chat').filter(c=>c.parentChatId===chat.id).map(c=>c.id):[])]);
 const turns=store.all<Turn>('turn').filter(t=>owned.has(t.chatId)).sort((a,b)=>a.created-b.created),ids=new Set(turns.map(t=>t.id));
 const files:ExportFile[]=options.files?chatFiles(store,chat.id).filter(f=>f.kind==='output'||f.turnId).map((f,i)=>({id:f.id,name:clean(f.name),size:f.size,kind:f.kind,turnId:f.turnId,model:f.model,created:f.created,sha256:f.sha256,blob:f.blob,path:'files/'+String(i+1).padStart(4,'0')+'-'+safeName(clean(f.name))})):[];
 if(files.length>1000||files.reduce((n,f)=>n+f.size,0)>1024**3)throw Error('This export exceeds 1 GB or 1,000 files. Export without files and save large files separately.');
 const tools=options.tools?store.all<ToolCall>('tool').filter(t=>ids.has(t.turnId)):[];
 const cleanObject=<T>(value:T):T=>{if(typeof value==='string')return clean(value) as T;if(Array.isArray(value))return value.map(cleanObject) as T;if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[clean(key),cleanObject(item)])) as T;return value;};
 const messages=turns.map(t=>cleanObject({id:t.id,chatId:t.chatId,parentTurnId:t.parentTurnId||null,role:t.automatic?'agent':t.goal?.automatic?'goal':'user',created:t.created,finished:t.finished||null,status:t.status,model:t.model,label:modelLabel(t.model),prompt:t.prompt,text:t.text,error:t.error,reasoning:options.reasoning?t.reasoning:undefined,attachments:(t.attachments||[]).map(a=>({id:'upload:'+a.id,name:a.name})),tools:tools.filter(tool=>tool.turnId===t.id).map(({id,name,args,result,status})=>({id,name,args,result,status}))}));
 return {version:1,title:clean(chat.title),chatId:chat.id,exportedAt:new Date().toISOString(),options:{...options},messages,files,aliases:{...chat.historyAliases},draftsExcluded:true};
}
export type ChatExport=ReturnType<typeof captureExport>;
export const exportInfo=(record:ChatExport)=>({title:record.title,turns:record.messages.length,files:record.files.length,bytes:record.files.reduce((sum,row)=>sum+row.size,0),active:record.messages.some(m=>['queued','running','waiting','dispatching','stopping'].includes(m.status))});

/** Only archived outputs are portable. Never copy arbitrary paths named in a reply. */
function exportLink(record:ChatExport,href:string):string|null{
 if(/^tris-output:[a-f0-9-]{36}$/.test(href)){const id=href.slice(12),row=record.files.find(f=>f.id==='output:'+(record.aliases[id]||id));return row?row.path.split('/').map(encodeURIComponent).join('/'):null;}
 if(/^https?:\/\//i.test(href))try{const url=new URL(href);if(!url.username&&!url.password&&!/[\x00-\x1f\x7f]/.test(href))return url.href;}catch{}
 return null;
}
export function exportMarkdown(record:ChatExport,text:string){
 const parser=new Marked({gfm:true});
 const inline=(tokens:any[]):string=>tokens.map(token=>{
  if(token.type==='link'||token.type==='image'){const label=token.type==='image'?token.text:inline(token.tokens||[]),href=exportLink(record,token.href);return href?`${token.type==='image'&&!/^https?:/.test(href)?'!':''}[${label}](<${href}>)`:label;}
  if(['strong','em','del'].includes(token.type)){const marker=token.type==='strong'?'**':token.type==='em'?'*':'~~';return marker+inline(token.tokens)+marker;}
  return token.raw;
 }).join('');
 const block=(tokens:any[]):string=>tokens.map(token=>{
  if(token.type==='heading')return '#'.repeat(token.depth)+' '+inline(token.tokens)+'\n\n';
  if(token.type==='paragraph'||token.type==='text')return (token.tokens?inline(token.tokens):token.text)+'\n\n';
  if(token.type==='blockquote')return block(token.tokens).trimEnd().split('\n').map(line=>'> '+line).join('\n')+'\n\n';
  if(token.type==='list')return token.items.map((item:any,i:number)=>{const bullet=token.ordered?String(Number(token.start)+i)+'. ':'- ',text=(item.task?'['+(item.checked?'x':' ')+'] ':'')+block(item.tokens).trimEnd();return bullet+text.split('\n').join('\n'+' '.repeat(bullet.length));}).join('\n')+'\n\n';
  if(token.type==='table'){const row=(cells:any[])=>'| '+cells.map(c=>inline(c.tokens)).join(' | ')+' |\n';return row(token.header)+'| '+token.align.map((a:string)=>a==='center'?':---:':a==='right'?'---:':a==='left'?':---':'---').join(' | ')+' |\n'+token.rows.map(row).join('')+'\n';}
  return token.raw;
 }).join('');
 return block(parser.lexer(text));
}

function renderText(record:ChatExport,text:string){
 const parser=new Marked({gfm:true,renderer:{
  html({text}){return escape(text);},
  code({text,lang}){return '<pre><code'+(lang?' data-language="'+escape(lang.split(/\s/)[0])+'"':'')+'>'+escape(text)+'</code></pre>';},
  link({href,tokens}){const target=exportLink(record,href),label=this.parser.parseInline(tokens);return target?'<a href="'+escape(target)+'" rel="noreferrer noopener">'+label+'</a>':'<span title="File or link not included">'+label+'</span>';},
  image({href,text}){const target=exportLink(record,href);return target&&!/^https?:/.test(target)&&/\.(?:png|jpe?g|gif|webp|avif)$/i.test(target)?'<img loading="lazy" src="'+escape(target)+'" alt="'+escape(text)+'">':target?'<a href="'+escape(target)+'" rel="noreferrer noopener">'+escape(text||'Image')+'</a>':escape(text);}
 }});return parser.parse(text,{async:false}) as string;
}
export function exportDocuments(record:ChatExport){
 const fileLink=(file:ExportFile)=>file.path.split('/').map(encodeURIComponent).join('/');
 let markdown='# '+record.title.replace(/[\r\n]/g,' ')+'\n\nExported '+record.exportedAt+'. Unsent drafts are excluded.\n\n';
 const rendered=record.messages.map(message=>{
  const stamp=new Date(message.created).toISOString(),promptLabel=message.role==='agent'?'Agent task':message.role==='goal'?'Goal continuation':'You';
  const attachments=record.files.filter(f=>message.attachments.some(a=>a.id===f.id)),outputs=record.files.filter(f=>f.kind==='output'&&f.turnId===message.id);
  markdown+='## '+promptLabel+' · '+stamp+'\n\n'+exportMarkdown(record,message.prompt)+'\n\n## '+message.label+' · '+message.status+'\n\n'+exportMarkdown(record,message.text)+'\n\n';
  if(message.error)markdown+='Error: '+message.error+'\n\n';
  if(message.reasoning)markdown+='### Thinking\n\n'+exportMarkdown(record,message.reasoning)+'\n\n';
  for(const tool of message.tools)markdown+='### Tool: '+tool.name+' · '+tool.status+'\n\n'+JSON.stringify({input:tool.args,output:tool.result},null,2).split('\n').map(line=>'    '+line).join('\n')+'\n\n';
  const linked=[...attachments,...outputs];if(linked.length)markdown+='### Files\n\n'+linked.map(f=>'- ['+f.name.replace(/[\[\]\\]/g,'\\$&')+'](<'+fileLink(f)+'>)').join('\n')+'\n\n';
  return '<article id="turn-'+escape(message.id)+'"><header>'+escape(promptLabel)+' <time>'+escape(stamp)+'</time>'+(message.parentTurnId?' · Linked job':'')+'</header><div class="prompt">'+renderText(record,message.prompt)+'</div><header><strong>'+escape(message.label)+'</strong><span>'+escape(message.status)+'</span></header><div class="reply">'+renderText(record,message.text)+'</div>'+(message.error?'<p class="error">'+escape(message.error)+'</p>':'')+(message.reasoning?'<details><summary>Thinking</summary>'+renderText(record,message.reasoning)+'</details>':'')+message.tools.map(t=>'<details><summary>'+escape(t.name)+' · '+escape(t.status)+'</summary><pre>'+escape(JSON.stringify({input:t.args,output:t.result},null,2))+'</pre></details>').join('')+(linked.length?'<ul class="files">'+linked.map(f=>'<li><a href="'+escape(fileLink(f))+'">'+escape(f.name)+'</a> · '+(f.kind==='upload'?'Upload':'Saved output')+'</li>').join('')+'</ul>':'')+'</article>';
 }).join('\n');
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'self\'; base-uri \'none\'; form-action \'none\'"><title>'+escape(record.title)+'</title><style>html{color-scheme:dark;font:16px/1.65 system-ui,sans-serif;background:#141413;color:#eae8df;overflow-wrap:anywhere}body{max-width:900px;margin:48px auto;padding:0 28px}h1{line-height:1.2;font-size:32px}h2,h3{line-height:1.3}p{overflow-wrap:anywhere}a{color:#98c9ff}article{padding:30px 0;border-top:1px solid #45453e}header{display:flex;gap:14px;flex-wrap:wrap;color:#c6c5ba;font-size:14px;margin:12px 0}time{margin-left:auto}.prompt{background:#232321;padding:8px 20px;border-radius:14px;margin-bottom:24px}pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#20201d;padding:16px;border-radius:8px;font-size:13px}code{font-family:ui-monospace,monospace}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #57564e;padding:8px 12px}img{max-width:100%;height:auto}details{margin:16px 0}summary{cursor:pointer}.files{font-size:14px}.error{color:#ffba9b}.intro{color:#c6c5ba}blockquote{border-left:3px solid #969181;margin-left:0;padding-left:20px}@media print{html{background:white;color:black}a{color:#0645ad}.prompt,pre{background:#f4f4f4}header,.intro{color:#444}details{break-inside:avoid}}</style></head><body><h1>'+escape(record.title)+'</h1><p class="intro">Ghidorah · Exported '+escape(record.exportedAt)+'<br>Snapshot of sent messages and selected saved files. Unsent drafts are excluded. Included files open locally; web links open their original sites.</p>'+rendered+'<section><h2>Included files</h2><ul>'+record.files.map(f=>'<li><a href="'+escape(fileLink(f))+'">'+escape(f.name)+'</a> · '+f.size.toLocaleString('en-US')+' bytes</li>').join('')+'</ul></section></body></html>';
 const {files,aliases,...publicRecord}=record;
 return {'conversation.html':html,'conversation.md':markdown,'conversation.json':JSON.stringify({...publicRecord,files:files.map(({blob,...row})=>row)},null,2),'README.txt':'Extract this ZIP, then open conversation.html in a browser. Keep the files folder beside the conversation.\nconversation.md is the Markdown copy; conversation.json contains the exported records and file checksums.\nOnly included Chat files are copied. Links to working files that were never saved in Chat files are plain text in the readable export. Unsent drafts and account settings are excluded. Known credentials in messages are redacted.\nSaved artifacts retain their original bytes and may have their own dependencies or active content.\n'};
}

export async function writeChatExport(backend:Backend,record:ChatExport,destination:string,signal:AbortSignal){
 signal.throwIfAborted();const parent=await fs.realpath(path.dirname(destination));destination=path.join(parent,path.basename(destination));
 if(path.extname(destination).toLowerCase()!=='.zip'||inside(await fs.realpath(backend.dataRoot),destination)||protectedChatPath(destination))throw Error('Choose a ZIP file outside private account and app data folders.');
 const stat=async()=>fs.lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;}),before=await stat();if(before&&!before.isFile())throw Error('Choose a regular ZIP file destination.');
 const exports=path.join(backend.dataRoot,'exports');await fs.mkdir(exports,{recursive:true});if((await fs.realpath(exports)).toLowerCase()!==exports.toLowerCase())throw Error('Export staging location changed.');
 const staging=path.join(exports,randomUUID());await fs.mkdir(staging);const temp=path.join(parent,'.tris-export-'+randomUUID()+'.tmp');
 try{
  const documents=exportDocuments(record);if(Object.values(documents).reduce((n,s)=>n+Buffer.byteLength(s),0)>50*1024*1024)throw Error('The conversation export exceeds 50 MB. Try excluding tool details and thinking.');
  for(const [name,content] of Object.entries(documents)){signal.throwIfAborted();await fs.writeFile(path.join(staging,name),content,{flag:'wx'});}
  if(record.files.length)await fs.mkdir(path.join(staging,'files'));
  for(const row of record.files){signal.throwIfAborted();const bytes=await readChatFile(backend.dataRoot,row);await fs.writeFile(path.join(staging,row.path),bytes,{flag:'wx'});}
  const packed=await backend.host('chat_export',{staging},signal);signal.throwIfAborted();if(packed.file!==path.join(staging,'export.zip'))throw Error('Invalid export archive location.');
  await fs.copyFile(packed.file,temp,1);signal.throwIfAborted();
  const now=await stat();if(!!now!==!!before||now&&before&&(!now.isFile()||now.ino!==before.ino||now.size!==before.size||now.mtimeMs!==before.mtimeMs))throw Error('The destination changed during export. Choose a new filename.');
  if((await fs.realpath(parent)).toLowerCase()!==parent.toLowerCase())throw Error('The destination folder changed during export.');
  await fs.rename(temp,destination);return {saved:true,file:destination,turns:record.messages.length,files:record.files.length};
 }finally{await fs.unlink(temp).catch(()=>{});if((await fs.realpath(staging).catch(()=>'' )).toLowerCase()===staging.toLowerCase())await fs.rm(staging,{recursive:true,force:true});}
}
