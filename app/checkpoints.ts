import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store';
import type {WorkAction} from './work-coordination';
import type {Chat,Turn,ToolCall} from './types';
import {workspacePath} from './workspace-files';

const limit=2*1024*1024;
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
type Capture={id:string;job:string;root:string;blob?:string;reason?:string};
type Blob={id:string;bytes:string};
export type CheckpointFile={path:string;action:'restore'|'remove'|'unchanged'|'preserve';reason:string;before:string|null;current:string|null;beforeText:string;currentText:string;truncated:boolean};
export type CheckpointPreview={chatId:string;turnId:string;root:string;revision:string;files:CheckpointFile[];otherActions:{name:string;count:number}[]};

function bytesAt(file:string){
 try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>limit)throw Error('Only regular files up to 2 MB can be restored.');const bytes=fs.readFileSync(file);if(bytes.length>limit)throw Error('File exceeds the 2 MB checkpoint limit.');return bytes;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
function text(bytes:Buffer|null){return bytes===null?'':bytes.includes(0)?'[Binary file]':bytes.toString('utf8').slice(0,16000);}
function location(root:string,file:string){
 const base=fs.realpathSync(root),relative=path.relative(base,file);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('The file is outside this working folder.');
 // Resolve an absent file through its nearest existing parent, retaining link checks.
 let existing=file,tail:string[]=[];
 while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)throw Error('The file location is unavailable.');tail.unshift(path.basename(existing));existing=parent;}
 const resolved=path.join(workspacePath(base,path.relative(base,existing)),...tail);
 if(!samePath(resolved,file))throw Error('The file location changed.');
 return relative;
}

// Both Hermes and native Claude enter through WorkCoordination before a write.
// Capture only exact direct edits; shell commands and external effects stay explicit.
export function captureCheckpoint(store:Store,action:WorkAction,root:string){
 if(action.access!=='write'||action.resource==='*'||action.resource.startsWith('process:'))return;
 const record:Capture={id:action.id,job:action.job,root:fs.realpathSync(root)};
 try{
  location(record.root,action.resource);
  if(!action.expectedAfter)throw Error('This tool does not provide an exact file result to verify.');
  const bytes=bytesAt(action.resource);
  if((bytes===null?null:hash(bytes))!==action.before){const error=Error('The file changed. Read it again before writing.');Object.assign(error,{changed:true});throw error;}
  if(bytes!==null){record.blob=hash(bytes);store.put<Blob>('checkpoint-blob',{id:record.blob,bytes:bytes.toString('base64')});}
 }catch(error){if((error as any).changed)throw error;record.reason=(error as Error).message;}
 store.put('checkpoint-file',record);
}

function scope(store:Store,chatId:string,turnId:string){
 const chat=store.get<Chat>('chat',chatId),turns=store.all<Turn>('turn'),selected=turns.find(t=>t.id===turnId);
 if(chat.parentChatId||chat.sideSourceId||!selected||selected.chatId!==chatId||selected.parentTurnId||selected.contextSnapshot||selected.automatic||selected.goal?.automatic)throw Error('Choose an ordinary message in this chat.');
 const roots=new Set(turns.slice(turns.indexOf(selected)).filter(t=>t.chatId===chatId).map(t=>t.id));
 const jobs=new Set(roots);let added=true;
 while(added){added=false;for(const t of turns)if(!jobs.has(t.id)&&(t.parentTurnId&&jobs.has(t.parentTurnId)||t.automatic&&jobs.has(t.automatic.originTurnId))){jobs.add(t.id);added=true;}}
 return {chat,selected,jobs};
}

export function previewCheckpoint(store:Store,chatId:string,turnId:string,root:string):CheckpointPreview{
 const {jobs}=scope(store,chatId,turnId),base=fs.realpathSync(root);
 const actions=store.all<WorkAction>('work-action').filter(a=>jobs.has(a.job)&&a.name!=='checkpoint_restore'),captures=new Map(store.all<Capture>('checkpoint-file').map(c=>[c.id,c]));
 const groups=new Map<string,WorkAction[]>();
 for(const action of actions)if(action.access==='write'&&action.resource!=='*'&&!action.resource.startsWith('process:')&&action.status!=='blocked')groups.set(action.resource,[...groups.get(action.resource)||[],action]);
 const files:CheckpointFile[]=[];
 for(const [file,chain] of groups){
  const first=chain[0],last=chain.at(-1)!,capture=captures.get(first.id);
  const row:CheckpointFile={path:path.relative(base,file),action:'preserve',reason:'',before:first.before,current:null,beforeText:'',currentText:'',truncated:false};
  try{
   row.path=location(base,file);
   for(let i=0;i<chain.length;i++){
    const a=chain[i],c=captures.get(a.id);
    if(!c)throw Error('This edit predates file checkpoints or has no saved checkpoint.');
    if(!samePath(c.root,base))throw Error('This edit belongs to a different working folder.');
    if(c.reason)throw Error(c.reason);
    if(a.status!=='completed'||a.after!==a.expectedAfter||!a.expectedAfter)throw Error('The exact completed edit could not be verified.');
    if(i&&a.before!==chain[i-1].after)throw Error('Other edits occurred between these changes. Your current file will be kept.');
   }
   const before=first.before===null?null:Buffer.from(store.get<Blob>('checkpoint-blob',capture!.blob!).bytes,'base64');
   if((before===null?null:hash(before))!==first.before)throw Error('The saved checkpoint could not be verified.');
   const current=bytesAt(file);row.current=current===null?null:hash(current);
   row.beforeText=text(before);row.currentText=text(current);row.truncated=(before?.length||0)>16000||(current?.length||0)>16000;
   if(row.current===row.before){row.action='unchanged';row.reason='Already matches this checkpoint.';}
   else if(row.current!==last.after)row.reason='Changed since the recorded edit. Your current file will be kept.';
   else{row.action=before===null?'remove':'restore';row.reason=before===null?'Remove the file created by this chat.':'Restore the earliest saved direct-edit checkpoint.';}
  }catch(error){row.reason=(error as Error).message;}
  files.push(row);
 }
 const names=new Map<string,number>();
 for(const a of actions)if(a.access!=='read'&&(!groups.has(a.resource)||a.access==='unknown')&&a.status!=='blocked')names.set(a.name,(names.get(a.name)||0)+1);
 const otherActions=[...names].map(([name,count])=>({name,count}));
 // Include history and action status so another completed turn invalidates an open preview.
 const revision=hash(JSON.stringify({base,jobs:[...jobs],actions,files}));
 return {chatId,turnId,root:base,revision,files,otherActions};
}

