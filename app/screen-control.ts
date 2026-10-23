// Screen control (FEATURE-SPECS 1, TRIS-TODO 4.4). cua-driver runs as a small MCP server ("cua-driver mcp") that
// Tris owns; Claude models reach a chosen set of its tools as mcp__screen__*. Every action that touches an app is
// checked first: Koan approves each app (for this chat, or always), and the whole screen needs its own approval.
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';

const run=promisify(execFile);

// The desktop tools models get. Left out: browser tools (agent-browser drives the browser), clipboard, killing
// processes, recordings, driver settings, installs and updates.
export const screenToolNames=new Set(['list_apps','list_windows','get_accessibility_tree','get_screen_size','get_cursor_position','get_window_state','get_desktop_state','zoom','click','double_click','right_click','drag','scroll','type_text','press_key','hotkey','set_value','invoke_menu','verify_state','launch_app','bring_to_front','set_window_frame','start_session','end_session','move_cursor']);
// Reading which apps and windows exist shows no window contents.
const listings=new Set(['list_apps','list_windows','get_accessibility_tree','get_screen_size','get_cursor_position','start_session','end_session','move_cursor']);

export type ScreenTarget={kind:'none'}|{kind:'screen'}|{kind:'app';pid:number}|{kind:'named';name:string};
// What an action touches: nothing, the whole screen, a running app (by process number) or an app by name.
export function screenTarget(tool:string,args:any):ScreenTarget{
 if(listings.has(tool))return {kind:'none'};
 if(tool==='get_desktop_state')return {kind:'screen'};
 if(tool==='launch_app'){const name=String(args?.name||args?.bundle_id||args?.aumid||String(args?.path||'').split(/[\\/]/).pop()||'').replace(/\.exe$/i,'').trim();return name?{kind:'named',name:appName(name)}:{kind:'screen'};}
 const pid=Number(args?.pid);
 if(Number.isInteger(pid)&&pid>0)return {kind:'app',pid};
 // A zoom without a pid reads a window snapshot this session already took (and was approved for).
 if(tool==='zoom')return {kind:'none'};
 return {kind:'screen'};
}
// "Photoshop.exe" and "photoshop" are the same app to Koan.
export const appName=(name:string)=>{const base=name.replace(/\.exe$/i,'').trim();return base?base[0].toUpperCase()+base.slice(1):'An app';};
export const sameApp=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
// Hermes's computer_use tool: app 'screen' or 'desktop', or no app at all (the frontmost window), is the whole screen.
export function hermesScreenTarget(args:any):ScreenTarget{
 if(['list_apps','list_windows','wait'].includes(String(args?.action||'')))return {kind:'none'};
 const app=String(args?.app||'').trim(),pid=Number(args?.pid);
 if(/^(screen|desktop)$/i.test(app))return {kind:'screen'};
 if(Number.isInteger(pid)&&pid>0)return {kind:'app',pid};
 return app?{kind:'named',name:appName(app)}:{kind:'screen'};
}
// Actions that change something; plan mode allows only looking.
export const screenActions=new Set(['click','double_click','right_click','middle_click','drag','scroll','type_text','type','press_key','key','hotkey','set_value','invoke_menu','launch_app','bring_to_front','focus_app','set_window_frame']);
// A key the model sends that is Esc: the global Esc (Stop) steps aside for it.
export const sendsEscape=(tool:string,args:any)=>(['press_key','hotkey'].includes(tool)||tool==='computer_use'&&args?.action==='key')&&/\besc(ape)?\b/i.test(JSON.stringify(args?.key??args?.keys??args?.text??''));

// The app behind a process number (Windows), cached for the life of the process.
const names=new Map<number,string>();
export async function processName(pid:number){
 if(names.has(pid))return names.get(pid)!;
 const {stdout}=await run('tasklist',['/FI','PID eq '+pid,'/FO','CSV','/NH'],{windowsHide:true,timeout:10000});
 const name=/^"([^"]+)"/.exec(stdout.trim())?.[1];if(!name)throw Error('That app is no longer running.');
 const value=appName(name);names.set(pid,value);return value;
}

