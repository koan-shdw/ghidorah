import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import path from 'node:path';
import type {Backend} from './backend';
export class McpOwner {
  private child:ChildProcessWithoutNullStreams|null=null;
  private starting:Promise<void>|null=null;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  private logins=new Map<string,{server:Server;redirectUri:string;open:(url:string)=>Promise<void>}>();
  constructor(private backend:Backend,private changed:(stopped?:boolean)=>void){}
  private start(){
    if(this.starting)return this.starting;
    this.starting=new Promise<void>((resolve,reject)=>{
      const child=this.child=spawn(this.backend.python,[path.join(this.backend.appRoot,'backend','claude_worker.py')],{cwd:this.backend.appRoot,env:this.backend.environment(),windowsHide:true,stdio:'pipe'});
      const lines=createInterface({input:child.stdout});let ready=false;
      const timeout=setTimeout(()=>{reject(Error('MCP service did not start.'));child.stdin.end();},15000);
      child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
      lines.on('line',line=>{
        let message:any;try{message=JSON.parse(line);}catch{return;}
        if(message.event==='ready'){ready=true;clearTimeout(timeout);resolve();}
        else if(message.event==='changed')this.changed();
        else if(message.event==='authorization')void this.authorize(message.id,message.url);
        else if(typeof message.request==='string'){
          const pending=this.pending.get(message.request);if(!pending)return;
          this.pending.delete(message.request);
          if(message.error)pending.reject(Error(this.backend.scrubber.text(message.error)));else pending.resolve(this.backend.scrubber.value(message.result));
        }
      });
      child.once('error',error=>reject(error));
      child.once('close',()=>{
        clearTimeout(timeout);lines.close();if(this.child!==child)return;
        this.child=null;this.starting=null;
        const error=Error('MCP service stopped. Check any uncertain tool outcome before retrying.');
        if(!ready)reject(error);
        for(const request of this.pending.values())request.reject(error);this.pending.clear();
        for(const login of this.logins.values())login.server.close();this.logins.clear();this.changed(true);
      });
      child.stdin.write(JSON.stringify({executable:this.backend.python,args:[path.join(this.backend.appRoot,'backend','mcp_worker.py')],cwd:this.backend.appRoot})+'\n');
      child.stdin.write(JSON.stringify({root:path.join(this.backend.dataRoot,'hermes'),namespace:this.backend.namespace})+'\n');
    });
    return this.starting;
  }
  async request(operation:string,args:any={},signal?:AbortSignal){
    if(signal?.aborted)throw Error('Cancelled.');
    await this.start();if(signal?.aborted)throw Error('Cancelled.');
    const child=this.child;
    if(!child||child.stdin.destroyed||child.stdin.writableEnded)throw Error('MCP service stopped. Try connecting again.');
    const request=randomUUID();
    if(operation==='add'){
      for(const values of [args.config?.headers,args.config?.env])for(const value of Object.values(values||{}))if(typeof value==='string')this.backend.scrubber.register(value);
      if(typeof args.config?.oauth?.client_secret==='string')this.backend.scrubber.register(args.config.oauth.client_secret);
      if(typeof args.config?.url==='string')try{const url=new URL(args.config.url);if(url.search){this.backend.scrubber.register(url.href);for(const value of url.searchParams.values())this.backend.scrubber.register(value);}}catch{}
    }
    return new Promise<any>((resolve,reject)=>{
      const abort=()=>{if(!child.stdin.destroyed&&!child.stdin.writableEnded)child.stdin.write(JSON.stringify({operation:'cancel',request})+'\n');this.pending.delete(request);finish();reject(Error('Cancelled. Check any uncertain tool outcome before retrying.'));};
      const timeout=setTimeout(abort,operation==='login'?320000:operation==='call'?310000:45000);
      const finish=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);};
      this.pending.set(request,{resolve:value=>{finish();resolve(value);},reject:error=>{finish();reject(error);}});
      signal?.addEventListener('abort',abort,{once:true});
      child.stdin.write(JSON.stringify({request,operation,args})+'\n',error=>{if(error){const pending=this.pending.get(request);this.pending.delete(request);pending?.reject(Error('MCP service stopped. Check any uncertain tool outcome before retrying.'));}});
    });
  }
  private async authorize(id:string,url:string){
    const login=this.logins.get(id);if(!login)return;
    try{
      const parsed=new URL(url);
      if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.searchParams.get('redirect_uri')!==login.redirectUri)throw Error('Invalid sign-in address.');
      await login.open(url);
    }catch{await this.request('cancelLogin',{id}).catch(()=>{});}
  }
  async login(id:string,open:(url:string)=>Promise<void>,signal?:AbortSignal){
    if(this.logins.has(id))throw Error('Sign-in is already open.');
    const callbackPath='/callback/'+randomBytes(24).toString('hex');
    const server=createServer((request,response)=>{
      const login=this.logins.get(id);
      if(!login||request.method!=='GET'||request.headers.host!==new URL(login.redirectUri).host){response.writeHead(404).end();return;}
      const url=new URL(request.url||'/',login.redirectUri);
      if(url.pathname!==callbackPath){response.writeHead(404).end();return;}
      void this.request('callback',{id,code:url.searchParams.get('code'),state:url.searchParams.get('state'),error:url.searchParams.get('error'),iss:url.searchParams.get('iss')}).then(()=>{
        response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}).end('Sign-in received. Return to Ghidorah.');
      },()=>{response.writeHead(400,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end('This sign-in callback was refused. Return to Ghidorah.');});
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
    const address=server.address();if(!address||typeof address==='string'){server.close();throw Error('Could not start sign-in callback.');}
    const redirectUri=`http://127.0.0.1:${address.port}${callbackPath}`;this.logins.set(id,{server,redirectUri,open});
    try{return await this.request('login',{id,redirectUri},signal);}finally{server.close();this.logins.delete(id);}
  }
  async stop(){
    for(const login of this.logins.values())login.server.close();
    const child=this.child;if(!child)return;
    // Closing the private input closes the Windows job and all descendants.
    await new Promise<void>(resolve=>{child.once('close',()=>resolve());child.stdin.end();});
  }
}
