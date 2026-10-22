// The Remote code (6d, A33, SPEC 5.22): counter-based one-time codes per RFC 4226 with Node's own crypto, no
// library (section 5, call 9). Pure logic, no Electron: main keeps the state in the store and saves each new
// counter before anything runs. A code approves only the approval shown when it was asked for.
import {createHmac,randomBytes,createHash} from 'node:crypto';

const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes:Buffer){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=ALPHABET[(value>>>(bits-5))&31];bits-=5;}}if(bits>0)out+=ALPHABET[(value<<(5-bits))&31];return out;}
export function fromBase32(text:string){const clean=text.toUpperCase().replace(/[\s=-]/g,'');let bits=0,value=0;const out:number[]=[];for(const char of clean){const index=ALPHABET.indexOf(char);if(index<0)throw Error('Not a base32 secret.');value=(value<<5)|index;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}

// RFC 4226 section 5.3: HMAC-SHA-1 over the 8-byte big-endian counter, dynamic truncation, six digits.
export function hotp(secret:Buffer,counter:number,digits=6){
 if(!Number.isSafeInteger(counter)||counter<0)throw Error('Invalid counter.');
 const message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(counter));
 const hash=createHmac('sha1',secret).update(message).digest(),offset=hash[hash.length-1]&15;
 const binary=((hash[offset]&127)<<24)|(hash[offset+1]<<16)|(hash[offset+2]<<8)|hash[offset+3];
 return String(binary%10**digits).padStart(digits,'0');
}

export const LOOK_AHEAD=10;          // codes generated on the phone but never sent
export const MAX_FAILURES=5;         // wrong codes before a pause
export const PAUSE_MS=15*60_000;     // the first pause; each further run of failures doubles it
export const CHALLENGE_MS=10*60_000; // how long an approval shown on Telegram takes a code (5.22: the app expires challenges)

export interface RemoteCodeState {secret:string;counter:number;failures:number;pausedUntil:number;pauses:number;pairedAt:number}
export function pair(now:number):RemoteCodeState{return {secret:base32(randomBytes(20)),counter:0,failures:0,pausedUntil:0,pauses:0,pairedAt:now};}
// The pairing address authenticator apps read from the QR code; the plain secret is shown beside it.
export function pairingUri(state:RemoteCodeState){return 'otpauth://hotp/Ghidorah:Remote?secret='+state.secret+'&issuer=Ghidorah&algorithm=SHA1&digits=6&counter='+state.counter;}

// What a code approves: owner, where the message came from, the chat and the exact action. The digest is
// taken when the approval is shown on Telegram and checked again when the code arrives.
export interface Binding {owner:string;origin:string;chatId:string;approvalId:string;action:string}
export function bindingDigest(binding:Binding){return createHash('sha256').update(JSON.stringify([binding.owner,binding.origin,binding.chatId,binding.approvalId,binding.action])).digest('hex');}

export type CodeResult={ok:true;state:RemoteCodeState}|{ok:false;state:RemoteCodeState;reason:'paused'|'wrong'|'changed'|'expired'|'not-a-code'|'reply-required'};
// Checks a reply against the approval shown. On success the counter moves past the code used, so that code and
// every earlier one are refused from then on; the caller saves the returned state before it runs anything.
export function checkCode(state:RemoteCodeState,reply:string,shown:{digest:string;at:number;messageId?:string},current:Binding,now:number,replyTo?:string):CodeResult{
 if(now<state.pausedUntil)return {ok:false,state,reason:'paused'};
 if(!/^\d{6}$/.test(reply.trim()))return {ok:false,state,reason:'not-a-code'};
 // HOTP authenticates the owner, not an action. Telegram's explicit reply must name the message
 // which displayed this exact approval; a code sent to a replaced or unconfirmed message grants nothing.
 if(!shown.messageId||replyTo!==shown.messageId)return {ok:false,state,reason:'reply-required'};
 if(bindingDigest(current)!==shown.digest)return {ok:false,state,reason:'changed'};
 if(now<shown.at||now-shown.at>CHALLENGE_MS)return {ok:false,state,reason:'expired'};
 const secret=fromBase32(state.secret);
 for(let step=0;step<LOOK_AHEAD;step++)if(hotp(secret,state.counter+step)===reply.trim())return {ok:true,state:{...state,counter:state.counter+step+1,failures:0}};
 const failures=state.failures+1;
 if(failures<MAX_FAILURES)return {ok:false,state:{...state,failures},reason:'wrong'};
 return {ok:false,state:{...state,failures:0,pauses:state.pauses+1,pausedUntil:now+PAUSE_MS*2**Math.min(state.pauses,6)},reason:'wrong'};
}
