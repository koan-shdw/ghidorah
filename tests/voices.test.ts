import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spokenPieces,spokenText} from '../app/spoken-text';
import {render} from '../app/voice-effects';
import {VoiceWorker,type SpokenEvent} from '../app/voice-worker';
import {EFFECTS,VOICE_IDS,chatVoices,checkVoice,newVoice,readVoices,speakRequest,starterVoices,voiceForChat,voiceSummary} from '../app/voices';

// Koan 2026-11-15: Kokoro's 28 English voices, and the eight effects of the samples page as voices to start from.
test('a new copy starts with Heart and the eight effect voices, every one of them valid',()=>{
 const starters=starterVoices();
 assert.deepEqual(starters.map(voice=>voice.name),['Heart','Flat robot, low','Flat robot, high','Ring machine','Metal pipe','Old computer','Intercom','Whisper','Flat robot, old computer']);
 for(const voice of starters)assert.deepEqual(checkVoice(voice),voice);
 assert.equal(VOICE_IDS.length,28);assert.ok(VOICE_IDS.every(id=>/^[ab][fm]_[a-z]+$/.test(id)));
 const read=readVoices(null);
 assert.equal(read.list.length,9);assert.equal(read.defaultId,'heart');assert.equal(read.speakReplies,false);
});

test('saved voices are read as they stand; a voice that breaks the rules is left out and the default always exists',()=>{
 const mine={...newVoice('mine','Mine'),a:'am_onyx',b:'bf_emma',balance:37,speed:1.3};
 const read=readVoices({id:'voices',voices:[mine,{id:'bad',name:'Bad',a:'zf_xiaobei'},mine],defaultId:'gone',speakReplies:true});
 assert.deepEqual(read.list,[mine],'the unknown voice and the repeat are dropped');
 assert.equal(read.defaultId,'mine');assert.equal(read.speakReplies,true);
 assert.equal(readVoices({id:'voices',voices:[mine],defaultId:'mine'}).defaultId,'mine');
});

test('a voice is checked before it is saved or spoken',()=>{
 const voice=newVoice('v1','  My   voice ');
 assert.equal(checkVoice(voice).name,'My voice');
 assert.equal(checkVoice({...voice,b:voice.a}).b,'','a voice is not blended with itself');
 assert.equal(checkVoice({...voice,speed:1.25}).speed,1.25);
 for(const broken of [{...voice,name:' '},{...voice,name:'x'.repeat(41)},{...voice,a:'zf_xiaobei'},{...voice,b:'nobody'},{...voice,balance:101},{...voice,speed:2},{...voice,speed:0.5},{...voice,id:'../x'},{...voice,fx:{...voice.fx,robot:{amount:120,value:110}}},{...voice,fx:{...voice.fx,pipe:{amount:50,value:20}}},{...voice,fx:{}},null])assert.throws(()=>checkVoice(broken));
 assert.deepEqual(speakRequest(['Hello.'],{...voice,a:'am_onyx',b:'bf_emma',balance:37,speed:1.3}),{pieces:['Hello.'],a:'am_onyx',b:'bf_emma',balance:37,speed:1.3});
 assert.deepEqual(speakRequest(['Hello.'],{...voice,b:'bf_emma',balance:0}),{pieces:['Hello.'],a:'af_heart',b:'',balance:0,speed:1},'a second voice at nothing is one voice');
 for(const pieces of [[],[''],['x'.repeat(2001)],Array(401).fill('a'),'Hello.',[1]])assert.throws(()=>speakRequest(pieces,voice));
});

test('a voice is described in one line, and a chat speaks in its app\'s voice',()=>{
 const starters=starterVoices(),voice={...starters[1],b:'bf_emma',balance:30,speed:1.2,fx:{...starters[1].fx,crush:{amount:40,value:60}}};
 assert.equal(voiceSummary(starters[0]),'Heart');
 assert.equal(voiceSummary(voice),'Onyx + Emma · Flat robot · Old computer 40% · 1.20×');
 assert.equal(voiceSummary({...voice,balance:100}),'Emma · Flat robot · Old computer 40% · 1.20×');
 const byChat=chatVoices(starters,[{chatIds:['a','b'],voice:'ring'},{chatIds:['b','c'],voice:'pipe'},{chatIds:['d'],voice:'deleted'},{chatIds:['e']}]);
 assert.deepEqual(byChat,{a:'ring',b:'ring',c:'pipe'},'the first app with a voice wins; a deleted voice counts for nothing');
 const view={list:starters,defaultId:'heart',byChat};
 assert.equal(voiceForChat(view,{id:'c'}).id,'pipe');
 assert.equal(voiceForChat(view,{id:'side',parentChatId:'a'}).id,'ring','a side chat speaks as its parent');
 assert.equal(voiceForChat(view,{id:'e'}).id,'heart');assert.equal(voiceForChat(view).id,'heart');
 assert.equal(EFFECTS.length,6);
});