export function restoreCheckpoint(store:Store,chatId:string,turnId:string,root:string,revision:string){
 const preview=previewCheckpoint(store,chatId,turnId,root);
 if(typeof revision!=='string'||preview.revision!==revision)throw Error('Files or chat history changed. Refresh the preview before restoring.');
 const files=preview.files.filter(f=>f.action==='restore'||f.action==='remove');
 if(!files.length)throw Error('There are no verified file changes to restore.');
 const {selected}=scope(store,chatId,turnId),id=randomUUID(),results:{path:string;status:string;message:string}[]=[];
 // A durable context record and running action precede filesystem writes. A crash
 // becomes uncertain work at startup, never an automatic replay of the restore.
 const summary=()=>JSON.stringify({checkpoint:turnId,files:results,unchanged:preview.files.filter(f=>!files.includes(f)).map(f=>({path:f.path,reason:f.reason})),externalEffects:'Commands, services, Git operations and other external effects were not reversed. Inspect current state before acting.'});
 const notice:Turn={id,chatId,prompt:'User requested file checkpoint restoration. This record supersedes earlier file-write outcomes for the listed paths. Inspect their current state before further edits.',text:summary(),reasoning:'',status:'context',contextSnapshot:{turnId,status:'running'},model:selected.model,error:null,usage:null,created:Date.now()};
 store.transaction(()=>{
  store.put('turn',notice);store.put<ToolCall>('tool',{id,turnId:id,name:'checkpoint_restore',args:{turnId,files:files.map(f=>f.path)},result:summary(),status:'running'});
  for(const chat of store.all<Chat>('chat')){
   for(const engine of ['claude','hermes'] as const)store.put('engine',{...store.enginePosition(chat.id,engine),sessionId:null,uncertain:true});
   store.update<Chat>('chat',chat.id,{runtimeId:null,storedId:null});
  }
 });
 for(const file of files){
  const target=path.resolve(preview.root,file.path),action:WorkAction={id:randomUUID(),group:id,job:id,name:'checkpoint_restore',args:{path:target},resource:process.platform==='win32'?target.toLowerCase():target,access:'write',signature:id+file.path,before:file.current,expectedAfter:file.before??undefined,status:'running'};
  store.put('work-action',action);
  try{
   location(preview.root,target);
   const fd=fs.openSync(target,'r+');
   try{
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink>1||stat.size>limit)throw Error('The file identity changed or has multiple hard links.');
    const current=fs.readFileSync(fd);if(hash(current)!==file.current)throw Error('The file changed after preview. It was preserved.');
    if(!samePath(workspacePath(preview.root,file.path),target))throw Error('The file location changed.');
    const now=fs.statSync(target);if(now.ino!==stat.ino||now.dev!==stat.dev)throw Error('The file identity changed.');
    if(file.action==='remove')fs.unlinkSync(target);
    else{
     const before=Buffer.from(store.get<Blob>('checkpoint-blob',file.before!).bytes,'base64');if(hash(before)!==file.before)throw Error('Saved checkpoint failed verification.');
     // Like editor saves, synchronous comparison prevents app-owned interleaving.
     // Independent external programs can still race a filesystem write.
     let offset=0;while(offset<before.length)offset+=fs.writeSync(fd,before,offset,before.length-offset,offset);
     fs.ftruncateSync(fd,before.length);fs.fsyncSync(fd);
    }
   }finally{fs.closeSync(fd);}
   const after=bytesAt(target);if((after===null?null:hash(after))!==file.before)throw Error('The restored file no longer matches. Inspect it before retrying.');
   store.update<WorkAction>('work-action',action.id,{status:'completed',after:file.before,result:'Restored by the user.'});
   results.push({path:file.path,status:'restored',message:file.reason});
  }catch(error){store.update<WorkAction>('work-action',action.id,{status:'uncertain',result:String(error)});results.push({path:file.path,status:'needs-inspection',message:String(error)});break;}
  finally{store.update<Turn>('turn',id,{text:summary()});store.update<ToolCall>('tool',id,{result:summary()});}
 }
 for(const file of files)if(!results.some(r=>r.path===file.path))results.push({path:file.path,status:'not-restored',message:'Restore stopped after an error.'});
 const status=results.every(r=>r.status==='restored')?'completed':'uncertain';
 store.update<Turn>('turn',id,{text:summary(),contextSnapshot:{turnId,status}});store.update<ToolCall>('tool',id,{result:summary(),status});
 return {results,preserved:preview.files.filter(f=>f.action==='preserve').length};
}
