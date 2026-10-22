import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {NativeSessions} from '../app/native-sessions';
import {WorkCoordination} from '../app/work-coordination';
import {handover} from '../app/history';
import type {Turn} from '../app/types';

test('permission changes roll back every project session, including an unacknowledged change',async()=>{
 const store=new Store(':memory:'),owner=new NativeSessions(store,new WorkCoordination(store),()=>{}),make=(fail=false)=>({live:true,permissionMode:'manual',setMode:async function(mode:string){this.permissionMode=mode;if(fail&&mode==='auto')throw Error('Mode acknowledgement failed');},close:async function(){this.live=false;}}),first=make(),second=make(true),other=make();
 for(const [id,session] of [['one',first],['two',second],['unrelated',other]] as const)(owner as any).runtimes.set(id,{chatId:id,session});
 await assert.rejects(owner.setMode(['one','two'],'auto'),/acknowledgement/);assert.equal(first.permissionMode,'manual');assert.equal(second.permissionMode,'manual');assert.equal(other.permissionMode,'manual');
 await assert.rejects(owner.setMode(['one','two'],'plan',async()=>{throw Error('Policy write failed');}),/Policy write/);assert.equal(first.permissionMode,'manual');assert.equal(second.permissionMode,'manual');
 let committed=false;await owner.setMode(['one','two'],'bypass',async()=>{committed=true;});assert.equal(committed,true);assert.equal(first.permissionMode,'bypass');assert.equal(second.permissionMode,'bypass');assert.equal(other.permissionMode,'manual');store.db.close();
});

test('a native session that cannot restore its permission mode is closed',async()=>{
 const store=new Store(':memory:'),owner=new NativeSessions(store,new WorkCoordination(store),()=>{}),session={live:true,permissionMode:'manual',setMode:async(mode:string)=>{throw Error('Cannot confirm '+mode);},close:async()=>{session.live=false;}};
 (owner as any).runtimes.set('one',{chatId:'one',session});await assert.rejects(owner.setMode(['one'],'auto'),/was stopped/);assert.equal(session.live,false);store.db.close();
});

test('a background update cannot acknowledge an overlapping reply before its final result exists',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),owner=new NativeSessions(store,new WorkCoordination(store),()=>{});
 const first=store.accept('native-first',chat.id,'Start server','claude-code:haiku');store.update<Turn>('turn',first.id,{status:'completed',text:'Started'});
 const result={status:'completed' as const,sessionId:'native-session',result:{result:'Done'},models:[]};owner.finished('runtime',first,result);
 const human=store.accept('other-engine',chat.id,'Compute a result','deepseek-flash');store.update<Turn>('turn',human.id,{status:'running'});
 const update={...store.accept('background-update',chat.id,'','claude-code:haiku'),automatic:{originTurnId:first.id,taskId:'task'}};store.put('turn',update);
 assert.match(handover(store.all<Turn>('turn'),[],update,owner.position('runtime')).prompt,/"status":"running"/);
 store.update<Turn>('turn',human.id,{status:'completed',text:'Final result after update began'});store.update<Turn>('turn',update.id,{status:'completed',text:'Background done'});owner.finished('runtime',update,result);
 const next=store.accept('next',chat.id,'Continue','claude-code:haiku'),transfer=handover(store.all<Turn>('turn'),[],next,owner.position('runtime'));
 assert.equal(transfer.sessionId,'native-session');assert.match(transfer.prompt,/Final result after update began/);assert.match(transfer.prompt,/background_update/);store.db.close();
});

test('a message for a busy Claude goes into its live process, even before Claude reports its session ID',()=>{
 const store=new Store(':memory:'),owner=new NativeSessions(store,new WorkCoordination(store),()=>{});
 const busy={id:'process-1',sessionId:undefined as string|undefined,live:true,busy:true};
 (owner as any).runtimes.set('process-1',{chatId:'chat',session:busy,rows:new Set(['first'])});
 const position=owner.livePosition('chat',['older','first'])!;
 assert.equal(position.throughTurnId,'first');assert.equal(position.uncertain,false);assert.equal(position.sessionId,'process-1','its own ID stands in until Claude reports one');
 assert.equal(owner.busyRuntime('chat'),busy);
 busy.busy=false;assert.equal(owner.livePosition('chat',['first']),undefined,'an idle process without a session ID is not resumed');assert.equal(owner.busyRuntime('chat'),undefined);
 busy.sessionId='native';assert.equal(owner.livePosition('chat',['first'])!.sessionId,'native');store.db.close();
});
