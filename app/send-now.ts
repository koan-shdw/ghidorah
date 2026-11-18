// Send now: push a message that waits behind a running reply. It is Stop under another name: the reply is stopped
// with the reason "superseded-by-message" (it keeps its text and reads "Stopped for your new message"), and the
// waiting messages go out by the rule Stop already has. Stop only frees a message the reply has not read, and it
// stops more than the reply (its agents and background commands, waiting permissions, the chat's goal), so the
// button shows only where this check says yes, and says why where it says no.
import type {Turn} from './types';

export type SendNow={ok:true}|{ok:false;why:string};
const no=(why:string):SendNow=>({ok:false,why});
const waits=(turn:Turn)=>!turn.automatic&&(turn.status==='queued'||turn.status==='needs-model'||turn.status==='running'&&turn.delivery==='sent');

/** A message of the owner's that waits behind a reply: held in the app, or passed to the engine and not read yet. */
export const waitsItsTurn=(turn:Turn)=>!turn.automatic&&!turn.parentTurnId&&(turn.status==='queued'||turn.status==='running'&&turn.delivery==='sent');
/** The chat's running reply as a window can tell it: the first turn at work that is not itself a waiting message. */
export function runningReply(chatTurns:Turn[]){return chatTurns.find(turn=>!turn.automatic&&!turn.parentTurnId&&['dispatching','running','waiting','stopping'].includes(turn.status)&&turn.delivery!=='sent'&&!turn.answeredIn)?.id||null;}
/** Whether a message typed while a reply runs stops it and goes at once. `on` is the chat's Send now switch;
 * `other` is Ctrl+Enter or the button beside the send arrow, which do the opposite of Enter. A "??" side question
 * and a "/" command never stop the reply: they keep their own paths. */
export function sendsNow(text:string,working:boolean,on:boolean,other:boolean){return working&&!/^\s*(\?\?|\/)/.test(text)&&on!==other;}

/** Whether `turn`, one of the chat's turns, can be pushed now. `replyId` is the chat's running reply, if any. */
export function sendNowCheck(turn:Turn,chatTurns:Turn[],replyId:string|null):SendNow{
 if(turn.automatic)return no('Only a message you sent can be pushed.');
 if(turn.id===replyId)return no('This message is being answered now.');
 if(turn.answeredIn)return no('The running reply has already read this message.');
 if(!waits(turn))return no('This message is not waiting.');
 if(turn.status==='needs-model')return no('Choose a model for this message first.');
 if(turn.paused)return no(turn.resume?'This message waits for the usage limit to reset.':'This message is paused. Send it with its own Send button.');
 if(turn.routePending)return no('Its model is still being chosen.');
 const reply=replyId?chatTurns.find(row=>row.id===replyId):undefined;
 if(!reply)return no('No reply is running, so this message goes out by itself.');
 if(reply.status==='stopping')return no('The reply is already stopping.');
 // Messages leave in the order they were sent: one that cannot leave holds every message behind it.
 const held=chatTurns.find(row=>row.id!==turn.id&&row.created<turn.created&&waits(row)&&!row.answeredIn&&(row.status==='needs-model'||row.paused));
 if(held)return no(held.status==='needs-model'?'An earlier message needs a model first.':'An earlier message is paused and goes first.');
 return {ok:true};
}
