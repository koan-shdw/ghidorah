// remote: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import featureWheels from '../../backend/feature-wheels.json';
import {backend,claude,data,drainRemoteInbox,emit,handlers,namespace,pluginRuntime,remoteChannel,remoteDesk,remoteEpoch,remoteSecret,root,store} from '../main';
import {modelLabel} from '../models';
import {redactPastedKeys} from '../redaction';
import {OutRow,approvalPrompt,clip,parseRequest,readInbound,readRemote,replyFor,secretApproval,topicName} from '../remote';
import {RemoteCodeState,bindingDigest,checkCode} from '../remote-code';
import {enqueueRemoteInbound} from '../remote-inbox';
import {claimRemoteOutbox,enqueueRemote,enqueueRemoteReply,recordRemoteReceipt,recoverRemoteOutbox,type TopicRecord} from '../remote-outbox';
import type {Approval,Chat,Turn} from '../types';
import {alwaysOn} from './accounts';
import {Notification} from 'electron';
import {ChildProcess,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// A Telegram message becomes a turn through the normal submit handler; its mark is set as the turn is accepted, so
// routing and the reply step see it. Only main sets it: a window cannot.
export function remoteSend(text:string,deny=false,approvalId?:string,thread?:string){
  const owner=remoteSettings().owner;if(!owner)return;
  const row=enqueueRemote(store,owner,backend.scrubber.text(text),approvalId,deny,{thread_id:thread});remoteChannel?.notify();return row;
}
export function remoteOutbox(after:number):OutRow[]{return claimRemoteOutbox(store,after,remoteSettings().owner);}
export function remoteSent(seq:number,ok:boolean,messageId?:string){
  const row=recordRemoteReceipt(store,seq,ok,messageId),shown=remoteShown();
  if(row.op==='topic'&&row.topicChat&&store.all<TopicRecord>('remote-topic').some(topic=>topic.id===row.topicChat&&topic.status==='creating')){
    if(row.status==='sent'&&row.messageId)store.update<TopicRecord>('remote-topic',row.topicChat,{status:'ready',threadId:row.messageId});
    else{
      // Usually Threaded Mode is off for the bot. Stop making topics until the switch is turned off and on.
      store.update<TopicRecord>('remote-topic',row.topicChat,{status:'failed'});
      remoteSave({topicError:'Telegram did not make a topic for a new chat. Open your bot’s chat in Telegram and tap Start, and in BotFather turn on Threaded Mode (your bot, Bot Settings, Threads Settings). Then turn "One topic per chat" off and on.'});
      remoteAlert('Telegram topic not made','Tap Start in your bot’s Telegram chat and turn on Threaded Mode in BotFather.');
    }
  }
  if(shown?.seq===seq&&row.approvalId===shown.approvalId){
    if(row.status==='sent'&&row.messageId)store.put('settings',{...shown,id:'remote-shown',messageId:row.messageId});
    else if(row.status==='uncertain'||!row.messageId){store.put('settings',{...shown,id:'remote-shown',kind:'desktop'});remoteAlert('Remote approval delivery unconfirmed','Review the pending approval on the desktop.');}
  }
}
export async function remoteInbound(value:unknown){
  const message=readInbound(value,remoteSettings().owner);if(!message||!remoteSettings().enabled)return;
  if(parseRequest(message.text).kind==='code'){await remoteDesk.receive(message);return;}
  if(backend.scrubber.text(message.text)!==message.text||redactPastedKeys(message.text)!==message.text){remoteSend('This looks like an API key. Save it in Settings.',false,undefined,message.thread_id);return;}
  enqueueRemoteInbound(store,message);void drainRemoteInbox();
}
// If the picker is unsure about a Telegram message, the chat's last model answers, else the first available one,
// and the reply says so; a message from Telegram never waits for a choice at the desktop (section 5, call 13).
export function remoteFallback(turn:Pick<Turn,'remote'>,input:{eligible:string[];previous:string|null}){
  if(!turn.remote)return null;
  const model=input.previous&&input.eligible.includes(input.previous)?input.previous:input.eligible[0]||null;
  if(model)turn.remote={...turn.remote,fallback:true};
  return model;
}
// A desktop alert for every remote task, blocked and failed ones included (5.21 H6). Tests record them only.
export function remoteAlert(title:string,body:string){
  const row={id:randomUUID(),title,body:backend.scrubber.text(body).slice(0,200),at:Date.now()};store.put('remote-alert',row);
  for(const old of store.all<any>('remote-alert').slice(0,-30))store.remove('remote-alert',old.id);
  if(alwaysOn().desktopNotifications&&!namespace.startsWith('Trismegistus/Test/')&&Notification.isSupported())new Notification({title,body:row.body}).show();
  emit();
}
export function remoteCounters(){const {id,...counters}=store.all<any>('settings').find(row=>row.id==='remote-code')||{};return counters as Omit<RemoteCodeState,'secret'>;}
export function remoteShown(){return store.all<any>('settings').find(row=>row.id==='remote-shown') as {approvalId:string;kind:'approval'|'question'|'desktop';digest:string;at:number;seq?:number;messageId?:string}|undefined;}
export function remoteBinding(approval:Approval){return {owner:remoteSettings().owner,origin:'telegram',chatId:approval.chatId,approvalId:approval.id,action:JSON.stringify([approval.turnId,approval.method,approval.params])};}
export async function remoteCode(code:string,replyTo?:string){
  const shown=remoteShown();if(shown?.kind!=='approval')return 'No approval is waiting.';
  const approval=store.all<Approval>('approval').find(row=>row.id===shown.approvalId);
  if(!approval||approval.status!=='pending'){store.remove('settings','remote-shown');return 'That approval is no longer waiting.';}
  if(!remoteSecret)return 'Pair an authenticator on the desktop first: Settings, Remote.';
  const result=checkCode({secret:remoteSecret,...remoteCounters()},code,shown,remoteBinding(approval),Date.now(),replyTo);
  const {secret,...counters}=result.state;store.put('settings',{id:'remote-code',...counters});
  if(!result.ok){
    if(['expired','changed'].includes(result.reason))store.remove('settings','remote-shown');emit();
    return ({paused:'Too many wrong codes. Try again later.',wrong:'That code is not right.',changed:'The approval changed; here it is again.',expired:'That approval timed out; here it is again.','not-a-code':'Send the 6-digit code.','reply-required':'Reply to the current approval message with the code; a code without that reply cannot approve an action.'} as Record<string,string>)[result.reason];
  }
  const expectedRemote={digest:shown.digest,epoch:remoteEpoch};store.remove('settings','remote-shown');try{await handlers.approve({id:approval.id,choice:'once',expectedRemote});return 'Approved.';}finally{emit();}
}
// Approvals of remote turns go to Telegram one at a time, oldest first. One for the secrets list is refused, never
// offered (5.21 H6). Without a paired authenticator an approval waits on the desktop.
export function settleApprovals(){
  const shown=remoteShown();
  if(shown&&store.all<Approval>('approval').find(row=>row.id===shown.approvalId)?.status!=='pending')store.remove('settings','remote-shown');
  if(remoteShown()||!remoteSettings().enabled)return;
  const remote=new Set(store.all<Turn>('turn').filter(turn=>turn.remote).map(turn=>turn.id));
  const next=store.all<Approval>('approval').find(row=>row.status==='pending'&&remote.has(row.turnId));if(!next)return;
  if(next.method!=='clarify'&&secretApproval(next.params)){void handlers.approve({id:next.id,choice:'deny'}).catch(()=>{});remoteSend('Refused: a message from Telegram cannot open the protected credentials. Use the desktop.',false,undefined,store.get<Turn>('turn',next.turnId).remote?.thread);remoteAlert('Remote task blocked','Protected credentials were refused.');return;}
  const question=next.method==='clarify',description=String(question?(next.params?.question||next.params?.questions?.[0]?.question||'The AI has a question.'):(next.params?.description||next.params?.command||'An action needs your approval.'));
  const kind=description.length>3600||question&&next.params?.questions?.length>1||!question&&!remoteSecret?'desktop':question?'question':'approval';
  store.transaction(()=>{
    const text=kind==='desktop'?'An approval is waiting on the desktop. Open the app to review it.':question?'Question:\n'+description+'\n\nReply to this message with your answer.':approvalPrompt(description);
    const row=remoteSend(text,kind==='approval',next.id,store.get<Turn>('turn',next.turnId).remote?.thread);
    store.put('settings',{id:'remote-shown',approvalId:next.id,kind,digest:bindingDigest(remoteBinding(next)),at:Date.now(),seq:row?.seq});
  });
}
export function remoteChats(){return store.all<Chat>('chat').filter(chat=>!chat.archived&&!chat.parentChatId).sort((a,b)=>(b.updated??b.created??0)-(a.updated??a.created??0)).map(({id,title})=>({id,title}));}
// Topics: each chat made while Remote is on gets a topic in the owner's bot chat, named after it (pinned ones lead
// with a pin). Desktop work in that chat is copied into its topic; a message in the topic goes to the chat.
export function remoteTopicChat(thread:string){
  const topic=store.all<TopicRecord>('remote-topic').find(row=>row.threadId===thread);if(!topic)return null;
  try{const chat=store.get<Chat>('chat',topic.id);return chat.archived?null:{id:chat.id,title:chat.title};}catch{return null;}
}
// A topic the owner made in Telegram, or one whose chat is gone: a new chat takes it over, renamed after that chat.
export async function remoteLinkTopic(thread:string){
  const id=await handlers.newChat({});
  for(const old of store.all<TopicRecord>('remote-topic').filter(row=>row.threadId===thread))store.remove('remote-topic',old.id);
  store.put<TopicRecord>('remote-topic',{id,threadId:thread,name:'',status:'ready',created:Date.now()});
  return {id,title:store.get<Chat>('chat',id).title};
}
let topicTimer:NodeJS.Timeout|undefined;
function settleTopicsSoon(){topicTimer??=setTimeout(()=>{topicTimer=undefined;try{settleTopics();}catch{}},1000);topicTimer.unref?.();}
function settleTopics(){
  const settings=remoteSettings();if(!settings.enabled||!settings.topics||settings.topicError||!settings.owner)return;
  if(settings.topicsSince===null){remoteSave({topicsSince:Date.now()});return;}
  const topics=new Map(store.all<TopicRecord>('remote-topic').map(row=>[row.id,row]));let queued=false;
  store.transaction(()=>{
    for(const chat of store.all<Chat>('chat')){
      if(chat.archived||chat.parentChatId||chat.sideSourceId)continue;
      const topic=topics.get(chat.id),name=topicName(chat);
      if(!topic){
        if((chat.created??0)<settings.topicsSince!)continue;
        store.put<TopicRecord>('remote-topic',{id:chat.id,name,status:'creating',created:chat.created??Date.now()});
        enqueueRemote(store,settings.owner,name,undefined,false,{op:'topic',topicChat:chat.id});queued=true;
      }else if(topic.status==='ready'&&topic.threadId&&topic.name!==name){
        store.update<TopicRecord>('remote-topic',chat.id,{name});
        enqueueRemote(store,settings.owner,name,undefined,false,{op:'rename',thread_id:topic.threadId});queued=true;
      }
    }
    // Desktop work in a chat with a topic: the message and its final reply, once each.
    const cursor=store.all<any>('settings').find(row=>row.id==='remote-mirror')?.at;
    if(typeof cursor!=='number'){store.put('settings',{id:'remote-mirror',at:Date.now()});return;}
    let at=cursor;
    for(const turn of store.turnsFinishedAfter<Turn>(cursor)){
      at=Math.max(at,turn.finished||0);
      const topic=topics.get(turn.chatId)||store.all<TopicRecord>('remote-topic').find(row=>row.id===turn.chatId);
      // Work that finished while Remote was off stays on the desktop rather than arriving in a burst.
      if(!topic||topic.status==='failed'||turn.remote||turn.parentTurnId||turn.automatic||turn.goal?.automatic||turn.created<topic.created||(turn.finished||0)<Date.now()-600000)continue;
      const models=turn.jobs?.length?turn.jobs.map(id=>store.get<Turn>('turn',id)).filter(job=>!job.automatic):[turn];
      const text='🖥 '+clip(turn.prompt.trim(),600)+'\n\n'+models.map(job=>replyFor(job,modelLabel(job.model,claude.models))).join('\n\n');
      enqueueRemote(store,settings.owner,backend.scrubber.text(clip(text)),undefined,false,{topicChat:turn.chatId});queued=true;
    }
    // ponytail: a turn finishing in the same millisecond as the cursor is missed; key on ids if that ever matters.
    if(at!==cursor)store.put('settings',{id:'remote-mirror',at});
  });
  if(queued)remoteChannel?.notify();
}
// The reply to each finished remote turn, sent once; called in emit(), the way settleParallel works.
export function settleRemote(){
  settleTopicsSoon();
  settleApprovals();
  for(const turn of store.turnsWith<Turn>('remote'))if(turn.remote&&!turn.remote.replied&&!turn.parentTurnId&&!turn.automatic&&['completed','partial','failed','stopped','interrupted'].includes(turn.status)){
    const models=turn.jobs?.length?turn.jobs.map(id=>store.get<Turn>('turn',id)).filter(job=>!job.automatic):[turn];
    const text=models.map(job=>replyFor(job,modelLabel(job.model,claude.models))).join('\n\n')+(turn.remote.fallback?'\nThe picker was unsure; an available model answered.':'');
    enqueueRemoteReply(store,turn.id,backend.scrubber.text(clip(text)));remoteChannel?.notify();
    if(turn.status!=='completed')remoteAlert('Remote task '+(turn.status==='stopped'?'stopped':'failed'),turn.error||turn.prompt);
  }
}
export function remoteRow(){return store.all<any>('settings').find(row=>row.id==='remote');}
export function remoteSettings(){return readRemote(remoteRow());}
export function remoteSave(patch:any){store.put('settings',{...remoteRow(),id:'remote',...patch});}
export function featureInstalled(feature:'telegram'|'speech'|'speech-gpu'){
  const runtime=pluginRuntime() as any,pins=featureWheels.packages as Record<string,{version:string}>;
  return !!runtime?.features?.includes(feature)&&featureWheels.features[feature].every(name=>runtime.packages?.some((pkg:any)=>pkg.name.toLowerCase().replace(/[-_.]+/g,'-')===name&&pkg.version===pins[name].version));
}
export function telegramInstalled(){return featureInstalled('telegram');}
export function gatewayHome(){return path.join(data,'hermes-gateway');}
export function launchGateway():ChildProcess{
  const uncertain=recoverRemoteOutbox(store);if(uncertain.length)remoteAlert('Remote delivery unconfirmed',uncertain.length+' outgoing messages need review; none will be sent again automatically.');
  const home=gatewayHome(),child=spawn(backend.python,[path.join(root,'backend','host.py')],{windowsHide:true,stdio:'pipe',env:{...backend.environment(),HERMES_HOME:home,HERMES_SHARED_AUTH_DIR:path.join(home,'shared')}});
  child.stdin.on('error',()=>{});child.stdout.on('data',()=>{});
  // The open stdin is the lease: main's end closing ends the gateway. The bot token never leaves the vault here.
  child.stdin.write(JSON.stringify({operation:'gateway',credential_namespace:namespace,owner:remoteSettings().owner,channel:remoteChannel!.rotate(),runtime:pluginRuntime()})+'\n');
  return child;
}
