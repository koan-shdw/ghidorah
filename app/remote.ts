// Remote (6a, 6b; F4, F13, SPEC 5.21 H6, 5.22). Telegram reaches the app through Hermes's gateway, run as a
// hidden child in its own Hermes home. Its gate plugin hands the owner's messages to main over this private
// loopback channel; main runs them as ordinary turns and queues replies, approvals and notices for the plugin to
// send. No Electron in this file.
import {createServer,type IncomingMessage} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';

export interface RemoteSettings {enabled:boolean;owner:string;chatId:string|null;paused:boolean}
export function readRemote(row:any):RemoteSettings{
 return {enabled:row?.enabled===true,owner:typeof row?.owner==='string'&&/^[1-9]\d{0,19}$/.test(row.owner)?row.owner:'',chatId:typeof row?.chatId==='string'&&row.chatId?row.chatId:null,paused:row?.paused===true};
}

// An owner's direct message as the gate plugin hands it over. Anything else is refused.
export interface Inbound {message_id:string;chat_id:string;user_id:string;text:string;reply_to_message_id?:string}
export function readInbound(value:any,owner:string):Inbound|null{
 if(!owner||!value||typeof value!=='object')return null;
 const {message_id,chat_id,user_id,text,reply_to_message_id}=value;
 if(typeof message_id!=='string'||!/^\d{1,20}$/.test(message_id)||chat_id!==owner||user_id!==owner||typeof text!=='string'||text.length>8000)return null;
 if(reply_to_message_id!==undefined&&(typeof reply_to_message_id!=='string'||!/^\d{1,20}$/.test(reply_to_message_id)))return null;
 return {message_id,chat_id,user_id,text,...(reply_to_message_id?{reply_to_message_id}:{})};
}

// What a message asks for. A code or Deny answers the approval shown; slash commands are the gate's safe list.
export const COMMANDS:Record<string,string>={help:'this list',whoami:'who the app knows you as',new:'a new chat',stop:'stop the work in this chat',status:'what this chat is doing',approve:'approve with a code: /approve 123456',deny:'refuse the approval shown',pause:'pause or resume remote messages: /pause, /pause off',project:'list chats, or switch: /project 2'};
export type Request={kind:'command';name:string;arg:string}|{kind:'code';code:string}|{kind:'deny';seq?:string}|{kind:'text';text:string};
export function parseRequest(text:string):Request{
 const trimmed=text.trim();
 if(/^\d{6}$/.test(trimmed))return {kind:'code',code:trimmed};
 const deny=/^deny(?:\s+#(\d{1,16}))?$/i.exec(trimmed);
 if(deny)return {kind:'deny',...(deny[1]?{seq:deny[1]}:{})};
 const command=/^\/([A-Za-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
 if(command){
  const name=command[1].toLowerCase(),arg=(command[2]||'').trim();
  if(name==='approve')return /^\d{6}$/.test(arg)?{kind:'code',code:arg}:{kind:'command',name,arg};
  if(name==='deny')return {kind:'deny'};
  return {kind:'command',name,arg};
 }
 return {kind:'text',text:trimmed};
}
// Telegram takes 4,096 characters in a message.
export function clip(text:string,limit=4000){return text.length<=limit?text:text.slice(0,limit-1)+'…';}
// Message ids sent by Telegram become turn ids in the shape submit accepts, so a repeated delivery is one turn.
export function remoteTurnId(owner:string,messageId:string){return 'telegram-'+owner+'-'+messageId;}

// The private channel the gate plugin talks to: POST /inbound, POST /ready, GET /outbox?after=n (held up to 25
// seconds while empty), POST /sent. Each call carries the per-spawn token.
export interface OutRow {seq:number;chat_id:string;text:string;deny?:boolean;approvalId?:string}
export async function gateChannel(handlers:{inbound:(value:any)=>Promise<void>;ready:()=>void;outbox:(after:number)=>OutRow[];sent:(seq:number,ok:boolean,messageId?:string)=>void}){
 let token=randomBytes(32).toString('hex');const waiting=new Set<()=>void>();
 const body=async(request:IncomingMessage)=>{const chunks:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>32768)throw Error('Too large.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'null');};
 const server=createServer(async(request,response)=>{
  if(request.headers.authorization!=='Bearer '+token){response.writeHead(403).end();return;}
  const url=new URL(request.url||'/','http://127.0.0.1');
  const json=(value:unknown)=>response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value));
  try{
   if(request.method==='POST'&&url.pathname==='/inbound'){await handlers.inbound(await body(request));json({ok:true});return;}
   if(request.method==='POST'&&url.pathname==='/ready'){await body(request);handlers.ready();json({ok:true});return;}
   if(request.method==='POST'&&url.pathname==='/sent'){const value=await body(request);if(!Number.isSafeInteger(value?.seq)||value.seq<1||typeof value?.ok!=='boolean'||value.message_id!==undefined&&(typeof value.message_id!=='string'||!/^\d{1,20}$/.test(value.message_id)))throw Error('Invalid.');handlers.sent(value.seq,value.ok,value.message_id);json({ok:true});return;}
   if(request.method==='GET'&&url.pathname==='/outbox'){
    const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw Error('Invalid.');
    let rows=handlers.outbox(after);
    if(!rows.length){await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);waiting.delete(done);response.removeListener('close',done);resolve();},timer=setTimeout(done,25000);waiting.add(done);response.once('close',done);});rows=handlers.outbox(after);}
    json(rows);return;
   }
   response.writeHead(404).end();
  }catch{if(!response.headersSent)response.writeHead(400).end();}
 });
 server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});server.unref();
 const address=server.address();if(!address||typeof address==='string')throw Error('The Remote channel did not start.');
 const url=`http://127.0.0.1:${address.port}/`;
 return {get connection(){return {url,token};},rotate:()=>{token=randomBytes(32).toString('hex');server.closeAllConnections();return {url,token};},notify:()=>{for(const done of [...waiting])done();},close:()=>{for(const done of [...waiting])done();server.closeAllConnections();server.close();}};
}

