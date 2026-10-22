import {utilityProcess,type UtilityProcess} from 'electron';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export interface TerminalInfo {id:string;chatId:string;title:string;exit:number|null;}
type Session=TerminalInfo & {ready:boolean;worker:UtilityProcess;owner:ChildProcessWithoutNullStreams;buffer:string;offset:number;};
const maxBuffer=1024*1024;
export class Terminals {
  private sessions=new Map<string,Session>();
  constructor(private environment:()=>NodeJS.ProcessEnv,private python:string,private appRoot:string){}
  get count(){return this.sessions.size;}
  has(chatId:string){return [...this.sessions.values()].some(item=>item.chatId===chatId);}
  list(chatId:string):TerminalInfo[]{return [...this.sessions.values()].filter(item=>item.ready&&item.chatId===chatId).map(({id,chatId,title,exit})=>({id,chatId,title,exit}));}
  private owned(chatId:string,id:string){const item=this.sessions.get(id);if(!item||item.chatId!==chatId)throw Error('This terminal belongs to another chat or has closed.');return item;}
  async open(chatId:string,directory:string){
    if(this.sessions.size>=16)throw Error('Close a terminal before opening another.');
    if(!fs.statSync(directory).isDirectory())throw Error('Choose an existing working folder.');
    // Same Windows shell preference and ConPTY/xterm stack as Hermes Desktop.
    const system=process.env.SystemRoot||'C:\\Windows';
    const shell=[path.join(process.env.ProgramFiles||'C:\\Program Files','PowerShell','7','pwsh.exe'),path.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe')].find(file=>fs.existsSync(file));
    if(!shell)throw Error('PowerShell is unavailable.');
    const env=this.environment();delete env.HERMES_HOME;delete env.HERMES_GATEWAY_LOCK_DIR;
    // Start the Job owner first, then an idle utility worker. No shell exists
    // until the owner has bound that exact worker to its kill-on-close Job.
    const owner=spawn(this.python,[path.join(this.appRoot,'backend','terminal_owner.py')],{windowsHide:true,stdio:'pipe',env:this.environment()});
    owner.stdin.on('error',()=>{});owner.stderr.on('data',()=>{});
    const worker=utilityProcess.fork(path.join(__dirname,'terminal-worker.cjs'),[],{env,stdio:'pipe',serviceName:'Ghidorah terminal'});
    worker.stdout?.on('data',()=>{});worker.stderr?.on('data',()=>{});
    const session:Session={id:randomUUID(),chatId,title:'PowerShell',exit:null,ready:false,worker,owner,buffer:'',offset:0};this.sessions.set(session.id,session);
    worker.on('message',message=>{if(message.type==='data'){session.buffer+=message.text;session.offset+=message.text.length;if(session.buffer.length>maxBuffer)session.buffer=session.buffer.slice(-maxBuffer);}if(message.type==='exit')session.exit=message.exitCode;});
    worker.once('exit',code=>{session.exit??=code;owner.stdin.end();});
    owner.once('exit',()=>{session.exit??=1;worker.kill();});
    try{
      await new Promise<void>((resolve,reject)=>{
        const lines=createInterface({input:owner.stdout});const timer=setTimeout(()=>finish(Error('Terminal supervision timed out.')),15000);
        const finish=(error?:Error)=>{clearTimeout(timer);lines.close();worker.off('message',ready);worker.off('exit',failed);owner.off('exit',failed);owner.off('error',failed);error?reject(error):resolve();};
        const failed=()=>finish(Error('Terminal supervision failed.'));
        const ready=(message:any)=>{if(message.type==='started')finish();if(message.type==='error')failed();};
        worker.on('message',ready);worker.once('exit',failed);owner.once('exit',failed);owner.once('error',failed);
        lines.once('line',line=>{try{if(JSON.parse(line).ready!==true)throw Error();worker.postMessage({type:'start',shell,directory,env:{...env,TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'Ghidorah'}});}catch{failed();}});
        worker.once('spawn',()=>owner.stdin.write(JSON.stringify({pid:worker.pid,parent:process.pid})+'\n'));
      });
      session.ready=true;return {id:session.id,chatId,title:session.title,exit:null};
    }catch(error){owner.stdin.end();worker.kill();this.sessions.delete(session.id);throw error;}
  }
  read(chatId:string,id:string,after:unknown){
    if(!Number.isSafeInteger(after)||(after as number)<0)throw Error('Invalid terminal position.');
    const session=this.owned(chatId,id),start=session.offset-session.buffer.length;
    return {data:session.buffer.slice(Math.max(0,(after as number)-start)),offset:session.offset,reset:(after as number)<start,exit:session.exit};
  }
  write(chatId:string,id:string,data:unknown){if(typeof data!=='string'||data.length>65536)throw Error('Terminal input is too large.');const item=this.owned(chatId,id);if(item.exit!==null)throw Error('This terminal has exited.');item.worker.postMessage({type:'write',text:data});}
  resize(chatId:string,id:string,cols:number,rows:number){if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||cols>500||rows<2||rows>300)throw Error('Invalid terminal size.');const item=this.owned(chatId,id);if(item.exit===null)item.worker.postMessage({type:'resize',cols,rows});}
  close(chatId:string,id:string){const item=this.owned(chatId,id);item.owner.stdin.end();this.sessions.delete(id);}
  dispose(){for(const item of [...this.sessions.values()]){try{this.close(item.chatId,item.id);}catch{}}}
}
