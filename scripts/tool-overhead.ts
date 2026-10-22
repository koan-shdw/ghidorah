// Tris's own cost per tool call, measured on a copy of Koan's chat database (RUN-PLAN 3a/3h).
// Usage: node --import tsx scripts/tool-overhead.ts [chat.sqlite]   (default: %LOCALAPPDATA%\Trismegistus\chat.sqlite, copied first)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import {Store} from '../app/store';
import {WorkCoordination} from '../app/work-coordination';
import type {Turn} from '../app/types';

const source=process.argv[2]||path.join(process.env.LOCALAPPDATA!,'Trismegistus','chat.sqlite');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'tris-overhead-')),copy=path.join(work,'chat.sqlite');
fs.copyFileSync(source,copy);
const store=new Store(copy),reads=new Map<string,number>(),all=store.all.bind(store);
store.all=(<T>(kind:string)=>{reads.set(kind,(reads.get(kind)||0)+1);return all<T>(kind);}) as Store['all'];
const time=async(fn:()=>unknown)=>{const start=performance.now();await fn();return performance.now()-start;};
const median=(v:number[])=>[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)];

// The window refresh: emit() builds snapshot() for every change and sends it to each window.
const sizes:number[]=[],refresh:number[]=[];
// Since 3b a refresh leaves tools out and adds only the shown chats' tools (here: the newest chat).
const newest=all<Turn>('turn').at(-1)!.chatId;
for(let i=0;i<5;i++)refresh.push(await time(()=>{const light=store.snapshot({tools:false});const ids=light.turns.filter(turn=>turn.chatId===newest).map(turn=>turn.id);sizes.push(v8.serialize({...light,tools:store.whereIn('tool','turnId',ids)}).length);}));

// Read and Edit cycles through work coordination, on a real file, as one job of a real chat.
const turn=all<Turn>('turn').at(-1)!,folder=path.join(work,'files'),file=path.join(folder,'notes.txt');
fs.mkdirSync(folder);fs.writeFileSync(file,'line one\r\nline two\r\n');
const coordination=new WorkCoordination(store),signal=new AbortController().signal;
const cycle=async(name:string,args:any,change?:()=>void)=>{const id=await coordination.begin(turn.id,turn.id,folder,name,args,signal);change?.();await coordination.finish(id,turn.id,{ok:true});};
const results:Record<string,{ms:number[];reads:Record<string,number>}>={};
for(const [label,run] of [
  ['Read',()=>cycle('Read',{file_path:file})],
  ['Edit',async()=>{await cycle('Read',{file_path:file});const before=fs.readFileSync(file,'utf8'),next=before.replace('line two','line two!');await cycle('Edit',{file_path:file,old_string:'line two',new_string:'line two!'},()=>fs.writeFileSync(file,next));}],
] as const){
  const ms:number[]=[];reads.clear();
  for(let i=0;i<20;i++)ms.push(await time(run));
  results[label]={ms,reads:Object.fromEntries([...reads].map(([kind,n])=>[kind,Math.round(n/20*10)/10]))};
}
// main.ts looks up the turn's tools on each tool event (running, then done) to set the turn's activity.
const toolScan=median(await Promise.all([0,1,2].map(()=>time(()=>store.where('tool','turnId',turn.id)))));
store.db.close();fs.rmSync(work,{recursive:true,force:true});

console.log(`Window refresh (newest chat open): ${median(refresh).toFixed(0)} ms to build, ${(median(sizes)/1e6).toFixed(1)} MB sent, on every change.`);
for(const [label,{ms,reads}] of Object.entries(results))console.log(`${label}: ${median(ms).toFixed(0)} ms in work coordination per call; full-table reads per call: ${JSON.stringify(reads)}`);
console.log(`Tool events in main.ts: 2 lookups of the turn's tools per tool, ${toolScan.toFixed(1)} ms each.`);
