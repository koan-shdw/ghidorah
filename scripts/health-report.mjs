// Tris health report from Koan's real use (HANDOFF section 3, TRIS-TODO 2.1). Read-only: queue.log, chat.sqlite and
// the Tris Opus transcripts. Usage: node scripts/health-report.mjs [from YYYY-MM-DD] [to YYYY-MM-DD]   (local dates)
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const day=(text,end=false)=>{const d=new Date(text+'T00:00:00');if(end)d.setDate(d.getDate()+1);return d.getTime();};
const today=new Date().toLocaleDateString('sv');
const from=day(process.argv[2]||today),to=day(process.argv[3]||process.argv[2]||today,true);
const data=path.join(process.env.LOCALAPPDATA,'Trismegistus');
// A consistent copy (VACUUM INTO) is read, never the live file: with WAL the copy does not hold up Tris's writes.
const copy=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'tris-health-')),'chat.sqlite');
{const live=new DatabaseSync(path.join(data,'chat.sqlite'),{readOnly:true});live.exec(`VACUUM INTO '${copy.replaceAll("'","''")}'`);live.close();}
const db=new DatabaseSync(copy,{readOnly:true});
const rows=kind=>db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.data));
const local=ms=>new Date(ms).toLocaleString('sv').slice(5,16);
const median=v=>{if(!v.length)return NaN;const s=[...v].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
const out=[];const say=text=>out.push(text);

const turns=rows('turn').filter(t=>t.created>=from&&t.created<to).sort((a,b)=>a.created-b.created),byId=new Map(rows('turn').map(t=>[t.id,t]));
const chats=new Map(rows('chat').map(c=>[c.id,c.title||'']));
say(`Tris health report ${local(from)} to ${local(to-1)}`);

// 1. Holds: a waiting message should go within a second of the turn ahead ending.
say('\n1. Queue holds');
const log=fs.existsSync(path.join(data,'queue.log'))?fs.readFileSync(path.join(data,'queue.log'),'utf8').trim().split('\n'):[];
let holds=0,stalls=0;const open=new Map();
for(const line of log){
  const at=Date.parse(line.slice(0,24));if(!(at>=from&&at<to))continue;
  const m=/turn=(\S+) (held|released)/.exec(line),active=/active=(\S+)/.exec(line)?.[1];if(!m)continue;
  if(m[2]==='held'){if(!open.has(m[1])){holds++;open.set(m[1],{at,active});}else if(active)open.get(m[1]).active=active;continue;}
  const [id,hold]=m[1]==='-'?[...open.entries()].at(-1)||[]:[m[1],open.get(m[1])];if(!hold)continue;open.delete(id);
  const ahead=hold.active&&byId.get(hold.active)?.finished,late=ahead?(at-ahead)/1000:null;
  if(late===null||late>5){stalls++;say(`   STALL? ${local(hold.at)} held ${((at-hold.at)/1000).toFixed(0)} s, released ${late===null?'(turn ahead unknown)':late.toFixed(1)+' s after the turn ahead ended'}`);}
}
say(`   ${holds} holds, ${stalls} released more than 5 s after the turn ahead ended${open.size?`, ${open.size} never released`:''}.`);

// 2. Turns, stops and failures.
say('\n2. Turns');
const count=status=>turns.filter(t=>t.status===status).length;
say(`   ${turns.length} turns: ${count('completed')} completed, ${count('stopped')} stopped, ${count('failed')} failed, ${count('interrupted')} interrupted.`);
for(const t of turns.filter(t=>t.status==='stopped')){
  const next=turns.find(n=>n.chatId===t.chatId&&n.created>t.created&&n.prompt?.trim());
  say(`   stop ${local(t.created)} ${t.model} after ${t.finished?((t.finished-t.created)/1000).toFixed(0)+' s':'?'} (${t.stopReason||'no reason'}): "${(t.prompt||'').slice(0,60).replace(/\s+/g,' ')}" -> next: "${(next?.prompt||'').slice(0,80).replace(/\s+/g,' ')}"`);
}
for(const t of turns.filter(t=>['failed','interrupted'].includes(t.status)))say(`   ${t.status} ${local(t.created)} ${t.model}: ${String(t.error||'').slice(0,140).replace(/\s+/g,' ')}`);

// 3. Turn times per model.
say('\n3. Turn times (completed)');
const models=[...new Set(turns.map(t=>t.model))];
for(const model of models){const v=turns.filter(t=>t.model===model&&t.status==='completed'&&t.finished).map(t=>(t.finished-t.created)/1000);if(v.length)say(`   ${model}: ${v.length} turns, median ${median(v).toFixed(0)} s, longest ${Math.max(...v).toFixed(0)} s`);}

// 4. Tool times in Tris Opus chats (tool_use to tool_result), and edits Tris refused.
say('\n4. Tools in Tris Opus chats');
const dir=path.join(os.homedir(),'.claude','projects','I--DEV'),times={};let refused=0;
for(const file of fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')):[]){
  const full=path.join(dir,file);if(fs.statSync(full).mtimeMs<from)continue;const uses=new Map();
  for(const line of fs.readFileSync(full,'utf8').split('\n')){
    let row;try{row=JSON.parse(line);}catch{continue;}const at=Date.parse(row.timestamp);if(!(at>=from&&at<to))continue;
    const content=row.message?.content;if(!Array.isArray(content))continue;
    for(const block of content){
      if(block.type==='tool_use')uses.set(block.id,{name:block.name,at});
      else if(block.type==='tool_result'&&uses.has(block.tool_use_id)){const use=uses.get(block.tool_use_id);(times[use.name]??=[]).push((at-use.at)/1000);if(JSON.stringify(block.content).includes('has not been read by this job'))refused++;}
    }
  }
}
for(const [name,v] of Object.entries(times).sort((a,b)=>b[1].length-a[1].length).slice(0,8))say(`   ${name}: ${v.length} calls, median ${median(v).toFixed(2)} s`);
say(`   ${refused} edits refused as "changed or not read".`);

// 5. Tris's own time per tool, once tool-timing.log exists (batch 2).
const timing=path.join(data,'tool-timing.log');
if(fs.existsSync(timing)){
  say('\n5. Tris time per tool (tool-timing.log)');
  const lines=fs.readFileSync(timing,'utf8').trim().split('\n').filter(l=>{const at=Date.parse(l.slice(0,24));return at>=from&&at<to;});
  const total=lines.map(l=>Number(/total=(\d+)/.exec(l)?.[1])).filter(Number.isFinite);
  say(`   ${lines.length} tools, median ${median(total)} ms of Tris's own time.`);
}
// 6. Tris's preparation before each message reaches its model, once prepare.log exists (TRIS-TODO 1.11).
const prepare=path.join(data,'prepare.log');
if(fs.existsSync(prepare)){
  say('\n6. Preparation before the model gets a message (prepare.log)');
  const lines=fs.readFileSync(prepare,'utf8').trim().split('\n').filter(l=>{const at=Date.parse(l.slice(0,24));return at>=from&&at<to;});
  const total=lines.map(l=>Number(/ total=(\d+)ms/.exec(l)?.[1])).filter(Number.isFinite);
  say(`   ${lines.length} messages, median ${median(total)} ms.`);
  for(const l of lines.filter(l=>/ stuck: /.test(l)))say(`   STUCK ${local(Date.parse(l.slice(0,24)))} ${/ stuck: (.*?) total=/.exec(l)[1]}`);
  // The slowest steps, by their longest single time.
  const worst=new Map();
  for(const l of lines)for(const part of (/ steps=(.*)$/.exec(l)?.[1]||'').split(', ')){const m=/^(.*) (\d+)ms$/.exec(part);if(m)worst.set(m[1],Math.max(worst.get(m[1])||0,Number(m[2])));}
  for(const [name,ms] of [...worst].sort((a,b)=>b[1]-a[1]).slice(0,5))say(`   slowest ${name}: ${ms} ms`);
}
console.log(out.join('\n'));