// The gateway child. An exit nobody asked for restarts it after a pause; three exits within five minutes latch it
// off with the reason, until Remote is turned on again.
export class GatewaySupervisor {
 status:'off'|'starting'|'running'|'failed'='off';message='';
 private child?:ChildProcess;private exits:number[]=[];private timer?:NodeJS.Timeout;private wanted=false;
 constructor(private launch:()=>ChildProcess,private kill:(child:ChildProcess)=>void,private changed:()=>void,private now=()=>Date.now()){}
 get running(){return this.wanted;}
 get pid(){return this.child?.pid;}
 start(){if(this.wanted)return;this.wanted=true;this.exits=[];this.message='';this.spawn();}
 // The gate plugin says so once its Telegram adapter has connected.
 ready(){if(this.wanted&&this.child){this.status='running';this.message='';this.changed();}}
 private spawn(){
  if(!this.wanted)return;
  clearTimeout(this.timer);this.status='starting';this.changed();
  let errors='',child:ChildProcess;
  try{child=this.child=this.launch();}catch(error){this.failed(String(error));return;}
  child.stderr?.on('data',chunk=>{errors=(errors+chunk).slice(-4000);});
  const ended=(error?:Error)=>{
   if(this.child!==child)return;this.child=undefined;
   this.failed(error?String(error):errors);
  };
  child.once('error',ended);child.once('exit',()=>ended());
 }
 private failed(errors:string){
  if(!this.wanted){this.status='off';this.changed();return;}
  const now=this.now();this.exits=[...this.exits.filter(at=>now-at<300000),now];
  const reason=errors.trim().split(/\r?\n/).filter(line=>/Error|error|refused|token|Telegram/.test(line)).at(-1)?.slice(0,300)||'';
  if(this.exits.length>=3){this.wanted=false;this.status='failed';this.message=(reason?reason+' ':'')+'Remote stopped three times in five minutes and stays off.';this.changed();return;}
  this.status='starting';this.message='Restarting the gateway.';this.changed();
  this.timer=setTimeout(()=>this.spawn(),1000*this.exits.length);this.timer.unref?.();
 }
 stop(){this.wanted=false;clearTimeout(this.timer);const child=this.child;this.child=undefined;this.status='off';this.message='';this.changed();if(child)this.kill(child);}
}

