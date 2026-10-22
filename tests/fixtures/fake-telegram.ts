// A fake Telegram Bot API on 127.0.0.1 for the Remote tests: getMe, getUpdates (a long poll over queued updates),
// sendMessage (recorded), and ok for every other method the adapter calls while it connects.
import {createServer} from 'node:http';

export async function fakeTelegram(){
 const sent:any[]=[],queue:any[]=[],calls:string[]=[];let nextUpdate=1,nextMessage=1000,wake:(()=>void)[]=[];
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
   const offset=Number(params.offset||0),pending=()=>queue.filter(update=>update.update_id>=offset);
   if(!pending().length)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,Math.min(Number(params.timeout||0),10)*1000);wake.push(()=>{clearTimeout(timer);resolve();});});
   return reply(pending());
  }
  if(method==='sendmessage'){
   // Telegram returns rendered text. Retain the wire text separately for protocol assertions.
   const text=params.parse_mode==='MarkdownV2'?String(params.text).replace(/\\([_\[\]()~`>#+\-=|{}.!*\\])/g,'$1'):params.text;
   const message={message_id:nextMessage++,date:Math.floor(Date.now()/1000),chat:{id:Number(params.chat_id),type:'private'},text};
   sent.push({...params,text,wire_text:params.text,message_id:message.message_id});return reply(message);
  }
  return reply(true);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 const port=(server.address() as any).port;
 return {
  baseUrl:`http://127.0.0.1:${port}/bot`,sent,calls,
  // A direct message from user `from` (the owner unless the test says otherwise).
  message(from:number,text:string,chat=from,replyTo?:number){const id=nextMessage++;queue.push({update_id:nextUpdate++,message:{message_id:id,date:Math.floor(Date.now()/1000),chat:{id:chat,type:chat===from?'private':'group',first_name:'Tester'},from:{id:from,is_bot:false,first_name:'Tester'},text,...(replyTo?{reply_to_message:{message_id:replyTo,date:Math.floor(Date.now()/1000),chat:{id:chat,type:'private'},from:{id:777,is_bot:true,first_name:'Test bot'},text:sent.find(row=>row.message_id===replyTo)?.text||''}}:{})}});for(const resolve of wake.splice(0))resolve();return id;},
  // The same delivery again, as Telegram does after a lost acknowledgement.
  repeat(){const last=queue.at(-1);queue.push({...last,update_id:nextUpdate++});for(const resolve of wake.splice(0))resolve();},
  close(){server.closeAllConnections();server.close();},
 };
}
