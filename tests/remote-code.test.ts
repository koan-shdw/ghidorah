import test from 'node:test';
import assert from 'node:assert/strict';
import {hotp,base32,fromBase32,pair,pairingUri,checkCode as verifyCode,bindingDigest,LOOK_AHEAD,MAX_FAILURES,PAUSE_MS,CHALLENGE_MS,type Binding} from '../app/remote-code';

test('RFC 4226 appendix D test values',()=>{
 const secret=Buffer.from('12345678901234567890');
 assert.deepEqual([0,1,2,3,4,5,6,7,8,9].map(counter=>hotp(secret,counter)),['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489']);
});

test('base32 round trip and the RFC 4648 example',()=>{
 assert.equal(base32(Buffer.from('foobar')),'MZXW6YTBOI');assert.equal(fromBase32('mzxw6ytboi').toString(),'foobar');
 const state=pair(0);assert.equal(fromBase32(state.secret).length,20);assert.match(pairingUri(state),/^otpauth:\/\/hotp\/Ghidorah:Remote\?secret=[A-Z2-7]{32}&issuer=Ghidorah&algorithm=SHA1&digits=6&counter=0$/);
});

const binding:Binding={owner:'42',origin:'telegram',chatId:'chat-1',approvalId:'approval-1',action:'run: npm publish'};
const shown={digest:bindingDigest(binding),at:0,messageId:'123'};
const checkCode=(state:Parameters<typeof verifyCode>[0],reply:string,shown:Parameters<typeof verifyCode>[2],current:Binding,now:number)=>verifyCode(state,reply,shown,current,now,'123');
const code=(state:{secret:string},counter:number)=>hotp(fromBase32(state.secret),counter);
// The RFC secret keeps the codes fixed, so no random secret can make a wrong code right by chance.
const fixed=()=>({...pair(0),secret:base32(Buffer.from('12345678901234567890'))});

test('a code approves once; replay and every earlier code are refused; a code later in the window resyncs',()=>{
 let state=fixed();
 let result=checkCode(state,code(state,0),shown,binding,1);assert.equal(result.ok,true);state=result.state;assert.equal(state.counter,1);
 assert.equal(checkCode(state,code(state,0),shown,binding,2).ok,false,'replay');
 result=checkCode(state,code(state,3),shown,binding,3);assert.equal(result.ok,true,'skipped codes inside the window');state=result.state;assert.equal(state.counter,4);
 assert.equal(checkCode(state,code(state,2),shown,binding,4).ok,false,'an earlier unused code');
 assert.equal(checkCode(state,code(state,4+LOOK_AHEAD),shown,binding,5).ok,false,'beyond the window');
});

test('a changed action, chat, owner or origin refuses the code and spends nothing',()=>{
 const state=fixed();
 for(const changed of [{...binding,action:'run: rm -rf /'},{...binding,chatId:'chat-2'},{...binding,owner:'43'},{...binding,origin:'desktop'},{...binding,approvalId:'approval-2'}]){
  const result=checkCode(state,code(state,0),shown,changed,1);assert.equal(result.ok,false);assert.equal(result.ok===false&&result.reason,'changed');assert.equal(result.state.counter,0);
 }
 assert.equal(checkCode(state,'Deny',shown,binding,1).ok,false);
 const late=checkCode(state,code(state,0),shown,binding,CHALLENGE_MS+1);assert.equal(late.ok===false&&late.reason,'expired');assert.equal(late.state.counter,0);
});

test('wrong codes pause the Remote code, longer each time; the pause holds even for a right code',()=>{
 // Each try answers an approval shown just before it, so only the pause decides.
 let state=fixed();const wrong='000000',at=(now:number)=>({digest:shown.digest,at:now-1,messageId:'123'});
 for(let i=0;i<MAX_FAILURES;i++)state=checkCode(state,wrong,at(100),binding,100).state;
 assert.equal(state.pausedUntil,100+PAUSE_MS);
 const paused=checkCode(state,code(state,0),at(200),binding,200);assert.equal(paused.ok===false&&paused.reason,'paused');assert.equal(paused.state.counter,0);
 const second=state.pausedUntil+1;
 for(let i=0;i<MAX_FAILURES;i++)state=checkCode(state,wrong,at(second),binding,second).state;
 assert.equal(state.pauses,2);assert.equal(state.pausedUntil,second+2*PAUSE_MS,'the second pause is twice as long');
 assert.equal(checkCode(state,code(state,0),at(state.pausedUntil),binding,state.pausedUntil).ok,true);
});
