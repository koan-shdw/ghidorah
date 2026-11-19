// remote: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import featureWheels from '../../backend/feature-wheels.json';
import {backend,background,claude,data,drainRemoteInbox,emit,handlers,namespace,native,pluginRuntime,remoteChannel,remoteDesk,remoteEpoch,remoteSecret,root,store} from '../main';
import {modelLabel} from '../models';
import {redactPastedKeys} from '../redaction';
import {AWAY_SECONDS,ChatState,GLYPH,GlyphMemory,HomeRow,Key,LiveFrame,Media,OutRow,approvalPrompt,clip,draftId,draftText,homeCard,markFor,parseRequest,planCard,readEvent,readInbound,readRemote,replyFor,replyShare,secretApproval,settledGlyph,sounds,topicLink} from '../remote';
import {activeAgents,planSteps} from '../activity';
import {RemoteCodeState,bindingDigest,checkCode} from '../remote-code';
import {enqueueRemoteInbound} from '../remote-inbox';
import {cardReceipt,claimRemoteOutbox,enqueueRemote,enqueueRemoteReply,pruneRemoteOutbox,recordRemoteReceipt,recoverRemoteOutbox,setCard,type CardRecord,type OutPlace,type OutRecord,type TopicRecord} from '../remote-outbox';
import {resetClock} from '../limit-pause';
import {dropLimitCarry,limitCarries} from './limit-carry';
import {NAME_SYSTEM,autoTitled,cleanName,fallbackName,planTopics,topicRetry,uniqueName,type TopicChat} from '../remote-threads';
import type {Approval,Attachment,Chat,ToolCall,Turn} from '../types';
import {saveAttachment} from '../attachments';
import {speechReady,voiceSettings} from './voice';
import fs from 'node:fs/promises';
import {alwaysOn} from './accounts';
import {contextCompletion,sideModel} from './context';
import {Notification,powerMonitor} from 'electron';
import {ChildProcess,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// A Telegram message becomes a turn through the normal submit handler; its mark is set as the turn is accepted, so
// routing and the reply step see it. Only main sets it: a window cannot.
export function remoteSend(text:string,deny=false,approvalId?:string,thread?:string,more:OutPlace={}){
  const owner=remoteSettings().owner;if(!owner)return;
  const row=enqueueRemote(store,owner,backend.scrubber.text(text),approvalId,deny,{...(thread?{thread_id:thread}:{}),...more});remoteChannel?.notify();return row;
}
export function remoteOutbox(after:number):OutRow[]{return claimRemoteOutbox(store,after,remoteSettings().owner);}
export function remoteSent(seq:number,ok:boolean,messageId?:string,gone=false){
  const before=store.find<OutRecord>('remote-out',String(seq)),row=recordRemoteReceipt(store,seq,ok,messageId),shown=remoteShown();
  if(before?.status!=='sending')return;
  cardReceipt(store,row.chat_id,row,gone);
  // Home is pinned once it exists, so it stays on top of the bot chat's main view.
  if(row.card==='home'&&!row.op&&row.status==='sent'&&row.messageId)enqueueRemote(store,row.chat_id,'',undefined,false,{op:'pin',message_id:row.messageId});
  const topics=store.all<TopicRecord>('remote-topic');
  if(row.op==='topic'&&row.topicChat&&topics.some(topic=>topic.id===row.topicChat&&topic.status==='creating')){
    if(row.status==='sent'&&row.messageId){
      store.update<TopicRecord>('remote-topic',row.topicChat,{status:'ready',threadId:row.messageId,tries:0,retryAt:undefined});
      if(remoteSettings().topicError)remoteSave({topicError:''});
      // A chat started by a text in the main view: say there where its thread is.
      const chat=store.find<Chat>('chat',row.topicChat);
      if(chat&&store.where<Turn>('turn','chatId',chat.id).some(turn=>turn.remote&&!turn.remote.thread&&!turn.parentTurnId&&!turn.automatic)){const link=topicLink(remoteSettings().username,row.messageId);remoteSend('New chat: '+row.text,false,undefined,undefined,link?{keys:[[{text:'Open '+clip(row.text,40),url:link}]]}:{});}
    }else{
      // Usually Threaded Mode is off for the bot. It is tried again by itself, a little later each time.
      const tries=(topics.find(topic=>topic.id===row.topicChat)?.tries||0)+1;
      store.update<TopicRecord>('remote-topic',row.topicChat,{status:'failed',tries,retryAt:topicRetry(tries,Date.now())});
      if(tries===1){
        remoteSave({topicError:'Telegram did not make a thread for a chat. Open your bot’s chat in Telegram and tap Start, and in BotFather turn on Threaded Mode (your bot, Bot Settings, Threads Settings). Ghidorah tries again by itself.'});
        remoteAlert('Telegram thread not made','Tap Start in your bot’s Telegram chat and turn on Threaded Mode in BotFather.');
      }
    }
  }
  // A deleted thread's record goes whatever Telegram answered: nothing more can be done about it from here.
  if(row.op==='delete'&&row.thread_id)for(const topic of topics)if(topic.threadId===row.thread_id&&topic.status==='deleting')store.remove('remote-topic',topic.id);
  // He cleared the bot's chat, or deleted the thread there: the chat gets a new one, and this row goes into it.
  if(gone&&row.thread_id&&row.op!=='delete'){
    const topic=topics.find(topic=>topic.threadId===row.thread_id&&topic.status==='ready');
    if(topic){
      store.update<TopicRecord>('remote-topic',topic.id,{status:'pending',threadId:undefined,name:''});
      // A card is not sent again from here: its record is gone (cardReceipt), so its next change sends it anew.
      if(!row.op&&!row.approvalId&&!row.card){const {id,seq:old,status,messageId:sentId,thread_id,chat_id,text,deny,approvalId,...rest}=row;enqueueRemote(store,chat_id,text,undefined,false,{...rest,topicChat:topic.id,fallback:true});}
    }
  }
  if(shown?.seq===seq&&row.approvalId===shown.approvalId){
    if(row.status==='sent'&&row.messageId)store.put('settings',{...shown,id:'remote-shown',messageId:row.messageId});
    else if(row.status==='uncertain'||!row.messageId){store.put('settings',{...shown,id:'remote-shown',kind:'desktop'});remoteAlert('Remote approval delivery unconfirmed','Review the pending approval on the desktop.');}
  }
}
// A file the gate hands over is read only from the gateway's own folder, where its Telegram adapter saved it.
function gatewayFile(file:string){
  const full=path.resolve(file),home=path.resolve(gatewayHome())+path.sep;
  return full.toLowerCase().startsWith(home.toLowerCase())?full:null;
}
// A voice note's words, through the listening model on this PC (Settings, Voice). The online listening engines
// take live sound only, so a voice note needs the local one.
export async function remoteHear(file:string){
  const full=gatewayFile(file);if(!full)throw Error('That voice note is not one the gateway saved.');
  if(!speechReady())throw Error('A voice note needs the listening model on the PC. Install it in Settings, Voice.');
  const result=await backend.host('transcribe',{file:full,model:voiceSettings().sttModel,runtime:pluginRuntime()});
  return redactPastedKeys(backend.scrubber.text(String(result?.text||'')));
}
// His photos and files become attachments of the message they came with, saved and checked as a file attached on
// the PC is. A video is not taken: it needs a model picked for it on the PC.
export async function remoteAttach(chatId:string,media:Media[]){
  const items:Attachment[]=[];
  for(const item of media){
    const full=gatewayFile(item.path);if(!full)throw Error('That file is not one the gateway saved.');
    const name=(item.name||path.basename(full)).replace(/[\\/\x00-\x1f]/g,'_').slice(0,240);
    items.push(await saveAttachment(path.join(data,'attachments'),chatId,name,new Uint8Array(await fs.readFile(full)),async source=>{const prepared=await backend.host('attachment_prepare',{file:source,name});if(prepared.kind==='video')throw Error('A video cannot be sent in from Telegram. Attach it on the PC.');return prepared;},
      text=>{if(backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text)throw Error('This file contains a credential. Remove it before sending.');}));
  }
  return items;
}
export async function remoteInbound(value:unknown){
  const message=readInbound(value,remoteSettings().owner);if(!message||!remoteSettings().enabled)return;
  if(message.media?.some(item=>!gatewayFile(item.path)))return;
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
  // By button (his switch in Settings, Remote) an approval needs no paired authenticator; by code it does.
  const byButton=remoteSettings().approveBy==='button';
  const kind=description.length>3600||question&&next.params?.questions?.length>1||!question&&!remoteSecret&&!byButton?'desktop':question?'question':'approval';
  store.transaction(()=>{
    const digest=bindingDigest(remoteBinding(next)),buttons=kind==='approval'&&byButton;
    const text=kind==='desktop'?'An approval is waiting on the desktop. Open the app to review it.':question?'Question:\n'+description+'\n\nReply to this message with your answer.':buttons?'Approval needed:\n'+clip(description.trim(),3600):approvalPrompt(description);
    const row=remoteSend(text,kind==='approval'&&!buttons,next.id,store.get<Turn>('turn',next.turnId).remote?.thread,{notify:loud('needs'),...(buttons?{keys:[[{text:'Approve',data:'gh:ok:'+digest.slice(0,24),style:'success'},{text:'Deny',data:'gh:no:'+digest.slice(0,24),style:'danger'}]]}:{})});
    store.put('settings',{id:'remote-shown',approvalId:next.id,kind,digest,at:Date.now(),seq:row?.seq});
  });
}
export function remoteChats(){return store.all<Chat>('chat').filter(chat=>!chat.archived&&!chat.parentChatId).sort((a,b)=>(b.updated??b.created??0)-(a.updated??a.created??0)).map(({id,title})=>({id,title}));}
// One thread per chat (Koan 2026-11-19, version 3 of the Telegram mockup): every chat with a message has a thread
// in the owner's bot chat, named as in the app, and the thread goes when its chat is deleted or archived. Desktop
// work in a chat is copied into its thread; a message in the thread goes to the chat.
export function remoteTopicChat(thread:string){
  const topic=store.all<TopicRecord>('remote-topic').find(row=>row.threadId===thread&&row.status!=='deleting');if(!topic)return null;
  try{const chat=store.get<Chat>('chat',topic.id);return chat.archived?null:{id:chat.id,title:chat.title};}catch{return null;}
}
// A topic the owner made in Telegram, or one whose chat is gone: a new chat takes it over, renamed after that chat.
export async function remoteLinkTopic(thread:string){
  const id=await handlers.newChat({});
  for(const old of store.all<TopicRecord>('remote-topic').filter(row=>row.threadId===thread))store.remove('remote-topic',old.id);
  store.put<TopicRecord>('remote-topic',{id,threadId:thread,name:'',status:'ready',created:Date.now()});
  return {id,title:store.get<Chat>('chat',id).title};
}
// A chat started by a text in the bot chat's main view: its record is made at once, so the reply waits for the thread.
export function remotePlanTopic(chatId:string){
  const settings=remoteSettings();if(!settings.topics||store.all<TopicRecord>('remote-topic').some(row=>row.id===chatId))return;
  store.put<TopicRecord>('remote-topic',{id:chatId,name:'',status:'pending',created:store.find<Chat>('chat',chatId)?.created??Date.now()});
}
// "Make all threads again" (Settings, Remote), for after he has cleared the bot's chat in Telegram: every thread the
// app knows is deleted there, and settleTopics makes one per chat again, the oldest used first.
export function remoteRebuildTopics(){
  const settings=remoteSettings();if(!settings.owner)throw Error('Add your Telegram user ID first.');
  store.transaction(()=>{
    for(const row of store.all<OutRecord>('remote-out'))if(row.status==='pending'&&(row.topicChat||row.thread_id||row.op))store.update<OutRecord>('remote-out',row.id,{status:'cancelled'});
    for(const topic of store.all<TopicRecord>('remote-topic')){
      if(topic.threadId)enqueueRemote(store,settings.owner,'',undefined,false,{op:'delete',thread_id:topic.threadId});
      store.remove('remote-topic',topic.id);
    }
  });
  remoteSave({topicError:''});remoteChannel?.notify();emit();
}
const topicChats=()=>store.all<Chat>('chat').filter(chat=>!chat.archived&&!chat.parentChatId&&!chat.sideSourceId);
// The message a chat started with: his own, never one the app or an agent sent.
const firstMessage=(chatId:string)=>store.where<Turn>('turn','chatId',chatId).filter(turn=>!turn.parentTurnId&&!turn.automatic&&!turn.contextSnapshot).sort((a,b)=>a.created-b.created)[0] as Turn|undefined;
// What each chat is doing, for its thread's icon and for Home: it needs him (an approval or a question waits), it
// works, or the usage limit holds it. A chat that does none of these is not listed.
function chatStates(now=Date.now()){
  const states=new Map<string,{state:ChatState;agents:number;until?:number}>(),rootOf=(chatId:string)=>{const chat=store.find<Chat>('chat',chatId);return chat?.parentChatId||chat?.id;};
  for(const status of ['dispatching','running','waiting','stopping'])for(const turn of store.where<Turn>('turn','status',status)){
    if(turn.delivery==='sent')continue;                       // a message waiting to be read is not work
    const root=rootOf(turn.chatId);if(!root)continue;
    const entry=states.get(root)||{state:'working' as ChatState,agents:0};if(turn.automatic?.kind==='agent')entry.agents++;states.set(root,entry);
  }
  for(const [chatId,hold] of chatHolds(now))if(!states.has(chatId))states.set(chatId,{state:'held',agents:0,until:hold.at});
  for(const approval of store.all<Approval>('approval'))if(approval.status==='pending'){const root=rootOf(approval.chatId);if(root)states.set(root,{agents:states.get(root)?.agents||0,state:'needs'});}
  return states;
}
// The state mark that leads a chat's thread name, once it has settled (remote.ts settledGlyph).
const glyphs=new Map<string,GlyphMemory>();
function topicGlyph(chatId:string){return glyphs.get(chatId)?.shown||'';}
// Home (Koan 2026-11-19, version 3 of the mockup): one message in the bot chat's main view, pinned and kept current:
// what works, what needs him, what the limit holds, the limit itself, and a link to each of those threads.
let homeAt=0;
function limitLine(now:number){
  const windows=claude?.windows||[],row=windows.find(item=>/session|5/i.test(item.label))||windows[0];if(!row||typeof row.usedPercent!=='number')return '';
  const at=row.resetAt?Date.parse(row.resetAt):NaN;
  return 'Limit '+Math.round(row.usedPercent)+'% used'+(Number.isFinite(at)&&at>now?', resets '+resetClock(at,now):'');
}
function settleHome(states:ReturnType<typeof chatStates>,now:number){
  const threads=new Map(store.all<TopicRecord>('remote-topic').filter(topic=>topic.status==='ready'&&topic.threadId).map(topic=>[topic.id,topic.threadId!])),rows:HomeRow[]=[];
  for(const [chatId,entry] of states){const chat=store.find<Chat>('chat',chatId);if(chat&&!chat.archived&&!chat.sideSourceId)rows.push({state:entry.state,title:chat.title,agents:entry.agents,...(entry.until?{until:resetClock(entry.until,now)}:{}),...(threads.has(chatId)?{thread:threads.get(chatId)}:{})});}
  const card=homeCard(rows,limitLine(now),remoteSettings().username),old=store.all<CardRecord>('remote-card').find(row=>row.id==='home');
  if(old&&old.text===backend.scrubber.text(card.text)&&JSON.stringify(old.keys||[])===JSON.stringify(card.keys))return;
  // At most one change in five seconds: a busy minute must not become a stream of edits.
  if(now-homeAt<5000){settleTopicsSoon();return;}
  homeAt=now;remoteCard('home',card);
}
// The plan (version 3 of the mockup): a reply's steps as a checklist in its thread, kept current while it works and
// left as it stood when it ends. The same steps as the checklist at the top of the reply in the app (planSteps).
const planAt=new Map<string,number>();
function chatPlan(turn:Turn){
  const earlier=()=>store.whereIn<ToolCall>('tool','turnId',store.where<Turn>('turn','chatId',turn.chatId).filter(row=>row.created<turn.created).map(row=>row.id));
  return planSteps(store.where<ToolCall>('tool','turnId',turn.id),earlier);
}
function settlePlans(now:number){
  const threads=new Set(store.all<TopicRecord>('remote-topic').filter(topic=>topic.status==='ready').map(topic=>topic.id)),working=new Set<string>();
  for(const status of ['running','waiting','stopping'])for(const turn of store.where<Turn>('turn','status',status)){
    if(turn.parentTurnId||turn.automatic||turn.answeredIn||turn.delivery==='sent'||!threads.has(turn.chatId))continue;
    working.add(turn.id);
    if(now-(planAt.get(turn.id)||0)<3000)continue;
    planAt.set(turn.id,now);const steps=chatPlan(turn);
    // While agents work for the chat the plan carries "Stop the agents": the reply itself goes on.
    const agents=store.where<Turn>('turn','chatId',turn.chatId).some(row=>row.automatic?.kind==='agent'&&(row.status==='running'||row.status==='waiting'));
    if(steps?.length)remoteCard('plan:'+turn.id,{text:planCard(steps),...(agents?{keys:[[{text:'Stop the agents',data:'gh:agents:'+turn.chatId}]]}:{})},turn.chatId);
  }
  for(const card of store.all<CardRecord>('remote-card'))if(card.id.startsWith('plan:')&&!working.has(card.id.slice(5))){
    const turn=store.find<Turn>('turn',card.id.slice(5)),steps=turn?chatPlan(turn):null;planAt.delete(card.id.slice(5));
    remoteCard(card.id,{text:steps?.length?planCard(steps,true):card.text},turn?.chatId,{},true);
  }
}
// A chat he has not named gets a short name, written by a fast model from its first message, one chat at a time,
// the oldest used first; the sidebar shows the same name (his calls of 2026-11-19). A chat he named, or one whose
// title the app made for a purpose (a goal, a fork, a handover), is marked as named and left alone.
let naming=false;
async function nameNext(){
  if(naming)return;
  const records=new Set(store.all<TopicRecord>('remote-topic').filter(row=>row.status!=='deleting').map(row=>row.id));
  let next:{chat:Chat;prompt:string}|undefined;
  for(const chat of topicChats().filter(chat=>!chat.named&&records.has(chat.id)).sort((a,b)=>(a.updated??a.created??0)-(b.updated??b.created??0))){
    const first=firstMessage(chat.id);if(!first)continue;
    if(autoTitled(chat,first.prompt)){next={chat,prompt:first.prompt};break;}
    store.update<Chat>('chat',chat.id,{named:'user'});
  }
  if(!next)return;
  naming=true;
  try{
    const prompt=redactPastedKeys(backend.scrubber.text(next.prompt)).trim().slice(0,800),model=prompt?sideModel():null;let name='';
    if(model)try{name=cleanName((await contextCompletion(next.chat,model,NAME_SYSTEM,prompt,AbortSignal.timeout(30000),true)).text);}catch{}
    // He may have renamed the chat, or deleted it, while the name was written.
    const chat=store.find<Chat>('chat',next.chat.id);
    if(chat&&autoTitled(chat,next.prompt))store.update<Chat>('chat',chat.id,{title:uniqueName(name||fallbackName(prompt),topicChats().filter(row=>row.id!==chat.id).map(row=>row.title)),named:'app'});
  }finally{naming=false;emit();}
}
let topicTimer:NodeJS.Timeout|undefined;
function settleTopicsSoon(){topicTimer??=setTimeout(()=>{topicTimer=undefined;try{settleTopics();}catch{}},1000);topicTimer.unref?.();}
function settleTopics(){
  const settings=remoteSettings();if(!settings.enabled||!settings.topics||!settings.owner)return;
  const records=store.all<TopicRecord>('remote-topic'),known=new Set(records.map(row=>row.id)),chats:TopicChat[]=[];
  // A chat gets its thread with its first message, never before.
  for(const chat of topicChats())if(known.has(chat.id)||firstMessage(chat.id))chats.push({id:chat.id,title:chat.title,used:chat.updated??chat.created??0,named:!!chat.named});
  // Each chat's state: the mark on its thread once it has held for a moment, and Home.
  const now=Date.now(),states=chatStates(now);let queued=false,unsettled=false;
  for(const chat of chats){
    const state=settings.stateIcon?states.get(chat.id)?.state:undefined,memory=settledGlyph(glyphs.get(chat.id),state?GLYPH[state]:'',now);
    if(memory.shown||memory.want)glyphs.set(chat.id,memory);else glyphs.delete(chat.id);
    if(memory.shown!==memory.want)unsettled=true;
  }
  try{settleHome(states,now);settlePlans(now);}catch{}
  if(unsettled)settleTopicsSoon();
  store.transaction(()=>{
    for(const step of planTopics(chats,records,now,topicGlyph)){
      if(step.do==='plan')store.put<TopicRecord>('remote-topic',{id:step.chatId,name:'',status:'pending',created:store.find<Chat>('chat',step.chatId)?.created??0});
      else if(step.do==='create'){store.update<TopicRecord>('remote-topic',step.chatId,{name:step.name,status:'creating'});enqueueRemote(store,settings.owner,step.name,undefined,false,{op:'topic',topicChat:step.chatId});queued=true;}
      else if(step.do==='rename'){store.update<TopicRecord>('remote-topic',step.chatId,{name:step.name});enqueueRemote(store,settings.owner,step.name,undefined,false,{op:'rename',thread_id:step.thread});queued=true;}
      else if(step.thread){store.update<TopicRecord>('remote-topic',step.id,{status:'deleting'});enqueueRemote(store,settings.owner,'',undefined,false,{op:'delete',thread_id:step.thread});queued=true;}
      else store.remove('remote-topic',step.id);
    }
    const topics=new Map(store.all<TopicRecord>('remote-topic').map(row=>[row.id,row]));
    // Desktop work in a chat with a topic: the message and its final reply, once each.
    const cursor=store.all<any>('settings').find(row=>row.id==='remote-mirror')?.at;
    if(typeof cursor!=='number'){store.put('settings',{id:'remote-mirror',at:Date.now()});return;}
    let at=cursor;
    for(const turn of store.turnsFinishedAfter<Turn>(cursor)){
      at=Math.max(at,turn.finished||0);
      const topic=topics.get(turn.chatId);
      // Work that finished while Remote was off stays on the desktop rather than arriving in a burst.
      if(!topic||topic.status==='failed'||topic.status==='deleting'||turn.remote||turn.parentTurnId||turn.automatic||turn.goal?.automatic||(turn.finished||0)<Date.now()-600000)continue;
      if(copyDesktopTurn(turn))queued=true;
    }
    // ponytail: a turn finishing in the same millisecond as the cursor is missed; key on ids if that ever matters.
    if(at!==cursor)store.put('settings',{id:'remote-mirror',at});
  });
  if(queued)remoteChannel?.notify();
  void nameNext();
}
// Live (Koan 2026-11-19, version 3 of the Telegram mockup): the answer to a text from Telegram shows in its thread
// while it is written, as a draft that each frame replaces, with Stop. Frames are kept in memory only: a lost one
// costs nothing, the finished reply goes out as a message either way. A draft lasts 30 seconds in Telegram, so an
// unchanged one is said again after 20.
const liveFrames=new Map<string,LiveFrame&{at:number}>();let liveSeq=0,liveTimer:NodeJS.Timeout|undefined,liveLast=0;
export function remoteLive(after:number):LiveFrame[]{return [...liveFrames.values()].filter(frame=>frame.n>after).sort((a,b)=>a.n-b.n).map(({at,...frame})=>frame);}
export function remoteLiveSoon(){
  if(liveTimer||!liveFrames.size&&!remoteSettings().enabled)return;
  liveTimer=setTimeout(()=>{liveTimer=undefined;liveLast=Date.now();try{settleLive();}catch{}},Math.max(50,1200-(Date.now()-liveLast)));liveTimer.unref?.();
}
function settleLive(){
  const settings=remoteSettings(),now=Date.now(),writing=new Set<string>();let changed=false;
  if(settings.enabled&&settings.topics&&settings.owner){
    const threads=new Map(store.all<TopicRecord>('remote-topic').filter(topic=>topic.status==='ready'&&topic.threadId).map(topic=>[topic.id,topic.threadId!]));
    for(const status of ['dispatching','running','waiting','stopping'])for(const turn of store.where<Turn>('turn','status',status)){
      // The reply itself, never a message that waits to be read by it.
      if(turn.parentTurnId||turn.automatic||turn.answeredIn||turn.delivery==='sent')continue;
      const thread=threads.get(turn.chatId),joined=readIn(turn);if(!thread||!turn.remote&&!joined.length)continue;
      // What it has written since the last text from Telegram it read: that is the answer he is waiting for.
      // Agents at work for the chat lead the draft as one line, so a quiet stretch of the reply is not read as a stop.
      const agents=store.where<Turn>('turn','chatId',turn.chatId).filter(row=>row.automatic?.kind==='agent'&&(row.status==='running'||row.status==='waiting')).length;
      const start=joined.reduce((max,row)=>Math.max(max,row.readAt?.text||0),0),written=draftText(turn.text.slice(start)),text=agents?(agents===1?'1 agent':agents+' agents')+' running'+(written?'\n\n'+written:''):written,draft=draftId(turn.id+':'+joined.length),old=liveFrames.get(turn.chatId);
      writing.add(turn.chatId);
      if(old&&!old.done&&old.draft_id===draft&&old.text===text&&now-old.at<20000)continue;
      liveFrames.set(turn.chatId,{n:++liveSeq,chat_id:settings.owner,thread_id:thread,draft_id:draft,text,stop:'gh:stop:'+turn.chatId,...(agents?{agents:'gh:agents:'+turn.chatId}:{}),at:now});changed=true;
    }
  }
  for(const [chatId,frame] of liveFrames)if(!writing.has(chatId)){
    if(!frame.done){liveFrames.set(chatId,{...frame,n:++liveSeq,text:'',done:true,at:now});changed=true;}
    else if(now-frame.at>60000)liveFrames.delete(chatId);
  }
  if(changed)remoteChannel?.notify();
  if(writing.size)remoteLiveSoon();
}
// A button under one of the app's messages, or Telegram's own Stop on a draft. The gate hands over only the owner's.
export async function remoteEvent(value:unknown):Promise<{text?:string}>{
  const event=readEvent(value);if(!event||!remoteSettings().enabled)return {};
  if(event.type==='stopped'){
    const chatId=[...liveFrames].find(([,frame])=>frame.draft_id===event.draft_id&&!frame.done)?.[0]||(event.thread_id?remoteTopicChat(event.thread_id)?.id:undefined);
    if(chatId)await handlers.stop({chatId});
    return {};
  }
  const [,action,arg]=/^gh:(\w+):?(.*)$/.exec(event.data)||[],chat=arg?store.find<Chat>('chat',arg):undefined;
  // A chat gets its thread with its first message, so "New chat" says how to start one.
  if(action==='new')return {text:'Type your first message here. It starts a new chat.'};
  if(action==='stop'&&chat){await handlers.stop({chatId:chat.id});return {text:'Stopped.'};}
  if(action==='drop'&&chat){const dropped=await dropHeld(chat.id);return {text:dropped?plural(dropped,'message')+' dropped.':'Not carrying on.'};}
  // "Stop the agents": each agent at work for the chat is stopped as its stop square in the app does; the reply goes on.
  if(action==='agents'&&chat){
    const turns=['running','waiting'].flatMap(status=>store.where<Turn>('turn','status',status));let stopped=0;
    for(const agent of activeAgents({chats:store.all<Chat>('chat'),jobChats:[],turns,approvals:store.all<Approval>('approval'),background:[...(background?.rows()||[]),...(native?.rows()||[])]},chat.id))if(agent.stopId&&!agent.stopping)try{await handlers.backgroundStop({id:agent.stopId});stopped++;}catch{}
    return {text:stopped?plural(stopped,'agent')+' stopped.':'No agent is running.'};
  }
  // Approve and Deny under an approval (Settings, Remote, "Approve with a button"). The press is bound to the
  // approval shown, as a code is: a changed or answered approval refuses it.
  if(action==='ok'||action==='no'){
    const shown=remoteShown(),gone={text:'That approval is no longer waiting.'};
    if(shown?.kind!=='approval'||!arg||!shown.digest.startsWith(arg))return gone;
    const approval=store.all<Approval>('approval').find(row=>row.id===shown.approvalId);
    if(!approval||approval.status!=='pending'){store.remove('settings','remote-shown');return gone;}
    if(action==='ok'&&remoteSettings().approveBy!=='button')return {text:'Reply to the message with the code from your authenticator.'};
    if(bindingDigest(remoteBinding(approval))!==shown.digest){store.remove('settings','remote-shown');emit();return {text:'The approval changed. It is shown again.'};}
    store.remove('settings','remote-shown');
    try{await handlers.approve({id:approval.id,choice:action==='ok'?'once':'deny',...(action==='ok'?{expectedRemote:{digest:shown.digest,epoch:remoteEpoch}}:{})});}finally{emit();}
    // The message loses its buttons and keeps what he chose.
    const asked=shown.seq?store.find<OutRecord>('remote-out',String(shown.seq)):undefined;
    if(asked&&shown.messageId){enqueueRemote(store,asked.chat_id,asked.text+'\n\nYou '+(action==='ok'?'approved':'denied')+' · '+resetClock(Date.now()),undefined,false,{op:'edit',message_id:shown.messageId});remoteChannel?.notify();}
    return {text:action==='ok'?'Approved.':'Denied.'};
  }
  return {text:'That button is no longer in use.'};
}
// Whether a message of this kind arrives with sound now (remote.ts `sounds`): never while he is at the PC, which
// is read from how long it has had no key press or mouse move. A test copy is always away, so tests see the rule.
function loud(kind:'ended'|'needs'){
  let idle=AWAY_SECONDS;
  if(!namespace.startsWith('Trismegistus/Test/'))try{idle=powerMonitor.getSystemIdleTime();}catch{}
  return sounds(kind,idle);
}
// A card in a chat's thread, or in the bot chat's main view when no chat is given.
function remoteCard(id:string,card:{text:string;keys?:Key[][]},chatId?:string,more:OutPlace={},final=false){
  const owner=remoteSettings().owner;if(!owner)return false;
  const changed=setCard(store,owner,id,{text:backend.scrubber.text(card.text),keys:card.keys},{...(chatId?{topicChat:chatId}:{}),...more},final);if(changed)remoteChannel?.notify();return changed;
}
// Held by the usage limit (Koan 2026-11-19, version 3 of the Telegram mockup): a chat whose messages or work a
// limit holds says so in its thread, once, and keeps that card current: when the limit resets and what carries on
// then. Before, a text held by the limit got "Sent to ..." and no other word.
const heldUntil=new Map<string,number>();
const plural=(count:number,word:string)=>count+' '+word+(count===1?'':'s');
function heldMessages(chatId:string){return store.where<Turn>('turn','chatId',chatId).filter(turn=>turn.status==='queued'&&!turn.parentTurnId&&!turn.automatic);}
// The chats the usage limit holds: until when, how many messages of his wait, how many agents it stopped.
function chatHolds(now=Date.now()){
  const held=new Map<string,{at:number;messages:number;agents:number;remote:boolean}>();
  for(const turn of store.where<Turn>('turn','status','queued'))if(turn.resume&&turn.resume.at>now&&!turn.parentTurnId&&!turn.automatic&&!held.has(turn.chatId)){
    const waiting=heldMessages(turn.chatId);held.set(turn.chatId,{at:Math.max(...waiting.map(row=>row.resume?.at||0)),messages:waiting.length,agents:0,remote:waiting.some(row=>!!row.remote)});
  }
  for(const row of limitCarries())if(row.at>now){const entry=held.get(row.id);held.set(row.id,{at:Math.max(entry?.at||0,row.at),messages:entry?.messages||0,agents:row.agents,remote:!!entry?.remote});}
  return held;
}
function settleHolds(){
  const settings=remoteSettings();if(!settings.enabled||!settings.topics||!settings.owner)return;
  const now=Date.now(),held=chatHolds(now);
  const topics=new Set(store.all<TopicRecord>('remote-topic').filter(topic=>topic.status!=='failed'&&topic.status!=='deleting').map(topic=>topic.id));
  for(const [chatId,entry] of held){
    if(!topics.has(chatId))continue;
    const what=entry.agents&&entry.messages?'The '+plural(entry.agents,'agent')+' and your '+plural(entry.messages,'message')+' carry on by themselves then.':entry.agents?'The '+plural(entry.agents,'agent')+' carr'+(entry.agents===1?'ies':'y')+' on by '+(entry.agents===1?'itself':'themselves')+' then.':entry.messages?'Your '+plural(entry.messages,'message')+' go'+(entry.messages===1?'es':'')+' in by '+(entry.messages===1?'itself':'themselves')+' then.':'The work carries on by itself then.';
    heldUntil.set(chatId,entry.at);
    remoteCard('hold:'+chatId,{text:'⏸ Stopped by the usage limit\nResets at '+resetClock(entry.at,now)+'.\n'+what,keys:[[{text:'Don’t carry on',data:'gh:drop:'+chatId,style:'danger'}]]},chatId,entry.remote&&loud('needs')?{notify:true}:{});
  }
  // A hold that is over says so on its card and loses its button.
  for(const card of store.all<CardRecord>('remote-card'))if(card.id.startsWith('hold:')&&!held.has(card.id.slice(5))){
    const chatId=card.id.slice(5),at=heldUntil.get(chatId);heldUntil.delete(chatId);
    remoteCard(card.id,{text:at&&now>=at?'The limit reset at '+resetClock(at,now)+'. Carrying on.':'No longer held by the limit.'},chatId,{},true);
  }
}
// "Don't carry on": the messages that wait in the chat are dropped, newest first, and so is the carry-on.
async function dropHeld(chatId:string){
  let dropped=0;
  for(const turn of heldMessages(chatId).sort((a,b)=>b.created-a.created))try{await handlers.cancelQueued({id:turn.id});dropped++;if(turn.remote)remoteMark(remoteMessageId(turn),'');}catch{}
  dropLimitCarry(chatId);heldUntil.delete(chatId);
  remoteCard('hold:'+chatId,{text:'Not carrying on.'+(dropped?' '+plural(dropped,'message')+' dropped.':'')},chatId,{},true);
  emit();return dropped;
}
const ENDED=['completed','partial','failed','stopped','interrupted'];
// The Telegram message a remote turn came from: its id is the tail of the turn's id (remoteTurnId).
export function remoteMessageId(turn:Pick<Turn,'id'>){return /^telegram-\d+-(\d+)$/.exec(turn.id)?.[1];}
export function remoteMark(messageId:string|undefined,emoji:string){
  const owner=remoteSettings().owner;if(!owner||!messageId)return;
  enqueueRemote(store,owner,emoji,undefined,false,{op:'react',message_id:messageId});remoteChannel?.notify();
}
// The messages from Telegram that a reply read while it was being written.
const readIn=(owner:Turn)=>store.where<Turn>('turn','chatId',owner.chatId).filter(row=>row.answeredIn===owner.id&&row.id!==owner.id&&!!row.remote);
// Desktop work in a chat with a thread: the message and its final reply, once. What the reply wrote after it read a
// message from Telegram is left out here: that part goes out as the answer to that message (settleRemote).
function copyDesktopTurn(turn:Turn){
  const owner=remoteSettings().owner,copied=store.all<any>('settings').find(row=>row.id==='remote-copied')?.ids as string[]|undefined;
  if(!owner||copied?.includes(turn.id))return false;
  const models=turn.jobs?.length?turn.jobs.map(id=>store.get<Turn>('turn',id)).filter(job=>!job.automatic):[turn],joined=readIn(turn);
  const text='🖥 '+clip(turn.prompt.trim(),600)+'\n\n'+models.map(job=>replyFor(job===turn&&joined.length?{...job,text:replyShare(turn,turn.id,joined)||'…'}:job,modelLabel(job.model,claude.models))).join('\n\n');
  // A copy arrives without sound while he is at the PC, where he has just read it; work that ends after he has
  // left it does sound.
  enqueueRemote(store,owner,backend.scrubber.text(text),undefined,false,{topicChat:turn.chatId,notify:loud('ended')});
  store.put('settings',{id:'remote-copied',ids:[...(copied||[]).slice(-49),turn.id]});
  return true;
}
// The reply to each finished remote turn, sent once, and the mark on his message; called in emit(), the way
// settleParallel works. A message Claude read in the middle of another reply is answered by its share of that reply,
// after the message that reply belongs to.
export function settleRemote(){
  settleTopicsSoon();
  settleApprovals();
  remoteLiveSoon();
  try{settleHolds();}catch{}
  const reply=(turn:Turn)=>{
    if(!turn.remote||turn.remote.replied)return;
    const owner=turn.answeredIn&&turn.answeredIn!==turn.id?store.find<Turn>('turn',turn.answeredIn):undefined;
    const models=turn.jobs?.length?turn.jobs.map(id=>store.get<Turn>('turn',id)).filter(job=>!job.automatic):[turn],joined=readIn(owner||turn);
    // Its own words, when another reply answered it or its reply was shared with messages read later.
    const share=owner?replyShare(owner,turn.id,joined):joined.length?replyShare(turn,turn.id,joined):null,label=(row:Turn)=>modelLabel(row.model,claude.models);
    const text=share===null?models.map(job=>replyFor(job,label(job))).join('\n\n'):turn.status!=='completed'&&turn.status!=='partial'?replyFor(turn,label(turn)):share?share+'\n\n'+label(owner||turn):'';
    // An empty share sends nothing: the answer is in the message beside it, and the mark says it is answered.
    if(text)enqueueRemoteReply(store,turn.id,backend.scrubber.text(text+(turn.remote.fallback?'\nThe picker was unsure; an available model answered.':'')),loud('ended'),remoteSettings().topics);
    else store.update<Turn>('turn',turn.id,{remote:{...turn.remote,replied:true}});
    remoteMark(remoteMessageId(turn),markFor(turn.status));remoteChannel?.notify();
    if(turn.status!=='completed')remoteAlert('Remote task '+(turn.status==='stopped'?'stopped':'failed'),turn.error||turn.prompt);
  };
  for(const turn of store.turnsWith<Turn>('remote'))if(turn.remote&&!turn.remote.replied&&!turn.parentTurnId&&!turn.automatic&&ENDED.includes(turn.status)){
    const owner=turn.answeredIn&&turn.answeredIn!==turn.id?store.find<Turn>('turn',turn.answeredIn):undefined;
    if(owner){
      if(!ENDED.includes(owner.status))continue;                    // its answer is still being written
      if(owner.remote)reply(owner);else if(store.all<TopicRecord>('remote-topic').some(topic=>topic.id===owner.chatId&&(topic.status==='ready'||topic.status==='pending'||topic.status==='creating')))copyDesktopTurn(owner);
    }
    reply(store.get<Turn>('turn',turn.id));
  }
}
export function remoteRow(){return store.all<any>('settings').find(row=>row.id==='remote');}
export function remoteSettings(){return readRemote(remoteRow());}
export function remoteSave(patch:any){store.put('settings',{...remoteRow(),id:'remote',...patch});}
export function featureInstalled(feature:'telegram'|'speech'|'speech-gpu'|'voices'){
  const runtime=pluginRuntime() as any,pins=featureWheels.packages as Record<string,{version:string}>;
  return !!runtime?.features?.includes(feature)&&featureWheels.features[feature].every(name=>runtime.packages?.some((pkg:any)=>pkg.name.toLowerCase().replace(/[-_.]+/g,'-')===name&&pkg.version===pins[name].version));
}
export function telegramInstalled(){return featureInstalled('telegram');}
export function gatewayHome(){return path.join(data,'hermes-gateway');}
export function launchGateway():ChildProcess{
  const uncertain=recoverRemoteOutbox(store);if(uncertain.length)remoteAlert('Remote delivery unconfirmed',uncertain.length+' outgoing messages need review; none will be sent again automatically.');
  // A thread whose making a restart cut short is made again (its row is no longer on its way), and a thread whose
  // removal was cut short is forgotten. Old settled rows go.
  const moving=new Set(store.all<OutRecord>('remote-out').filter(row=>row.status==='pending').map(row=>row.op==='topic'?row.topicChat:row.op==='delete'?row.thread_id:undefined));
  for(const topic of store.all<TopicRecord>('remote-topic')){
    if(topic.status==='creating'&&!moving.has(topic.id))store.update<TopicRecord>('remote-topic',topic.id,{status:'failed',retryAt:0});
    if(topic.status==='deleting'&&!moving.has(topic.threadId))store.remove('remote-topic',topic.id);
  }
  pruneRemoteOutbox(store);
  const home=gatewayHome(),child=spawn(backend.python,[path.join(root,'backend','host.py')],{windowsHide:true,stdio:'pipe',env:{...backend.environment(),HERMES_HOME:home,HERMES_SHARED_AUTH_DIR:path.join(home,'shared')}});
  child.stdin.on('error',()=>{});child.stdout.on('data',()=>{});
  // The open stdin is the lease: main's end closing ends the gateway. The bot token never leaves the vault here.
  child.stdin.write(JSON.stringify({operation:'gateway',credential_namespace:namespace,owner:remoteSettings().owner,channel:remoteChannel!.rotate(),runtime:pluginRuntime()})+'\n');
  return child;
}
