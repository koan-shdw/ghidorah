import {spawn,execFile, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import {createInterface} from 'node:readline';
import {JsonRpcGatewayClient} from './upstream/json-rpc-gateway';
import {waitForDashboardPort} from './upstream/backend-ready';
import {SecretScrubber} from './redaction';

export const PYTHON=path.resolve('runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe');
const execute=promisify(execFile);
// Helper steps that read their request line and keep stdin open for a cancel.
const reviewOperations=new Set(['plugin_review','plugin_convert','skills_browse','skill_review','plugin_runtime_prepare','speech_model_install','speech_check','transcribe','voice_speech','voice_helper','wake_model_install','web_research','app_watch','workspace_git_action','document_render','document_preview','image_generate','chat_export']);
export class Backend {
  rpc=new JsonRpcGatewayClient({socketFactory:(url:string)=>new WebSocket(url) as any});
  child:ChildProcessWithoutNullStreams|null=null;
  scrubber=new SecretScrubber();
  token='';port=0;status='stopped';generation=randomUUID();stopping=false;
  loginChild:ChildProcessWithoutNullStreams|null=null;loginProvider:'codex'|'grok'|'minimax'|'openrouter'|'nous'|null=null;
  providerUrls:Record<string,string>={};
  // Chrome and computer use (4e): extra toolsets and their programs' variables, set by main before start.
  toolsets:string[]=[];toolEnv:Record<string,string>={};
  providerAccess?:{url:string;token:string};
  get python(){return path.join(this.appRoot,'runtime','python','cpython-3.12.10-windows-x86_64-none','python.exe');}
  constructor(public appRoot:string, public dataRoot:string,public namespace:string,public changed:()=>void){
    this.rpc.onState(state=>{if(['closed','error'].includes(state)&&this.status==='ready'&&!this.stopping){this.status='failed';this.changed();void this.stop().then(()=>{this.status='failed';this.changed();});}});
  }
  environment() {
    const env:NodeJS.ProcessEnv={PSExecutionPolicyPreference:'Bypass'};
    for(const k of ['PATH','SystemRoot','SystemDrive','ProgramData','WINDIR','ComSpec','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']) {const actual=Object.keys(process.env).find(n=>n.toLowerCase()===k.toLowerCase());if(actual)env[k]=process.env[actual];}
    return {...env,...(this.namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_WEB_URL?{TRISMEGISTUS_TEST_WEB_URL:process.env.TRISMEGISTUS_TEST_WEB_URL}:{}),...(this.namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_NOUS_URL?{TRISMEGISTUS_TEST_NOUS_URL:process.env.TRISMEGISTUS_TEST_NOUS_URL}:{}),...(this.namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_MINIMAX_URL?{TRISMEGISTUS_TEST_MINIMAX_URL:process.env.TRISMEGISTUS_TEST_MINIMAX_URL}:{}),...(this.namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_VERTEX_URL?{TRISMEGISTUS_TEST_VERTEX_URL:process.env.TRISMEGISTUS_TEST_VERTEX_URL}:{}),...(this.namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_GROK_URL?{TRISMEGISTUS_TEST_GROK_URL:process.env.TRISMEGISTUS_TEST_GROK_URL}:{}),...(this.namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_API_URLS?{TRISMEGISTUS_TEST_API_URLS:process.env.TRISMEGISTUS_TEST_API_URLS}:{}),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',HERMES_HOME:path.join(this.dataRoot,'hermes'),HERMES_SHARED_AUTH_DIR:path.join(this.dataRoot,'hermes','shared'),HERMES_GATEWAY_LOCK_DIR:path.join(this.dataRoot,'locks'),HERMES_GUEST_ONBOARDING:'0',HERMES_TUI_TOOLSETS:['file','terminal','memory','session_search','todo','clarify','trismegistus_mcp','skills',...this.toolsets].join(','),...(this.namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_CODEX_URL?{TRISMEGISTUS_TEST_CODEX_URL:process.env.TRISMEGISTUS_TEST_CODEX_URL}:{}),...this.toolEnv};
  }
  // Each helper step's limit. The step rejects on its own timer, never waiting for the helper to close: in 1.11 the
  // 30 s kill did not end the wait (TURN-REVIEW part 4).
  hostLimit(operation:string){
    const review=reviewOperations.has(operation);
    return operation==='plugin_runtime_prepare'?660000:operation==='speech_model_install'?3600000:operation==='transcribe'?300000:operation==='workspace_git_action'?180000:operation==='web_research'?45000:review?360000:operation==='context_summary'?105000:operation==='model_discovery'?190000:operation==='worktree'?120000:operation==='codex_status'?65000:30000;
  }
  stopHelper(pid?:number){if(pid)void execute('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true}).catch(()=>{});}
  async host(operation:string,extra:any={},signal?:AbortSignal,limit=this.hostLimit(operation)) {
    if(signal?.aborted)throw Error('Operation cancelled.');
    return new Promise<any>((resolve,reject)=>{
      const child=spawn(this.python,[path.join(this.appRoot,'backend','host.py')],{windowsHide:true,env:this.environment(),stdio:'pipe'});
      child.stdin.on('error',()=>{});
      const reviewOperation=reviewOperations.has(operation);
      let out='',err='',settled=false;
      const finish=(settle:()=>void)=>{if(settled)return;settled=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);settle();};
      const timeout=setTimeout(()=>{finish(()=>reject(Object.assign(Error(`The helper step "${operation}" did not finish within ${Math.round(limit/1000)} s.`),{name:'TimeoutError'})));this.stopHelper(child.pid);},limit);
      // Abort ends the wait at once and kills the helper tree, including uv/pip and any build subprocess.
      const abort=()=>{finish(()=>reject(Error('Operation cancelled.')));this.stopHelper(child.pid);};
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
      child.on('error',error=>finish(()=>reject(error)));child.on('close',code=>finish(()=>{if(code)reject(Error(this.scrubber.text(err)||'Credential operation failed'));else try{resolve(JSON.parse(out.trim()));}catch{reject(Error('Invalid credential response'));}}));
      const request=JSON.stringify({operation,credential_namespace:this.namespace,...extra})+'\n';
      if(reviewOperation)child.stdin.write(request);else child.stdin.end(request);
    });
  }
  startCodexLogin(changed:(event:any)=>void,provider:'codex'|'grok'|'minimax'|'openrouter'|'nous'='codex',region:'global'|'cn'='global'){
    if(this.loginChild)throw Error('Sign-in is already open.');this.loginProvider=provider;
    const child=this.loginChild=spawn(this.python,[path.join(this.appRoot,'backend','host.py')],{windowsHide:true,env:this.environment(),stdio:'pipe'});
    child.stdin.on('error',()=>{});
    const lines=createInterface({input:child.stdout});let finished=false;
    lines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='device'&&(provider==='codex'?event.url==='https://auth.openai.com/codex/device':(()=>{const url=new URL(event.url);return url.protocol==='https:'&&(provider==='nous'?url.hostname==='portal.nousresearch.com':provider==='openrouter'?url.hostname==='openrouter.ai'&&url.pathname==='/auth':provider==='minimax'?(region==='cn'?(url.hostname==='minimaxi.com'||url.hostname.endsWith('.minimaxi.com')):(url.hostname==='minimax.io'||url.hostname.endsWith('.minimax.io'))):['auth.x.ai','accounts.x.ai'].includes(url.hostname))&&!url.username&&!url.password;})())&&typeof event.code==='string')changed(event);else if(['connected','error'].includes(event.type)){finished=true;changed(this.scrubber.value(event));}}catch{}});
    child.stderr.on('data',()=>{});
    child.once('error',()=>{finished=true;changed({type:'error',message:'Could not start sign-in.'});});
    child.once('close',()=>{if(this.loginChild===child){this.loginChild=null;this.loginProvider=null;}lines.close();if(!finished)changed({type:'cancelled'});});
    child.stdin.write(JSON.stringify({operation:provider+'_login',credential_namespace:this.namespace,region})+'\n');
  }
  cancelCodexLogin(provider?:'codex'|'grok'|'minimax'|'openrouter'|'nous'){if(!provider||this.loginProvider===provider)this.loginChild?.stdin.end();}
  async start(key:string|null,plugins:string[]=[],configurations:string[]=[],runtime:unknown=null) {
    if(this.child)return;
    this.status='starting';this.changed();this.stopping=false;this.generation=randomUUID();
    this.token=randomBytes(32).toString('hex');this.scrubber.register(this.token);if(key)this.scrubber.register(key);
    const env={...this.environment(),HERMES_DASHBOARD_SESSION_TOKEN:this.token,HERMES_SERVE_HEADLESS:'1',...(process.env.TRISMEGISTUS_TEST_PROVIDER_URL?{DEEPSEEK_BASE_URL:process.env.TRISMEGISTUS_TEST_PROVIDER_URL}:{})};
    const child=this.child=spawn(this.python,[path.join(this.appRoot,'backend','host.py')],{cwd:this.appRoot,env,windowsHide:true,stdio:'pipe'});
    let tail='';const stdout=this.scrubber.stream(),stderr=this.scrubber.stream();
    child.stdout.on('data',b=>{tail=(tail+stdout(b.toString())).slice(-16000);});
    child.stderr.on('data',b=>{tail=(tail+stderr(b.toString())).slice(-16000);});
    child.once('exit',()=>{if(this.child!==child)return;this.child=null;this.rpc.close();this.status=this.stopping?'stopped':'failed';this.changed();});
    child.stdin.write(JSON.stringify({operation:'serve',credential_namespace:this.namespace,plugins,configurations,runtime,provider_access:this.providerAccess,provider_urls:{deepseek:process.env.TRISMEGISTUS_TEST_PROVIDER_URL||'https://api.deepseek.com/v1','openai-codex':process.env.TRISMEGISTUS_TEST_CODEX_URL||'https://chatgpt.com/backend-api/codex',...this.providerUrls}})+'\n');
    try{
      this.port=await waitForDashboardPort(child,90000,()=>tail,()=>tail) as number;
      const health=await fetch(`http://127.0.0.1:${this.port}/api/health`,{headers:{'X-Hermes-Session-Token':this.token}});if(!health.ok)throw Error('Backend health check failed');
      await this.rpc.connect(`ws://127.0.0.1:${this.port}/api/ws?token=${this.token}`);
      await this.rpc.request('client.capabilities',{server_requests:true});
      this.status='ready';this.changed();
    }catch(error){await this.stop();throw error;}
  }
  async stop(){this.stopping=true;this.rpc.close();const child=this.child;if(child?.pid){try{await execute('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});}catch(error){if(child.exitCode===null)throw error;}}this.child=null;this.status='stopped';this.changed();}
}
