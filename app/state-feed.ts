// The one state a window holds (LAG 2026-11-09). The main process pushes the main window the changes since the state
// it holds (a StateDelta, app/state-delta.ts) and other windows whole states. Every part of a window that follows the
// state (the app, a split or embedded chat, an agent pane) used to listen to the push channel itself; a change message
// means nothing to a listener holding no state, so this feed holds the window's state, merges each push or 'state'
// answer into it and hands every listener the whole state, as before.
import {applyDelta,type StateDelta} from './state-delta';
import {stabilize} from './row-memo';
import {applyTurnStream,type TurnStream} from './turn-stream';
import type {Snapshot} from './types';

export type StateMessage=Snapshot|StateDelta;
type Listener=(state:Snapshot)=>void;
type StreamListener=(updates:TurnStream[])=>void;
const listeners=new Set<Listener>(),streamListeners=new Set<StreamListener>();
let latest:Snapshot|null=null,refreshing=false,connected=false;
const desktop=()=>(window as any).desktop as {invoke(method:string,args?:any):Promise<any>;subscribe(handler:(message:any)=>void,stream?:StreamListener):()=>void};
function connect(){
  if(connected)return;connected=true;
  desktop().subscribe(message=>takeState(message),updates=>{if(latest)latest=applyTurnStream(latest,updates);for(const listener of streamListeners)listener(updates);});
}
/** The store revision of the state this window holds; a 'state' request names it to get only the changes since. */
export function heldRevision():number|undefined{return latest?.rev;}
/** The state this window holds, once one has arrived. */
export function heldState():Snapshot|null{return latest;}
/** A pushed state or a 'state' answer: merged into the state this window holds, then every listener gets the whole state. */
export function takeState(message:StateMessage){
  if('delta' in message){
    if(!latest||latest.rev!==message.base){refresh(message.rev);return;}
    latest=applyDelta(latest,message);
  }else latest=latest?stabilize(latest,message):message;
  for(const listener of listeners)listener(latest);
}
// A change against a revision this window does not hold: when it is newer than the held one, ask for the whole state,
// once at a time. An older one is stale and needs nothing.
function refresh(rev:number){
  if(refreshing||latest?.rev!==undefined&&rev<=latest.rev)return;
  refreshing=true;
  desktop().invoke('state',{window:true}).then(takeState).catch(()=>{}).finally(()=>{refreshing=false;});
}
/** Follow the window's state: the listener gets the state held now, if any, then every change; `stream` the streamed text of running replies. */
export function subscribeState(listener:Listener,stream?:StreamListener){
  connect();listeners.add(listener);if(stream)streamListeners.add(stream);
  if(latest)listener(latest);
  return ()=>{listeners.delete(listener);if(stream)streamListeners.delete(stream);};
}
