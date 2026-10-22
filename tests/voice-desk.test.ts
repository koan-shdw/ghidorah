import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceDesk} from '../app/voice-desk';
import {Store} from '../app/store';

test('voice readback, refusal, edit, redirection and cancellation precede one isolated normal submission',async()=>{
 const store=new Store(':memory:'),project=store.project(),a=store.chat(project.id),b=store.chat(project.id);
 store.update<any>('chat',a.id,{draft:'keep my typed draft',selectedModels:['deepseek-flash'],attachments:[{id:'local-file'}]});
 let heard='fix the file',helperDraft='Fix calc.py',hold:((value:string)=>void)|null=null,submitFailure=false;
 const prompts:string[]=[],sent:string[]=[],speakers:string[]=[];
 const desk=new VoiceDesk({chats:()=>[{id:a.id,title:'Alpha'},{id:b.id,title:'Beta'}],context:async()=>('earlier '.repeat(6000)+'LATEST'),
  helper:async(_chat,_system,prompt)=>{prompts.push(prompt);return JSON.stringify({reply:'Ready.',draft:helperDraft,chatId:null,readPage:null});},
  decode:async()=>heard==='hold'?new Promise(resolve=>hold=resolve):heard,
  speak:async(_text,_signal,speaker)=>{speakers.push(speaker);return {audio:new Uint8Array([1]),mime:'audio/mpeg'};},
  submit:async draft=>{if(submitFailure)throw Error('No model available.');sent.push(draft.id);store.accept(draft.id,draft.chatId,draft.text,undefined,{voice:{version:draft.version}});return draft.id;},
  result:id=>{const turn=store.get<any>('turn',id);return {status:turn.status,text:turn.text};},echoDelay:()=>0});
 desk.open(a.id);const audio=new Uint8Array([1]);
 await assert.rejects(()=>desk.confirm('forged',audio),/no longer current/);
 const first=await desk.input(audio);assert.equal(JSON.parse(prompts[0]).context.pages,3);assert.match(first.text,/Alpha: Fix calc.py/);assert.equal(first.speaker,'helper');assert.equal(desk.state().speaker,'helper');
 assert.throws(()=>desk.begin(),/finished/);desk.finished(first.ticket,false);assert.throws(()=>desk.begin(),/finished/);
 const read=await desk.read();desk.finished(read.ticket,true);heard='no';await desk.confirm(desk.begin(),audio);assert.equal(sent.length,0);assert.equal(desk.state().draft?.text,'Fix calc.py');
 const old=desk.state().draft!;desk.edit(old,'Fix calc.py and test it');assert.throws(()=>desk.edit(old,'stale'),/changed/);
 const edited=await desk.read();desk.finished(edited.ticket,true);const stale=desk.begin();desk.select(b.id);heard='yes';await assert.rejects(()=>desk.confirm(stale,audio),/no longer current/);
 const redirected=await desk.read();assert.match(redirected.text,/Beta: Fix calc.py and test it/);desk.finished(redirected.ticket,true);
 const ticket=desk.begin();await desk.confirm(ticket,audio);await assert.rejects(()=>desk.confirm(ticket,audio),/no longer current/);assert.equal(sent.length,1);
 const turn=store.get<any>('turn',sent[0]);assert.equal(turn.chatId,b.id);assert.equal(turn.prompt,'Fix calc.py and test it');assert.equal(turn.voice.version,3);
 assert.ok(speakers.every(speaker=>speaker==='helper'),'Helper conversation and draft readbacks use the helper voice');
 store.update<any>('turn',turn.id,{status:'completed',text:'Fixed and checked.'});const answer=await desk.poll();assert.match(answer!.text,/AI has finished. Fixed and checked/);assert.equal(answer!.speaker,'reply');assert.equal(speakers.at(-1),'reply');assert.equal(desk.state().speaker,'reply');desk.finished(answer!.ticket,true);assert.equal(desk.state().speaker,null);assert.equal(await desk.poll(),null);
 const local=store.get<any>('chat',a.id);assert.equal(local.draft,'keep my typed draft');assert.deepEqual(local.attachments,[{id:'local-file'}]);assert.deepEqual(local.selectedModels,['deepseek-flash']);
 desk.open(a.id);heard='hold';const pending=desk.input(audio);desk.select(b.id);hold!('yes');await assert.rejects(()=>pending);assert.equal(sent.length,1);assert.equal(desk.state().chatId,b.id);assert.equal(desk.state().draft,null);
 desk.open(a.id);heard='request';const retry=await desk.input(audio);desk.finished(retry.ticket,true);submitFailure=true;heard='yes';await assert.rejects(()=>desk.confirm(desk.begin(),audio),/No model/);assert.equal(desk.state().draft?.text,'Fix calc.py');assert.throws(()=>desk.begin(),/finished/);assert.equal(sent.length,1);
 desk.close();await assert.rejects(()=>desk.input(audio),/current voice operation/);
 store.db.close();
});
