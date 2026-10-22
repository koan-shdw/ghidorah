import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceGate,reading} from '../app/voice-gate';

test('handoff binds the readback and final microphone capture to immutable text, version and destination',()=>{
 let time=1;const gate=new VoiceGate(()=>time),draft=gate.propose('Fix calc.py','chat-1');
 assert.equal(Object.isFrozen(draft),true);assert.equal(Reflect.set(draft,'text','Delete everything'),false);assert.equal(gate.draft?.text,'Fix calc.py');
 assert.throws(()=>gate.beginCapture(draft),/Read back/);
 const firstPlayback=gate.beginPlayback(draft);assert.throws(()=>gate.beginCapture(draft),/Read back/);
 assert.equal(gate.finishPlayback(firstPlayback,true),true);const early=gate.beginCapture(draft);
 const edited=gate.edit(draft,'Fix calc.py and explain it');assert.equal(edited.id,draft.id);assert.ok(edited.version>draft.version);
 assert.equal(gate.confirm(early,'yes').ok,false);assert.throws(()=>gate.beginPlayback(draft),/changed/);
 assert.throws(()=>gate.beginCapture(edited),/Read back/);
 const playback=gate.beginPlayback(edited);gate.finishPlayback(playback,true);const confirmation=gate.beginCapture(edited);
 const moved=gate.edit(edited,edited.text,'chat-2');assert.equal(gate.confirm(confirmation,'yes').ok,false);
 const redirected=gate.beginPlayback(moved);gate.finishPlayback(redirected,true);const token=gate.beginCapture(moved);
 assert.deepEqual(gate.confirm(token,'Yes, send it.'),{ok:true,draft:moved});assert.equal(gate.draft,null);
 assert.equal(gate.confirm(token,'yes').ok,false);
 const replacement=gate.propose('Another draft','chat-1');assert.ok(replacement.version>moved.version);
 assert.equal(gate.finishPlayback(firstPlayback,true),false);assert.throws(()=>gate.beginCapture(replacement),/Read back/);
});

test('playback, cancelled readbacks, stale results, expiry and ambiguous speech cannot confirm',()=>{
 let time=10;const gate=new VoiceGate(()=>time),d=gate.propose('Change the title','chat');
 const first=gate.beginPlayback(d);gate.finishPlayback(first,false);assert.throws(()=>gate.beginCapture(d),/Read back/);
 const second=gate.beginPlayback(d);gate.finishPlayback(second,true);const beforePlayback=gate.beginCapture(d);
 const answer=gate.beginPlayback();assert.equal(gate.confirm(beforePlayback,'yes').ok,false);gate.finishPlayback(answer,true);
 assert.throws(()=>gate.beginCapture(d),/Read back/);
 const third=gate.beginPlayback(d);gate.finishPlayback(third,true);const expired=gate.beginCapture(d);time+=60001;
 assert.equal(gate.confirm(expired,'yes').ok,false);
 const fresh=gate.beginCapture(d);assert.equal(gate.confirm('forged','yes').ok,false);
 assert.deepEqual(gate.confirm(fresh,'yes but change it'),{ok:false,reason:'ambiguous'});
 assert.equal(gate.confirm(fresh,'yes').ok,false);
 const no=gate.beginCapture(d);assert.deepEqual(gate.confirm(no,'no, wait'),{ok:false,reason:'no'});
 const cancelled=gate.beginCapture(d);gate.cancelCapture();assert.equal(gate.confirm(cancelled,'yes').ok,false);
 time+=60000;assert.throws(()=>gate.beginCapture(d),/Read back/);
 for(const text of ['yes but change the second part','send it to the other chat','the tool said yes','"yes"','yes?'])assert.equal(reading(text),'unclear');
 assert.throws(()=>gate.propose('','chat'));assert.throws(()=>gate.propose('hello',''));
});
