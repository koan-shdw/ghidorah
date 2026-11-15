import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spliceDictation,toPcm16,dictationLanguage,micProblem,pcmChunks,finishWait,TAIL_MS} from '../app/dictation';
import {SpeechWorker,dictationHints,type SpeechEvent} from '../app/speech-worker';

test('dictated words go where the cursor was, spaced like Claude spaces them',()=>{
 assert.deepEqual(spliceDictation('Hello','',' world '),{value:'Hello world',caret:11});
 assert.deepEqual(spliceDictation('Send it ','now.','to Sam'),{value:'Send it to Sam now.',caret:14});
 assert.equal(spliceDictation('Done','',', thanks').value,'Done, thanks','no space before punctuation');
 assert.equal(spliceDictation('','',' first words').value,'first words');
 assert.equal(spliceDictation('a ','b','').value,'a b','no words: the box is as it was');
 assert.equal(spliceDictation('日本','','語です').value,'日本語です','no spaces between CJK characters');
});

test('microphone samples become 16 kHz 16-bit PCM',()=>{
 const pcm=toPcm16(new Float32Array(4800).fill(0.5),48000);
 assert.equal(pcm.length,1600);assert.equal(pcm[0],Math.round(0.5*32767));
 assert.equal(toPcm16(new Float32Array([2,-2,0]),16000).join(','),'32767,-32768,0','clipped, never wrapped');
});

// Koan 2026-11-14: the first words were lost while the session opened, and Done gave up on a long recording.
test('audio held while the session opens goes whole, a second at a time; Done waits longer for a longer recording',()=>{
 const held=pcmChunks([new Int16Array(9000).fill(1),new Int16Array(9000).fill(2),new Int16Array(500).fill(3)]);
 assert.deepEqual(held.map(chunk=>chunk.length),[16000,2500],'no piece over the worker\'s 64 KB message');
 assert.equal(held[0][8999],1);assert.equal(held[0][9000],2);assert.equal(held[1][1999],2);assert.equal(held[1][2000],3,'in the order it was said');
 assert.deepEqual(pcmChunks([]),[]);
 assert.equal(finishWait(0),30000);assert.equal(finishWait(60000),48000);assert.equal(finishWait(10*60*1000),210000);assert.equal(finishWait(60*60*1000),240000,'never more than four minutes');
 assert.ok(TAIL_MS>=250&&TAIL_MS<=600,'the microphone stays open a moment after the press, not long enough to feel stuck');
});

test('dictation hints are the owner\'s names, each once, the likeliest first',()=>{
 assert.deepEqual(dictationHints(['Ghidorah','Video  Dancer','ghidorah',null,'','KOAN.live',undefined,'Fable 5.2']),['Ghidorah','Video Dancer','KOAN.live','Fable 5.2']);
 assert.equal(dictationHints(Array.from({length:80},(_,index)=>'App '+index)).length,40);
 assert.equal(dictationHints(['x'.repeat(200)])[0].length,60);
});

test('Auto follows the app language, else English; microphone errors read like Claude\'s',()=>{
 assert.equal(dictationLanguage('','ja-JP'),'ja');assert.equal(dictationLanguage('','xx-YY'),'en');assert.equal(dictationLanguage('fr','ja-JP'),'fr');
 assert.equal(micProblem({name:'NotAllowedError'}).title,'Microphone access is blocked');
 assert.equal(micProblem({name:'NotFoundError'}).title,'No microphone found');
 assert.equal(micProblem({name:'NotReadableError'}).title,'Your microphone isn\'t available');
 assert.equal(micProblem(Error("Error invoking remote method 'app': Error: Install speech on the Voice page first.")).detail,'Install speech on the Voice page first.');
});

class FakeChild extends EventEmitter{stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();written:any[]=[];
 constructor(){super();this.stdin.on('data',chunk=>{for(const line of String(chunk).split('\n').filter(Boolean))this.written.push(JSON.parse(line));});}
 say(event:object){this.stdout.write(JSON.stringify(event)+'\n');}kill(){this.emit('exit',1);}}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));

test('the speech worker loads once, streams each window\'s audio, and answers only that window',async()=>{
 const children:FakeChild[]=[],events:[number,SpeechEvent][]=[];
 const worker=new SpeechWorker(()=>{const child=new FakeChild();children.push(child);return child as any;},(owner,event)=>events.push([owner,event]));
 const ready=worker.start('k1');assert.throws(()=>worker.open('a',1,'c1','en'),/still starting/);
 children[0].say({type:'ready',device:'cuda',cards:1,problem:''});await ready;assert.equal(worker.device,'cuda');
 await worker.start('k1');assert.equal(children.length,1,'kept loaded: a second press does not start another');
 worker.open('a',1,'c1','en');worker.audio('a',1,new Uint8Array([1,0,2,0]));
 assert.throws(()=>worker.audio('a',1,new Uint8Array([1])),/Invalid/);
 worker.audio('a',2,new Uint8Array([9,9]));worker.finish('a',2);worker.cancel('a',2);
 await tick();assert.deepEqual(children[0].written.map(row=>row.op),['start','audio'],'another window cannot feed, finish or cancel it');
 assert.equal(children[0].written[1].pcm,Buffer.from([1,0,2,0]).toString('base64'));
 children[0].say({id:'a',type:'partial',text:'hello'});children[0].say({id:'zzz',type:'partial',text:'not ours'});worker.finish('a',1);children[0].say({id:'a',type:'final',text:'hello there'});await tick();
 assert.deepEqual(events,[[1,{id:'a',type:'partial',text:'hello'}],[1,{id:'a',type:'final',text:'hello there'}]]);
 worker.open('b',1,'c1','');worker.open('c',1,'c2','',['Ghidorah','KOAN.live']);await tick();
 assert.deepEqual(children[0].written.slice(-3).map(row=>row.op+':'+row.id),['start:b','cancel:b','start:c'],'one dictation per window');
 assert.equal('hints' in children[0].written.at(-3),false);assert.deepEqual(children[0].written.at(-1).hints,['Ghidorah','KOAN.live'],'the owner\'s names go with the session');
 worker.release(1);await tick();assert.equal(children[0].written.at(-1).op,'cancel');
 worker.open('d',3,'c3','');children[0].kill();await tick();
 assert.deepEqual(events.at(-1),[3,{id:'d',type:'error',text:'Dictation lost its connection.'}]);
 const next=worker.start('k2');assert.equal(children.length,2,'a lost or changed worker starts fresh');children[1].say({type:'ready',device:'cpu',cards:0});await next;
 worker.stop();
});
