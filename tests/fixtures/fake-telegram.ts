// A fake Telegram Bot API on 127.0.0.1 for the Remote tests: getMe, getUpdates (a long poll over queued updates),
// sendMessage (recorded), topics in the bot chat (createForumTopic, editForumTopic, deleteForumTopic, recorded), the
// marks, edits, pins and drafts the app makes (recorded), and ok for every other method the adapter calls.
import {createServer} from 'node:http';

export async function fakeTelegram(){
 const sent:any[]=[],queue:any[]=[],calls:string[]=[],topics:any[]=[],reactions:any[]=[],edits:any[]=[],pins:any[]=[],drafts:any[]=[],deleted:any[]=[];let nextUpdate=1,nextMessage=1000,nextThread=50,wake:(()=>void)[]=[],last:any;
 const server=createServer(async(request,response)=>{
  const match=/^\/bot([^/]+)\/(\w+)$/.exec((request.url||'').split('?')[0]);
  let body='';for await(const chunk of request)body+=chunk;
  const type=String(request.headers['content-type']||'');
  const params:any=!body?{}:type.includes('json')?JSON.parse(body):Object.fromEntries(new URLSearchParams(body));
  const reply=(result:any)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ok:true,result}));};
  if(!match){response.writeHead(404).end();return;}
  const method=match[2].toLowerCase();calls.push(method);
  if(method==='getme')return reply({id:777,is_bot:true,first_name:'Trismegistus test',username:'trismegistus_test_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false});
  if(method==='getupdates'){
   // As Telegram does: an update is confirmed, and gone, once a later offset is asked for. One that nobody has
   // asked past stays, so a message sent while the app was closed is still there when it starts.
   const offset=Number(params.offset||0);if(offset>0)for(let index=queue.length-1;index>=0;index--)if(queue[index].update_id<offset)queue.splice(index,1);
   const pending=()=>queue.filter(update=>update.update_id>=offset);
   if(!pending().length)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,Math.min(Number(params.timeout||0),10)*1000);wake.push(()=>{clearTimeout(timer);resolve();});});
   return reply(pending());
  }
  if(method==='sendmessage'){
   // Telegram returns rendered text. Retain the wire text separately for protocol assertions.
   const text=params.parse_mode==='MarkdownV2'?String(params.text).replace(/\\([_\[\]()~`>#+\-=|{}.!*\\])/g,'$1'):params.text;
   const message={message_id:nextMessage++,date:Math.floor(Date.now()/1000),chat:{id:Number(params.chat_id),type:'private'},text};
   sent.push({...params,text,wire_text:params.text,message_id:message.message_id});return reply(message);
  }
  if(method==='createforumtopic'){const thread=nextThread++;topics.push({method,...params,message_thread_id:thread});return reply({message_thread_id:thread,name:params.name,icon_color:7322096});}
  if(method==='editforumtopic'||method==='deleteforumtopic'){topics.push({method,...params});return reply(true);}
  // The mark on a message: the emoji, or '' when the mark is taken away.
  if(method==='setmessagereaction'){let emoji='';try{emoji=JSON.parse(params.reaction||'[]')[0]?.emoji||'';}catch{}reactions.push({...params,emoji});return reply(true);}
  if(method==='editmessagetext'){edits.push(params);return reply({message_id:Number(params.message_id),date:Math.floor(Date.now()/1000),chat:{id:Number(params.chat_id),type:'private'},text:params.text});}
  if(method==='pinchatmessage'){pins.push(params);return reply(true);}
  if(method==='sendmessagedraft'){drafts.push(params);return reply(true);}
  if(method==='deletemessage'){deleted.push(params);return reply(true);}
  return reply(true);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 const port=(server.address() as any).port;
 return {
  baseUrl:`http://127.0.0.1:${port}/bot`,sent,calls,topics,reactions,edits,pins,drafts,deleted,
  // A message from the owner inside a topic of the bot chat.
  topicMessage(from:number,thread:number,text:string){const id=nextMessage++;queue.push(last={update_id:nextUpdate++,message:{message_id:id,message_thread_id:thread,is_topic_message:true,date:Math.floor(Date.now()/1000),chat:{id:from,type:'private',first_name:'Tester'},from:{id:from,is_bot:false,first_name:'Tester'},text}});for(const resolve of wake.splice(0))resolve();return id;},
  // A direct message from user `from` (the owner unless the test says otherwise).
  message(from:number,text:string,chat=from,replyTo?:number){const id=nextMessage++;queue.push(last={update_id:nextUpdate++,message:{message_id:id,date:Math.floor(Date.now()/1000),chat:{id:chat,type:chat===from?'private':'group',first_name:'Tester'},from:{id:from,is_bot:false,first_name:'Tester'},text,...(replyTo?{reply_to_message:{message_id:replyTo,date:Math.floor(Date.now()/1000),chat:{id:chat,type:'private'},from:{id:777,is_bot:true,first_name:'Test bot'},text:sent.find(row=>row.message_id===replyTo)?.text||''}}:{})}});for(const resolve of wake.splice(0))resolve();return id;},
  // The same delivery again, as Telegram does after a lost acknowledgement.
  repeat(){queue.push({...last,update_id:nextUpdate++});for(const resolve of wake.splice(0))resolve();},
  close(){server.closeAllConnections();server.close();},
 };
}