// One cua-driver MCP server for the app, started on first use and stopped when screen control is turned off.
export class ScreenDriver{
 private child:ChildProcess|null=null;private ready:Promise<void>|null=null;private next=0;
 private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
 constructor(private command:()=>string|null,private env:Record<string,string>){}
 private start(){
  if(this.ready)return this.ready;
  const command=this.command();if(!command)throw Error('Screen control is off or its program is missing.');
  // Only the environment main hands over (system paths and telemetry off), never the app's own variables.
  const child=spawn(command,['mcp'],{env:this.env,windowsHide:true,stdio:['pipe','pipe','ignore'],shell:/\.(cmd|bat)$/i.test(command)});
  this.child=child;
  createInterface({input:child.stdout!}).on('line',line=>{let message:any;try{message=JSON.parse(line);}catch{return;}const entry=this.pending.get(message?.id);if(!entry)return;this.pending.delete(message.id);message.error?entry.reject(Error(message.error.message||'Screen control failed.')):entry.resolve(message.result);});
  child.once('exit',()=>{for(const entry of this.pending.values())entry.reject(Error('Screen control stopped.'));this.pending.clear();if(this.child===child){this.child=null;this.ready=null;}});
  child.stdin!.on('error',()=>{});
  this.ready=this.send('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Ghidorah',version:'1'}}).then(()=>{child.stdin!.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');});
  this.ready.catch(()=>this.stop());
  return this.ready;
 }
 private send(method:string,params:any,signal?:AbortSignal){
  return new Promise<any>((resolve,reject)=>{
   const id=++this.next;this.pending.set(id,{resolve,reject});
   signal?.addEventListener('abort',()=>{if(this.pending.delete(id))reject(Error('Stopped.'));},{once:true});
   this.child!.stdin!.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
 }
 async request(method:string,params:any,signal?:AbortSignal){await this.start();return this.send(method,params,signal);}
 async tools(signal?:AbortSignal){return ((await this.request('tools/list',{},signal))?.tools||[]).filter((tool:any)=>screenToolNames.has(tool.name));}
 async call(name:string,args:any,signal?:AbortSignal){if(!screenToolNames.has(name))throw Error('That screen tool is not available in Ghidorah.');return this.request('tools/call',{name,arguments:args||{}},signal);}
 stop(){const child=this.child;this.child=null;this.ready=null;child?.kill();}
}

// What every model is told while screen control is on (the risky-action rule of FEATURE-SPECS 1.5).
export const screenGuidance='Screen control: you can see and use apps on this PC. The user approves each app the first time you touch it. Before sending, posting, buying or deleting anything, or changing an account, ask the user in the chat and wait for their answer. Never type a password, card number or secret: ask the user to do it.';
export const screenInstructions=(browser:boolean)=>screenGuidance+' Desktop: call get_window_state for an app window before acting in it, and prefer element tokens over pixel coordinates.'+(browser?' Browser: run the agent-browser command in the terminal (agent-browser open <url>, agent-browser snapshot -i, agent-browser click @e1, agent-browser fill @e2 "text"); it drives Chrome on a profile that belongs to this app.':'');
// The bar shown while a model works on screen (FEATURE-SPECS 1.6). Its Stop button sets the page title to "stop".
export const screenBarPage=(text:string)=>'data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Screen control</title><style>html,body{margin:0;background:transparent;overflow:hidden;font:13px "Segoe UI",system-ui,sans-serif}div{display:flex;gap:12px;align-items:center;justify-content:space-between;box-sizing:border-box;height:40px;padding:0 6px 0 16px;background:#141413;color:#e8e6dc;border:1px solid #30302d;border-radius:999px;-webkit-app-region:drag}span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}i{font-style:normal;color:#92918a}button{-webkit-app-region:no-drag;border:0;border-radius:999px;background:#d29a7e;color:#141413;font:600 12px "Segoe UI",system-ui,sans-serif;padding:6px 14px;cursor:pointer}</style><div><span>'+text.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string,string>)[c])+' <i>· Esc to stop</i></span><button onclick="document.title=\'stop\'">Stop</button></div>');
