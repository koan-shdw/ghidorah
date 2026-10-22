import {randomUUID} from 'node:crypto';

export interface VoiceDraft {readonly id:string;readonly version:number;readonly text:string;readonly chatId:string;}
export type DraftIdentity=Pick<VoiceDraft,'id'|'version'|'chatId'>;
export function reading(utterance:string):'yes'|'no'|'unclear'{
 const text=utterance.trim().replace(/\s+/g,' ');
 if(/^(?:yes|yeah|yep|send it|go ahead|confirm|okay)(?:[,.! ]+(?:please|send it|go ahead|thanks|thank you))*[.!]?$/i.test(text))return 'yes';
 return /^(?:no|nope|not yet|wait|stop|cancel|don't|do not|hold on)\b/i.test(text)?'no':'unclear';
}

// Main owns this gate. Model output may propose text; only the audio controller can
// finish playback or supply the final transcript of a microphone capture it started.
export class VoiceGate {
 #draft:VoiceDraft|null=null;#version=0;#playback:string|null=null;#reading:DraftIdentity|null=null;
 #readyUntil=0;#capture:{id:string;draft:VoiceDraft;until:number}|null=null;
 constructor(private now=()=>performance.now()){}
 get draft(){return this.#draft;}
 #same(identity:DraftIdentity){const d=this.#draft;return !!d&&d.id===identity.id&&d.version===identity.version&&d.chatId===identity.chatId;}
 #invalidate(){this.#reading=null;this.#readyUntil=0;this.#capture=null;}
 propose(text:string,chatId:string):VoiceDraft{
  if(typeof text!=='string'||!text.trim()||text.length>64000||typeof chatId!=='string'||!chatId.trim()||chatId.length>128)throw Error('A voice draft needs text and a destination chat.');
  this.#invalidate();this.#draft=Object.freeze({id:randomUUID(),version:++this.#version,text:text.trim(),chatId});return this.#draft;
 }
 edit(identity:DraftIdentity,text:string,chatId=identity.chatId):VoiceDraft{
  if(!this.#same(identity))throw Error('The voice draft changed.');
  const id=this.#draft!.id,next=this.propose(text,chatId);this.#draft=Object.freeze({...next,id});return this.#draft;
 }
 clear(){this.#invalidate();this.#draft=null;}
 // Every app playback invalidates pending microphone input, including an AI reply.
 beginPlayback(identity?:DraftIdentity):string{
  if(identity&&!this.#same(identity))throw Error('The voice draft changed.');
  this.#invalidate();this.#playback=randomUUID();this.#reading=identity?Object.freeze({...identity}):null;return this.#playback;
 }
 finishPlayback(ticket:string,completed:boolean){
  if(ticket!==this.#playback)return false;
  this.#playback=null;
  if(completed&&this.#reading&&this.#same(this.#reading))this.#readyUntil=this.now()+120000;
  this.#reading=null;return true;
 }
 beginCapture(identity:DraftIdentity):string{
  if(!this.#same(identity))throw Error('The voice draft changed.');
  if(this.#playback||this.#readyUntil<=this.now())throw Error('Read back this draft before confirming it.');
  const id=randomUUID();this.#capture={id,draft:this.#draft!,until:Math.min(this.#readyUntil,this.now()+60000)};return id;
 }
 cancelCapture(){this.#capture=null;}
 // The caller has already decoded a complete captured utterance. Partial live
 // transcript events, helper text and caller-supplied source labels never enter here.
 confirm(ticket:string,utterance:string):{ok:true;draft:VoiceDraft}|{ok:false;reason:'stale'|'no'|'ambiguous'}{
  const capture=this.#capture;
  if(!capture||capture.id!==ticket)return {ok:false,reason:'stale'};
  this.#capture=null;
  if(this.#playback||capture.until<=this.now()||!this.#same(capture.draft))return {ok:false,reason:'stale'};
  const said=reading(utterance);if(said!=='yes')return {ok:false,reason:said==='no'?'no':'ambiguous'};
  const draft=capture.draft;this.clear();return {ok:true,draft};
 }
}