// What main lends the desk: its store reads, the dispatcher and the approval handlers. The desk decides what an
// owner's message does; main acts on it.
export interface DeskDeps {
 settings():RemoteSettings;save(patch:Partial<RemoteSettings>):void;
 seen(id:string):boolean;
 done(id:string):void;                      // persist only after handling, never before accepting a turn
 send(text:string,deny?:boolean):void;       // queue a message to the owner
 alert(title:string,body:string):void;       // desktop alert
 chats():{id:string;title:string}[];         // the owner's chats, most recent first
 newChat():Promise<string>;
 submit(id:string,chatId:string,text:string):Promise<void>;
 stop(chatId:string):Promise<void>;
 status(chatId:string):string;
 waiting():'approval'|'question'|null;       // what the message shown to the owner waits for
 code(code:string,replyTo?:string):Promise<string>;
 deny(replyTo?:string,seq?:string):Promise<string>;
 answer(text:string,replyTo?:string):Promise<string>;
}
export class RemoteDesk {
 private serial:Promise<void>=Promise.resolve();
 constructor(private deps:DeskDeps){}
 private target(){const chats=this.deps.chats(),chosen=this.deps.settings().chatId;return chats.find(chat=>chat.id===chosen)||chats[0]||null;}
 receive(value:unknown){const run=this.serial.catch(()=>{}).then(()=>this.handle(value));this.serial=run;return run;}
 private async handle(value:unknown){
  const settings=this.deps.settings(),message=readInbound(value,settings.owner);
  if(!message||!settings.enabled)return;
  const id=remoteTurnId(settings.owner,message.message_id);if(this.deps.seen(id))return;
  await this.dispatch(message,settings);this.deps.done(id);
 }
 private async dispatch(message:Inbound,settings:RemoteSettings){
  const request=parseRequest(message.text),waiting=this.deps.waiting(),chat=this.target(),send=(text:string)=>this.deps.send(text);
  // A code is an authentication step, not a task; it never reaches a chat or a log.
  if(request.kind==='code'){send(waiting==='approval'?await this.deps.code(request.code,message.reply_to_message_id):'No approval is waiting.');return;}
  if(request.kind==='deny'){send(waiting==='approval'?await this.deps.deny(message.reply_to_message_id,request.seq):'No approval is waiting.');return;}
  if(request.kind==='command'){await this.command(request.name,request.arg,chat);return;}
  this.deps.alert('Remote task',request.text.slice(0,140));
  if(settings.paused){send('Remote messages are paused. Send /pause off to resume.');return;}
  if(waiting==='question'){send(await this.deps.answer(request.text,message.reply_to_message_id));return;}
  if(waiting==='approval'){send('Reply with the code for the approval shown, or Deny.');return;}
  if(message.reply_to_message_id){send('That message is no longer waiting for a reply. Send a new message to start a task.');return;}
  if(!chat){send('There is no chat yet. Send /new to start one.');return;}
  try{await this.deps.submit(remoteTurnId(settings.owner,message.message_id),chat.id,request.text);send('Sent to '+chat.title+'.');}
  catch(error){const reason=String(error).replace(/^Error: /,'').slice(0,300);this.deps.alert('Remote task failed',reason);send('Not sent: '+reason);}
 }
 private async command(name:string,arg:string,chat:{id:string;title:string}|null){
  const send=(text:string)=>this.deps.send(text);
  if(name==='help'||name==='start')return send(Object.entries(COMMANDS).map(([command,what])=>'/'+command+': '+what).join('\n'));
  if(name==='whoami')return send('Telegram user '+this.deps.settings().owner+'. Messages go to '+(chat?chat.title:'a new chat')+'.');
  if(name==='new'){const id=await this.deps.newChat();this.deps.save({chatId:id});return send('New chat. Messages go there now.');}
  if(name==='status')return send(chat?chat.title+': '+this.deps.status(chat.id):'There is no chat yet.');
  if(name==='stop'){if(!chat)return send('There is no chat yet.');await this.deps.stop(chat.id);return send('Stopped the work in '+chat.title+'.');}
  if(name==='pause'){const resume=/^off$/i.test(arg);this.deps.save({paused:!resume});return send(resume?'Remote messages resume.':'Remote messages are paused. Send /pause off to resume.');}
  if(name==='approve')return send('Send /approve and the code from your authenticator.');
  if(name==='project'){
   const chats=this.deps.chats().slice(0,10);
   if(!arg)return send(chats.length?chats.map((item,index)=>(index+1)+'. '+item.title+(item.id===chat?.id?' (current)':'')).join('\n')+'\nSend /project and a number to switch.':'There is no chat yet. Send /new to start one.');
   const pick=/^\d{1,2}$/.test(arg)?chats[Number(arg)-1]:undefined;if(!pick)return send('Send /project and a number from the list.');
   this.deps.save({chatId:pick.id});return send('Messages go to '+pick.title+' now.');
  }
  return send('That command is not available from Telegram.');
 }
}

// A chat's state in words, for /status.
export const STATUS:Record<string,string>={queued:'Queued',dispatching:'Starting',running:'Working',waiting:'Waiting for approval',stopping:'Stopping',completed:'Completed','needs-model':'Choosing a model',failed:'Failed',stopped:'Stopped',interrupted:'Interrupted',partial:'Partly done'};
// The reply a finished remote turn sends, named by the model that wrote it.
export function replyFor(turn:{status:string;text?:string|null;error?:string|null},model:string){
 if(turn.status==='completed')return clip((turn.text||'(no text)').trim()+'\n\n'+model);
 if(turn.status==='stopped')return 'Stopped.';
 return clip('Failed: '+(turn.error||turn.status));
}
// Hermes asks before a tool touches the secrets list; from Telegram that is refused, never offered (5.21 H6).
export function secretApproval(params:unknown){const text=JSON.stringify(params||{});return text.includes('protected credentials')||/"secret:[0-9a-f]{8,}/.test(text);}
export function approvalPrompt(description:string){return 'Approval needed:\n'+clip(description.trim(),3600)+'\n\nReply to this message with the code from your authenticator, or tap Deny.';}
