// Handover mode (notes/HANDOVER-MODE-PLAN.md): the old chat writes a handover, a fresh chat in the same series starts
// from it with every setting the same, and his push buttons carry what is new between the two until he closes it.
// No Node imports: the window reads unpushed() too. The handover check runs in app/main/handlers/handover.ts.
import type {Store} from './store';
import type {Chat,Mode,ToolCall,Turn} from './types';

/** On the old chat while handover mode runs. Each marker is the last turn already pushed in that direction. */
export interface Handover {stage:'writing'|'live';newChatId?:string;mode?:Mode;pushedToOld?:string|null;pushedToNew?:string|null}

export const handoffCommand=/^\/handoff(?:\s|$)/i;

/** Part 1: what Ghidorah sends the old chat at Hand off. A note he types after /handoff rides along. */
export function handoverRequest(note=''){return `Write a handover so a fresh chat can carry on this work. The new chat will not see this chat; the handover is its only context. Write the current state, not a diary.

**Keep**
- What the work is for: everything the user wants, in their words where you can.
- The user's rulings, quoted, with the date if known.
- Decisions in place. Give a reason only where the next chat would otherwise undo the decision.
- How it works: files by path from the working folder, functions, settings and commands by exact name.
- Where things stand: done, in progress, the next step.
- Questions waiting on the user.

**Remove (depoison)**
- Failed attempts and dead ends. If something must not be tried again, one line: "Don't do X: it breaks Y."
- Anything decided against.
- Rules you gave yourself. Only the user's rulings stay.
- The story of this chat: who said what, apologies, detours.

**Rules**
- Mark every claim about code or state PROVEN (checked, with where) or OPEN. A guess is OPEN.
- Ghidorah checks that every file and name you mention exists, so spell them exactly and put them in backticks.
- Never tell the new chat to read this chat. It can't.
- Sections: Goal, User's rulings, Decisions, How it works, Where things stand, Next step, Open questions.

Reply with the handover only. The user may ask for changes; each new version replaces the last.${note.trim()?'\n\nFrom the user: '+note.trim():''}`;}

/** Part 2: the new chat's first and only message. */
export function handoverStart(title:string,handover:string){return `This chat continues "${title}" from the handover below. It is your only context; you can't read the earlier chat. The old chat is open beside you, and the user may send you its comments, marked as from the old chat.

First reply: restate the goal, the user's rulings and the next step in your own words, list anything unclear, then wait. Don't change anything yet.

${handover.trim()}`;}

/** "Ghidorah updates" becomes "Ghidorah updates 1" with "… 2" next; "Ghidorah updates 3" is followed by "… 4". */
export function seriesTitles(title:string){const t=title.trim(),m=/^(.*\S)\s+(\d+)$/.exec(t);return m?{old:t,next:m[1]+' '+(Number(m[2])+1)}:{old:t+' 1',next:t+' 2'};}

/** Earlier chats in this chat's series, followed back through handoverFrom (decision 9: never read). */
export function seriesBefore(store:Store,chatId:string){
 const seen=new Set<string>();let id=store.all<Chat>('chat').find(c=>c.id===chatId)?.handoverFrom;
 while(id&&!seen.has(id)){seen.add(id);id=store.all<Chat>('chat').find(c=>c.id===id)?.handoverFrom;}
 return seen;
}

const finished=(t:Turn)=>!['queued','dispatching','running','waiting','stopping','needs-model'].includes(t.status);
/** The finished turns of a chat after the marker, through `through` when given: what a push carries. */
export function unpushed(all:Turn[],chatId:string,marker:string|null|undefined,through?:string){
 const turns=all.filter(t=>t.chatId===chatId&&!t.parentTurnId&&!t.contextSnapshot);
 let rows=turns.slice(marker?turns.findIndex(t=>t.id===marker)+1:0);
 if(through){const end=rows.findIndex(t=>t.id===through);rows=end<0?[]:rows.slice(0,end+1);}
 const stop=rows.findIndex(t=>!finished(t));return stop<0?rows:rows.slice(0,stop);
}

const target=(args:any)=>String(args?.path??args?.file_path??args?.command??args?.pattern??args?.url??args?.query??'').replace(/\s+/g,' ').slice(0,120);
/** A push: his messages, the replies and a short list of actions. Pushed messages that came from the other chat
 * are left out; the reply to them stays. */
export function pushText(store:Store,turns:Turn[],title:string,toOld:boolean){
 const tools=store.all<ToolCall>('tool'),parts=turns.map(t=>{
  const actions=tools.filter(tool=>tool.turnId===t.id).map(tool=>'- '+tool.name+(target(tool.args)?' '+target(tool.args):''));
  return [!t.handoff?.push&&!t.automatic&&!t.goal?.automatic&&t.prompt.trim()?'**User:** '+t.prompt.trim():'',actions.length?'**Actions:**\n'+actions.join('\n'):'',t.text.trim()?'**Reply:** '+t.text.trim():t.error?'**Error:** '+t.error:''].filter(Boolean).join('\n\n');
 }).filter(Boolean);
 const head=toOld?`Update from the new chat "${title}", which started from your handover. Check whether it has understood the work: say briefly what is right, what is wrong or missing, and what it should do next.`:`Comments from the old chat "${title}", which wrote your handover. Weigh them against the handover and the user's rulings; the user's word wins.`;
 return head+'\n\n'+parts.join('\n\n---\n\n');
}
