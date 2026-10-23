// Test stand-in for "cua-driver mcp": a minimal MCP server over stdio. click at x=999 takes 3 s, so a test can see
// the screen control bar while it runs; x=998 takes 30 s, so a Stop always lands mid-click.
import {createInterface} from 'node:readline';
const tools=['click','get_window_state','get_desktop_state','list_apps','kill_app','clipboard_read'].map(name=>({name,description:'fake '+name,inputSchema:{type:'object',properties:{pid:{type:'integer'},x:{type:'number'},y:{type:'number'}}}}));
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line',async line=>{
 let message;try{message=JSON.parse(line);}catch{return;}
 if(message.id===undefined)return;
 if(message.method==='initialize')return reply(message.id,{protocolVersion:message.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fake-cua',version:'0'}});
 if(message.method==='tools/list')return reply(message.id,{tools});
 if(message.method==='tools/call'){
  const {name,arguments:args}=message.params||{};
  if(name==='click'&&[998,999].includes(args?.x))await new Promise(resolve=>setTimeout(resolve,args.x===998?30000:3000));
  return reply(message.id,{content:[{type:'text',text:'fake '+name+' done'}]});
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported'}})+'\n');
});