test('a reply is read without its markup: no code blocks, links by their text, tables by their cells',()=>{
 const text=spokenText('## Done\n\nThe **update** is out, see [the notes](https://example.com/a/b?c=d) or https://www.shdw.work/dl/x.\n\n```ts\nconst secret=1;\n```\n\n- first `item`\n- [x] second item!\n\n| App | State |\n|---|---|\n| Ghidorah | shipped |\n\n---\n> _Two_ things are still open');
 assert.equal(text,'Done.\nThe update is out, see the notes or shdw.work.\nfirst item.\nsecond item!\nApp, State.\nGhidorah, shipped.\nTwo things are still open.');
 assert.equal(spokenText('```\nonly code\n```'),'');
 assert.equal(spokenText('before\n```js\nnever closed'),'before.');
 assert.equal(spokenText('***\n\n…'),'');
 const long=spokenText('word '.repeat(3000));
 assert.ok(long.length<=6000&&long.endsWith('The rest is in the chat.'));
});

test('the first sentence is spoken alone so sound starts quickly; the rest goes in pieces of a few sentences',()=>{
 assert.deepEqual(spokenPieces('Done. The update is out, and all four checks passed. Two things are still open.'),['Done.','The update is out, and all four checks passed. Two things are still open.']);
 const pieces=spokenPieces(Array.from({length:30},(_,index)=>'This is sentence number '+index+' of the reply.').join(' '));
 assert.equal(pieces[0],'This is sentence number 0 of the reply.');
 assert.ok(pieces.length>3&&pieces.every(piece=>piece.length<=220));
 assert.equal(pieces.join(' ').split('. ').length,30,'nothing is lost or said twice');
 const endless=spokenPieces('and then '.repeat(200));
 assert.ok(endless.length>1&&endless.every(piece=>piece.length<=401));
 assert.deepEqual(spokenPieces('```\ncode\n```'),[]);
});

// The sums are the ones of the voice menu page, which were checked there against scipy. These numbers come from this
// file's own run on a made signal, after that check, so a later change to the sums shows here.
test('the effects keep their sound: the same signal gives the same numbers',()=>{
 const made=new Float32Array(6000);let seed=3;
 const random=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
 for(let n=0;n<made.length;n++)made[n]=0.5*Math.sin(2*Math.PI*180*n/24000)*Math.sin(Math.PI*n/made.length)+0.1*(random()-0.5);
 const sum=(x:Float32Array)=>{let s=0;for(const v of x)s+=Math.abs(v);return Number(s.toFixed(3));};
 const golden:[any,number,number,number][]=[
  [{},1995.352,0.46572,0.35169],
  [{robot:{amount:100,value:90}},2003.73,-0.07837,-0.60948],
  [{robot:{amount:100,value:160}},1961.958,0.04447,0.15928],
  [{whisper:{amount:100,value:2}},1029.587,-0.09881,-0.23856],
  [{ring:{amount:100,value:50}},1310.72,-0.20671,0.00475],
  [{pipe:{amount:100,value:180}},2094.067,0.33054,0.3637],
  [{crush:{amount:100,value:60}},2111.476,0.49444,0.39556],
  [{intercom:{amount:100,value:6}},1249.272,-0.06172,0.2039],
  [{robot:{amount:100,value:110},crush:{amount:100,value:40}},1654.239,0.27087,0.30957],
  [{robot:{amount:35,value:75},pipe:{amount:60,value:330},intercom:{amount:80,value:3.5}},1159.511,0.17448,0.19914],
 ];
 for(const [stack,total,early,late] of golden){
  const out=render(made,stack);
  assert.equal(out.length,made.length);
  assert.deepEqual([sum(out),Number(out[1234].toFixed(5)),Number(out[4321].toFixed(5))],[total,early,late],JSON.stringify(stack));
  let peak=0;for(const v of out)peak=Math.max(peak,Math.abs(v));assert.ok(Math.abs(peak-0.89)<1e-6,'set just under full level');
 }
 assert.deepEqual([...render(made,{robot:{amount:0,value:90}})],[...render(made,{})],'an effect at nothing changes nothing');
});

