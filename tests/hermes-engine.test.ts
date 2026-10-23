import {mainSource} from './fixtures/main-source';
// The Hermes engine in Tris (TURN-REVIEW part 2 and section 7 item 3): every reply paired by the message IDs Hermes
// sends back; nothing left waiting; Stop never loses a message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {Store} from '../app/store';
import {clearHistoryReads} from '../app/chat-context';
import {toolResultFailed} from '../app/tool-result';
import {joinTurn,resetJoinedText,settleJoined} from '../app/turn-joins';
import {finalText} from '../app/turn-text';
import type {Turn} from '../app/types';

const source=mainSource();
function main(name:string,env:Record<string,unknown>){
 let node:ts.Node|undefined;const visit=(n:ts.Node)=>{if(ts.isFunctionDeclaration(n)&&n.name?.getText(source)===name)node=n;ts.forEachChild(n,visit);};visit(source);assert.ok(node,name);
 return new Function(...Object.keys(env),ts.transpile(node!.getText(source),{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(env));
}
function hermes(){
 const store=new Store(':memory:'),chat=store.chat(store.project().id);store.update<any>('chat',chat.id,{runtimeId:'session',storedId:'stored'});
 const hermesTurns=new Map<string,string>(),hermesSent=new Map<string,Set<string>>(),hermesStarted=new Set<string>(),hermesQueued=new Set<string>(),woken:string[]=[];
 const waitingFor=main('waitingFor',{hermesSent});
 const env:Record<string,unknown>={store,joinTurn,resetJoinedText,settleJoined,finalText,hermesTurnRows:new Map<string,string>(),hermesTurns,hermesSent,hermesStarted,hermesQueued,waitingFor,wake:(id:string)=>woken.push(id),emit:()=>{},emitStream:()=>{},
  hermesEvents:new Map(),hermesErrors:new Map(),hermesModels:new Map(),streamScrubbers:new Map(),usageBaseline:new Map(),requests:new Map(),mcpToolRequests:new Map(),
  backend:{generation:'g',scrubber:{value:(v:any)=>v,text:(s:string)=>s,stream:()=>(s:string)=>s}},nextWatermark:main('nextWatermark',{}),clearHistoryReads,toolResultFailed,
  coordination:{interrupt:()=>{},denied:()=>{}},background:{stopChat:async()=>{}},apiProviders:{rows:()=>[]},health:{hermes:()=>{}},blockedFor:()=>false,
  wireModel:(m:string)=>m,providerFor:()=>'deepseek',modelLabel:(m:string)=>m,claude:{},codex:{},providerStatus:'',recordRoute:()=>{},randomUUID:()=>crypto.randomUUID()};
 env.automaticHermes=main('automaticHermes',env);
 const receive=main('receive',env);let seq=0;
 const event=(type:string,payload:any={})=>receive({type,session_id:'session',seq:++seq,payload});
 // The start that runs a turn names it (Hermes turn_id); a start without one only announces a turn.
 let turns=0;const start=(payload:any={})=>event('message.start',{turn_id:'turn-'+(++turns),...payload});
 const send=(id:string,busy=false)=>{store.accept(id,chat.id,'Message '+id,'deepseek-flash');store.update<Turn>('turn',id,{status:'running'});if(busy)waitingFor(chat.id).add(id);else hermesTurns.set(chat.id,id);};
 return {store,chat,hermesTurns,hermesSent,hermesQueued,event,start,send,woken,turn:(id:string)=>store.get<Turn>('turn',id)};
}

test('a message steered into the running reply is answered by it, paired by ID',()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});h.send('B',true);
 assert.equal(h.hermesTurns.get(h.chat.id),'A');assert.equal(h.hermesSent.get(h.chat.id)?.has('B'),true,'busy: Hermes has B, not started');
 h.event('message.complete',{text:'Both answered',status:'complete',client_ids:['A','B']});
 assert.equal(h.turn('A').status,'completed');assert.equal(h.turn('A').text,'Both answered');
 assert.equal(h.turn('B').status,'completed');assert.equal(h.turn('B').answeredIn,'A');
 assert.equal(h.hermesTurns.has(h.chat.id),false);assert.equal(h.hermesSent.get(h.chat.id)?.size,0,'nothing left waiting');assert.deepEqual(h.woken,[h.chat.id]);
});

test('a steer that came after the last model call runs as the next turn, still paired (Hermes pending_steer)',()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});h.send('B',true);
 h.event('message.complete',{text:'A done',status:'complete',client_ids:['A']});
 assert.equal(h.turn('B').status,'running');assert.equal(h.hermesSent.get(h.chat.id)?.has('B'),true,'B still with Hermes');
 h.start({client_ids:['B']});assert.equal(h.hermesTurns.get(h.chat.id),'B');assert.equal(h.hermesSent.get(h.chat.id)?.size,0);
 h.event('message.complete',{text:'B done',status:'complete',client_ids:['B']});assert.equal(h.turn('B').status,'completed');assert.equal(h.turn('B').text,'B done');
});

test("Stop drops Hermes's queue: those messages go out again; a steered one survives and runs next (TURN-REVIEW part 5)",()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});h.send('B',true);h.hermesQueued.add('B');h.send('C',true);
 h.store.update<Turn>('turn','A',{status:'stopping'});h.event('message.complete',{text:'',status:'interrupted',client_ids:['A']});
 assert.equal(h.turn('A').status,'stopped');
 assert.equal(h.turn('B').status,'queued','queued in Hermes: dropped by its Stop, so Tris sends it again');assert.equal(h.turn('B').delivery,undefined);
 assert.equal(h.turn('C').status,'running','steered: Hermes runs it next (live check 10-15)');assert.equal(h.hermesSent.get(h.chat.id)?.has('C'),true);
 h.start({client_ids:['C']});h.event('message.complete',{text:'C done',status:'complete',client_ids:['C']});assert.equal(h.turn('C').text,'C done');
});

