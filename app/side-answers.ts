// Side answers (FEATURE-SPECS 2, Koan 2026-10-07 and 10-10): while a turn runs, a quick question about it is answered
// by a second model from the live state, without touching the running work. "??" always gets a side answer; any other
// message sent while a turn runs is sorted by the side model in the same call (it replies MAIN for the main model).
import type {Turn,ToolCall} from './types';

const FORCE=/^\s*\?\?/;
export const sideQuestion=(text:string)=>text.replace(FORCE,'').trim();

// 'side' (forced by ??), 'sort' (the side model decides) or 'main' (exactly as before side answers).
export function sideRoute(text:string,{running,attachments}:{running:boolean;attachments:boolean}):'side'|'sort'|'main'{
 if(FORCE.test(text))return sideQuestion(text)?'side':'main';
 if(!running||attachments||text.trimStart().startsWith('/'))return 'main';
 return 'sort';
}
// The sorter hands a message to the main model with MAIN alone; an empty reply is unsure, so it goes there too.
export const saysMain=(answer:string)=>!answer.trim()||/^\W*main\W*$/i.test(answer.trim());

// Default: the newest fast model he has connected (Haiku when Claude is connected, else DeepSeek Flash).
export const preferredSideModel=(ready:string[])=>[...ready.filter(id=>/^claude-code:.*haiku/i.test(id)),'deepseek-flash',...ready.filter(id=>/flash|haiku/i.test(id))].find(id=>ready.includes(id))||ready[0]||null;

export const sideSystem=(forced:boolean)=>forced
 ?'The user asked a quick question about the work a main model is doing. Answer from the live state in the prompt, in two or three short plain sentences. If the live state does not show the answer, say so plainly. You cannot change the work, run anything or talk to the main model.'
 :'The user sent this message while a main model is working. If it is a question about the work underway (how it is going, what it is doing, which approach, which files, how long, whether it is done) and the live state in the prompt answers it, answer in two or three short plain sentences. If it asks for any change, gives an instruction or new information, answers a question from the model, or you are unsure, reply with exactly MAIN and nothing else.';

const cut=(value:unknown,size:number)=>{const text=typeof value==='string'?value:JSON.stringify(value)??'';return text.length>size?text.slice(0,size)+'…':text;};
const tail=(text:string,size:number)=>text.length>size?'…'+text.slice(-size):text;
const pathsOf=(tool:ToolCall)=>[tool.args?.path,tool.args?.file_path,tool.args?.filePath,tool.args?.notebook_path].filter((value):value is string=>typeof value==='string'&&!!value);

// What the side model may see, read only: status, plan, the last 30 actions, files touched, text so far, time running,
// waiting messages and the chat's last few messages. Parallel jobs come along with their parent turn.
export function sideState({turn,jobs,tools,queued,recent,now}:{turn:Turn;jobs:Turn[];tools:ToolCall[];queued:Turn[];recent:Turn[];now:number}){
 const owned=new Set([turn.id,...jobs.map(job=>job.id)]),actions=tools.filter(tool=>owned.has(tool.turnId));
 const plan=[...actions].reverse().find(tool=>/todo|plan/i.test(tool.name));
 const status=(row:Turn)=>[row.status,row.preparation&&row.status==='dispatching'?row.preparation:row.activity].filter(Boolean).join(' · ');
 return {
  status:status(turn),model:turn.model,minutesRunning:Math.round((now-turn.created)/6000)/10,
  plan:plan?cut(plan.args,1500):null,
  actions:actions.slice(-30).map(tool=>({name:tool.name,status:tool.status,input:cut(tool.args,200),result:cut(tool.result,200)})),
  filesTouched:[...new Set(actions.flatMap(pathsOf))].slice(-30),
  textSoFar:tail([turn.interimText,turn.text].filter(Boolean).join('\n'),3000),
  jobs:jobs.map(job=>({model:job.model,status:status(job),textSoFar:tail(job.text||'',1000)})),
  waitingMessages:queued.map(row=>cut(row.prompt,300)),
  lastMessages:recent.map(row=>({you:cut(row.prompt,500),model:tail(row.text||'',1000)})),
 };
}