class FakeChild extends EventEmitter {
 stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();killed=false;lines:any[]=[];
 constructor(){super();let held='';this.stdin.on('data',chunk=>{held+=chunk;for(;;){const at=held.indexOf('\n');if(at<0)break;this.lines.push(JSON.parse(held.slice(0,at)));held=held.slice(at+1);}});}
 say(event:object){this.stdout.write(JSON.stringify(event)+'\n');}
 kill(){this.killed=true;this.emit('exit',0);return true;}
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
const request={pieces:['Hello.'],a:'af_heart',b:'',balance:0,speed:1};

test('the voice worker loads once, speaks to the window that asked, and one window speaks one thing at a time',async()=>{
 const children:FakeChild[]=[],heard:[number,SpokenEvent][]=[];
 const worker=new VoiceWorker(()=>{const child=new FakeChild();children.push(child);return child as any;},(owner,event)=>heard.push([owner,event]));
 const first=worker.speak('k1','a',1,request);await settle();
 assert.equal(children.length,1);assert.deepEqual(children[0].lines,[],'nothing is asked before the model is ready');
 children[0].say({type:'ready',voices:[]});await first;await settle();
 assert.deepEqual(children[0].lines,[{op:'speak',id:'a',...request}]);assert.ok(worker.loaded);
 children[0].say({id:'a',type:'audio',index:0,rate:24000,pcm:'AAAA'});children[0].say({id:'stranger',type:'audio',index:0,rate:24000,pcm:'AAAA'});await settle();
 assert.deepEqual(heard,[[1,{id:'a',type:'audio',index:0,rate:24000,pcm:'AAAA'}]],'only the asking window hears it');
 await worker.speak('k1','b',1,request);await worker.speak('k1','c',2,request);await settle();
 assert.equal(children.length,1,'the model stays loaded');
 assert.deepEqual(children[0].lines.slice(1),[{op:'cancel',id:'a'},{op:'speak',id:'b',...request},{op:'speak',id:'c',...request}],'the window\'s earlier speech stops; another window\'s goes on');
 children[0].say({id:'a',type:'audio',index:1,rate:24000,pcm:'AAAA'});children[0].say({id:'b',type:'end'});children[0].say({id:'b',type:'audio',index:9,rate:24000,pcm:'AAAA'});await settle();
 assert.deepEqual(heard.slice(1),[[1,{id:'b',type:'end',text:''}]],'nothing after a stop or an end');
 worker.release(2);await settle();assert.deepEqual(children[0].lines.at(-1),{op:'cancel',id:'c'},'a closed window takes its speech with it');
 worker.cancel('nobody',1);worker.stop();assert.ok(children[0].killed);
});

test('a new runtime starts a fresh worker, and a worker that dies tells its windows',async()=>{
 const children:FakeChild[]=[],heard:[number,SpokenEvent][]=[];
 const worker=new VoiceWorker(()=>{const child=new FakeChild();children.push(child);return child as any;},(owner,event)=>heard.push([owner,event]));
 const first=worker.speak('k1','a',1,request);children[0].say({type:'ready'});await first;
 const second=worker.speak('k2','b',1,request);await settle();
 assert.equal(children.length,2);assert.ok(children[0].killed);
 children[1].say({type:'ready'});await second;await settle();
 assert.deepEqual(children[1].lines,[{op:'speak',id:'b',...request}]);
 heard.length=0;children[1].stderr.write('Traceback\nValueError: The voice model is missing or changed. Install it again in Voices.\n');await settle();children[1].emit('exit',1);await settle();
 assert.deepEqual(heard,[[1,{id:'b',type:'error',text:'ValueError: The voice model is missing or changed. Install it again in Voices.'}]]);
 assert.equal(worker.loaded,false);
 const third=worker.speak('k2','c',1,request);await settle();children[2].emit('exit',1);
 await assert.rejects(third,/did not start/);
});