test('a turn Hermes starts by itself becomes its own automatic row, never glued onto his message',()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});h.event('message.complete',{text:'A done',status:'complete',client_ids:['A']});
 h.start();const auto=h.hermesTurns.get(h.chat.id)!;assert.ok(auto&&auto!=='A');assert.equal(h.turn(auto).automatic?.source,'self');
 h.event('message.delta',{text:'Job finished.'});h.event('message.complete',{text:'Job finished.',status:'complete'});
 assert.equal(h.turn(auto).status,'completed');assert.equal(h.turn(auto).text,'Job finished.');assert.equal(h.turn('A').text,'A done','his message untouched');
});

// 10-19 Sprite Dancer chat: Hermes announces a background update, then starts it; each start made a row and the first
// sat "Waiting for model" until a restart (33 rows).
test('a background update Hermes announces and then runs is one row, closed by its turn ID',()=>{
 const h=hermes();h.event('message.start',{});assert.equal(h.hermesTurns.has(h.chat.id),false,'an announce makes no row');
 h.event('message.start',{turn_id:'t1'});const auto=h.hermesTurns.get(h.chat.id)!;
 h.event('message.complete',{text:'Stale heartbeat.',status:'complete',turn_id:'t1'});
 assert.deepEqual(h.store.all<Turn>('turn').filter(t=>t.automatic).map(t=>t.status),['completed']);
 h.event('message.start',{});h.event('message.start',{turn_id:'t2'});assert.notEqual(h.hermesTurns.get(h.chat.id),auto,'a later update gets its own row');
 assert.equal(h.store.all<Turn>('turn').filter(t=>t.automatic).length,2);
});

// 10-19 KOAN.live chat: a reply failed (PendingSteer) without listing the messages it had read; they stayed busy
// until a restart and Fork said "Wait for queued work to finish."
test('a reply that fails settles the messages it read, so nothing stays busy',()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});h.send('B',true);h.send('C',true);
 h.event('message.read',{client_ids:['B']});assert.equal(h.turn('B').answeredIn,'A');
 h.event('message.complete',{status:'error',error:'PendingSteer crash',client_ids:['A']});
 assert.deepEqual([h.turn('A').status,h.turn('B').status,h.turn('B').error],['failed','failed','PendingSteer crash']);
 assert.equal(h.turn('C').status,'running','C was never read: Hermes still holds it');
});

test('two queued messages Hermes merges into one turn: the first owns the reply, the second is answered in it',()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});h.send('B',true);h.send('C',true);
 h.event('message.complete',{text:'A done',status:'complete',client_ids:['A']});
 h.start({client_ids:['B','C']});assert.equal(h.hermesTurns.get(h.chat.id),'B');assert.equal(h.turn('C').answeredIn,'B');
 assert.deepEqual(h.turn('C').readAt,{text:0,tools:0});
 h.event('message.complete',{text:'B and C',status:'complete',client_ids:['B','C']});
 assert.equal(h.turn('B').text,'B and C');assert.equal(h.turn('C').status,'completed');assert.equal(h.hermesSent.get(h.chat.id)?.size,0);
});

test('a steer records its read point once, before the owner continues',()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});
 h.event('message.delta',{text:'Before. '});h.event('tool.start',{tool_id:'one',name:'read_file',args:{}});h.send('B',true);
 h.event('message.read',{client_ids:['B']});assert.equal(h.turn('B').answeredIn,'A');assert.deepEqual(h.turn('B').readAt,{text:8,tools:1});
 h.event('message.delta',{text:'After.'});h.event('message.read',{client_ids:['B']});
 assert.deepEqual(h.turn('B').readAt,{text:8,tools:1},'replay must keep the original position');
 h.event('message.complete',{text:'Before. After.',status:'complete',client_ids:['A','B']});
 assert.deepEqual(h.turn('B').readAt,{text:8,tools:1});
});

test('a start that names no message runs the message Tris just sent',()=>{
 const h=hermes();h.send('A');h.start();assert.equal(h.hermesTurns.get(h.chat.id),'A');
 h.event('message.complete',{text:'A done',status:'complete'});assert.equal(h.turn('A').text,'A done');
});

// 10-19: "are you done?" was steered into a running job as 10,615 characters of fixed text plus his words.
test('his words alone go into a running reply; changed fixed text waits for an idle message',()=>{
 const resend=main('resendFixed',{});
 assert.equal(resend(true,false,undefined,'rules'),true,'a fresh session gets it');
 assert.equal(resend(false,true,'rules','rules + new job'),false,'never inside a steer');
 assert.equal(resend(false,false,'rules','rules + new job'),true,'the next idle message carries the change');
 assert.equal(resend(false,false,'rules','rules'),false);
});

test('Hermes commentary beside tool calls shows when it arrives and stays when the final message is empty (batch 4, 6b, 6c)',()=>{
 const h=hermes();h.send('A');h.start({client_ids:['A']});
 h.event('message.interim',{text:'I will read the file.',already_streamed:false});
 assert.equal(h.turn('A').text.trim(),'I will read the file.');
 h.event('message.interim',{text:'Streamed already.',already_streamed:true});
 h.event('message.delta',{text:'The answer.'});
 h.event('message.complete',{status:'complete',text:'',client_ids:['A']});
 assert.equal(h.turn('A').text,'I will read the file.\n\nThe answer.');
});
