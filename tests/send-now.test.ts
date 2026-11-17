import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendNowCheck} from '../app/send-now';
import type {Turn} from '../app/types';

const turn=(id:string,created:number,extra:Partial<Turn>={})=>({id,chatId:'c',created,model:'m',prompt:'',text:'',reasoning:'',status:'running',error:null,usage:null,...extra}) as Turn;
const reply=turn('reply',1),sent=turn('sent',2,{delivery:'sent'}),queued=turn('queued',3,{status:'queued'});
const why=(row:Turn,rows:Turn[],replyId:string|null)=>{const result=sendNowCheck(row,rows,replyId);return result.ok?'':result.why;};

test('a message the running reply has not read can be pushed, whichever way it waits',()=>{
 assert.deepEqual(sendNowCheck(sent,[reply,sent,queued],'reply'),{ok:true});
 assert.deepEqual(sendNowCheck(queued,[reply,sent,queued],'reply'),{ok:true});
});
test('nothing is pushed when Stop would not send it',()=>{
 assert.match(why(reply,[reply,sent],'reply'),/being answered now/);
 assert.match(why(turn('read',2,{delivery:undefined,answeredIn:'reply'}),[reply],'reply'),/already read/);
 assert.match(why(turn('done',2,{status:'completed'}),[reply],'reply'),/not waiting/);
 assert.match(why(turn('plain',2),[reply],'reply'),/not waiting/,'running with nothing sent is a reply of its own');
 assert.match(why(turn('agent',2,{delivery:'sent',automatic:{kind:'agent',originTurnId:'reply',taskId:'t'}}),[reply],'reply'),/Only a message you sent/);
 assert.match(why(turn('model',2,{status:'needs-model'}),[reply],'reply'),/Choose a model/);
 assert.match(why(turn('paused',2,{status:'queued',paused:true}),[reply],'reply'),/paused/);
 assert.match(why(turn('limit',2,{status:'queued',paused:true,resume:{at:9,reason:'limit'}}),[reply],'reply'),/usage limit/);
 assert.match(why(turn('routing',2,{status:'queued',routePending:true}),[reply],'reply'),/still being chosen/);
});
test('with no reply running, or one already stopping, there is nothing to stop',()=>{
 assert.match(why(queued,[queued],null),/goes out by itself/);
 assert.match(why(queued,[queued],'gone'),/goes out by itself/,'a reply id that is not in the chat is no reply');
 assert.match(why(sent,[turn('reply',1,{status:'stopping'}),sent],'reply'),/already stopping/);
});
test('a message behind one that cannot leave is not pushed past it',()=>{
 const model=turn('model',2,{status:'needs-model'}),paused=turn('paused',2,{status:'queued',paused:true});
 assert.match(why(queued,[reply,model,queued],'reply'),/earlier message needs a model/);
 assert.match(why(queued,[reply,paused,queued],'reply'),/earlier message is paused/);
 assert.deepEqual(sendNowCheck(sent,[reply,sent,turn('later',9,{status:'needs-model'})],'reply'),{ok:true},'a later held message holds nothing before it');
 assert.deepEqual(sendNowCheck(queued,[reply,turn('read',2,{status:'needs-model',answeredIn:'reply'}),queued],'reply'),{ok:true});
});
