import type {Snapshot,Turn} from './types';

export type TurnStream=Pick<Turn,'id'|'text'|'reasoning'|'activity'|'stageSince'|'lastActivity'>;
export function applyTurnStream(state:Snapshot,updates:TurnStream[]):Snapshot{
 const byId=new Map(updates.map(row=>[row.id,row]));
 return {...state,turns:state.turns.map(turn=>{
  const update=byId.get(turn.id);
  // A delayed display update must never overwrite a terminal result.
  return update&&['running','waiting','stopping'].includes(turn.status)?{...turn,...update}:turn;
 })};
}
