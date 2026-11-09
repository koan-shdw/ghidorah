// What changed since the state a window holds (LAG 2026-11-09). Before, every push carried the whole snapshot: on
// Koan's data 2,500 turns and 6,618 tool previews, 22 MB, about 300 ms in the main process and 150 ms in the window,
// once per tool start and finish. The main window now gets the rows that changed, the tools of turns newly shown and
// the ids of rows and turns to drop; the rest of the snapshot (chats, projects, approvals, settings) is small and
// still comes whole. The window applies it with applyDelta; a revision it does not hold asks for a whole state again.
import type {Store} from './store';
import type {Snapshot,ToolCall,Turn} from './types';
import {stabilize} from './row-memo';

export interface TurnChanges {changed:Turn[];removed:string[]}
export interface ToolChanges {changed:ToolCall[];removed:string[];dropTurns:string[]}
/** What a window holds: the store revision of its state and the turns whose tools it has. */
export interface SentState {rev:number;turnIds:Set<string>}
export type StateDelta=Omit<Snapshot,'turns'|'tools'>&{delta:true;base:number;rev:number;turnChanges:TurnChanges;toolChanges:ToolChanges};
export interface Changes {turnChanges:TurnChanges;toolChanges:ToolChanges}

/** The rows changed since `sent`, for a window that is to hold the tools of `shownTurnIds`. Null: send everything. */
export function buildDelta(store:Store,sent:SentState,shownTurnIds:Set<string>):Changes|null {
  const changes=store.changesSince(sent.rev);if(!changes)return null;
  const turnChanges:TurnChanges={changed:[],removed:[]},toolChanges:ToolChanges={changed:[],removed:[],dropTurns:[]};
  for(const change of changes){
    if(change.kind==='turn'){const turn=change.removed?undefined:store.find<Turn>('turn',change.id);if(!turn||turn.contextSnapshot)turnChanges.removed.push(change.id);else turnChanges.changed.push(turn);}
    else if(change.kind==='tool'){const tool=change.removed?undefined:store.find<ToolCall>('tool',change.id);if(!tool)toolChanges.removed.push(change.id);else if(sent.turnIds.has(tool.turnId)&&shownTurnIds.has(tool.turnId))toolChanges.changed.push(tool);}
  }
  // Tools of turns newly shown come whole; turns no longer shown take theirs away.
  const added=[...shownTurnIds].filter(id=>!sent.turnIds.has(id));
  if(added.length)toolChanges.changed.push(...store.whereIn<ToolCall>('tool','turnId',added));
  for(const id of sent.turnIds)if(!shownTurnIds.has(id))toolChanges.dropTurns.push(id);
  return {turnChanges,toolChanges};
}
export const emptyChanges=({turnChanges,toolChanges}:Changes)=>!turnChanges.changed.length&&!turnChanges.removed.length&&!toolChanges.changed.length&&!toolChanges.removed.length&&!toolChanges.dropTurns.length;

// New rows go to the end in the order they were made (the store's order), not the order of their latest change.
const made=(row:any)=>row.created??row.started??0;
function mergeRows<T extends {id:string}>(previous:T[],changed:T[],removed:string[]):T[]{
  if(!changed.length&&!removed.length)return previous;
  const fresh=new Map(changed.map(row=>[row.id,row])),gone=new Set(removed),out:T[]=[];
  for(const row of previous){if(gone.has(row.id))continue;const next=fresh.get(row.id);if(next){out.push(next);fresh.delete(row.id);}else out.push(row);}
  out.push(...[...fresh.values()].filter(row=>!gone.has(row.id)).sort((a,b)=>made(a)-made(b)));
  return out;
}
/** The window's next state: rows that did not change keep their objects, so only rows whose records changed re-render. */
export function applyDelta(previous:Snapshot,delta:StateDelta):Snapshot{
  const {delta:_delta,base:_base,turnChanges,toolChanges,...rest}=delta;
  const turns=mergeRows(previous.turns,turnChanges.changed,turnChanges.removed);
  const drop=new Set(toolChanges.dropTurns),kept=drop.size?previous.tools.filter(tool=>!drop.has(tool.turnId)):previous.tools;
  const tools=mergeRows(kept,toolChanges.changed,toolChanges.removed);
  return stabilize(previous,{...rest,turns,tools} as Snapshot);
}
