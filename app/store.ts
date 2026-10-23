import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {Chat,Project,Turn,ToolCall,Approval,Snapshot,Mode} from './types';
import type {Engine,EnginePosition} from './history';
import {providerFor} from './models';

// A failure that overflowed the context would fail again in the same session (batch 5, 7c).
const contextOverflow=(error:unknown)=>/context|too long|too large|maximum.{0,20}tokens|token limit|tokens? exceed/i.test(String(error??''));

const indexedFields=['turnId','job','status','signature','chatId'] as const;
type IndexedField=typeof indexedFields[number];

export class Store {
  db:DatabaseSync;
  constructor(file:string) {
    this.db=new DatabaseSync(file);
    // WAL and a busy timeout: an outside reader (a report, an investigation) never makes a write fail (TURN-REVIEW
    // section 2 item 8: 21 of 37 writes were refused during one read).
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY);
      PRAGMA user_version=1;`);
    for(const field of indexedFields)this.db.exec(`CREATE INDEX IF NOT EXISTS records_${field} ON records(kind,json_extract(data,'$.${field}'))`);
    // Retired picker preferences migrate without changing chat selectors or past usage.
    this.transaction(()=>{
      const engine=this.all<{id:string;engine?:string}>('settings').find(row=>row.id==='decision-engine');
      if(engine?.engine==='laya')this.put('settings',{...engine,engine:'jev'});
      this.remove('settings','laya');
    });
  }
  all<T>(kind:string):T[] {return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map((r:any)=>JSON.parse(r.data));}
  // Per-tool lookups read only matching rows through expression indexes; all() parses every row (RUN-PLAN 3c:
  // 244 ms for Koan's 7,179 tool rows, several times per tool call).
  where<T>(kind:string,field:IndexedField,value:string):T[] {return this.db.prepare(`SELECT data FROM records WHERE kind=? AND json_extract(data,'$.${field}')=? ORDER BY rowid`).all(kind,value).map((r:any)=>JSON.parse(r.data));}
  whereIn<T>(kind:string,field:IndexedField,values:string[]):T[] {
    const rows:{rowid:number;data:string}[]=[];
    for(let i=0;i<values.length;i+=900){const chunk=values.slice(i,i+900);rows.push(...this.db.prepare(`SELECT rowid,data FROM records WHERE kind=? AND json_extract(data,'$.${field}') IN (${chunk.map(()=>'?').join(',')})`).all(kind,...chunk) as any[]);}
    return rows.sort((a,b)=>a.rowid-b.rowid).map(r=>JSON.parse(r.data));
  }
  find<T>(kind:string,id:string):T|undefined {const r:any=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.data):undefined;}
  enginePosition(chatId:string,engine:Engine):EnginePosition {
    this.get('chat',chatId);
    try{return this.get('engine',chatId+':'+engine);}catch{return {id:chatId+':'+engine,chatId,engine,sessionId:null,throughTurnId:null,uncertain:false};}
  }
  beginEngine(chatId:string,engine:Engine){
    // Persist before dispatch. A crash leaves uncertainty and forces context reseeding.
    const previous=this.enginePosition(chatId,engine);
    this.put('engine',{...previous,uncertain:true});return previous;
  }
  finishEngine(turnId:string,engine:Engine,sessionId:string|null,patch:Partial<Turn>){
    const turn=this.get<Turn>('turn',turnId);
    this.transaction(()=>{
      this.update<Turn>('turn',turnId,patch);
      if(patch.status==='completed')this.put('settings',{id:'last-model',model:turn.model,provider:providerFor(turn.model)});
      const previous=this.enginePosition(turn.chatId,engine);
      // A failed turn keeps its session (batch 5, 7c); one that overflowed the context starts fresh.
      const overflow=patch.status==='failed'&&contextOverflow(patch.error);
      this.put('engine',{...previous,sessionId:overflow?null:sessionId,throughTurnId:turnId,uncertain:overflow||!['completed','stopped','failed'].includes(String(patch.status))||this.where<ToolCall>('tool','turnId',turnId).some(t=>['running','uncertain'].includes(t.status)),exchanges:previous.sessionId===sessionId?(previous.exchanges||0)+1:1});
    });
  }
  initializeWorkingFolder(){
    if(this.all<any>('settings').some(s=>s.id==='working-folder'))return;
    const folders=[...new Set(this.all<Project>('project').map(p=>p.folder).filter(Boolean))];
    const folder=folders.length===1?folders[0]:null;
    this.transaction(()=>{this.put('settings',{id:'working-folder',folder});for(const p of this.all<Project>('project'))this.update<Project>('project',p.id,{folder});});
  }
  initializeNativeMemoryIsolation(){
    if(this.all<any>('settings').some(s=>s.id==='native-memory-isolation-v1'))return;
    this.transaction(()=>{
      for(const chat of this.all<Chat>('chat'))this.put('engine',{...this.enginePosition(chat.id,'claude'),sessionId:null,uncertain:true});
      this.put('settings',{id:'native-memory-isolation-v1'});
    });
  }
  initializeToolContext(){
    // One fresh Hermes session adopts the corrected core prompt and tool surface.
    // Durable chat history is handed over; subsequent replies keep their cache.
    this.event('direct-tools-context-v1',()=>{
      for(const position of this.all<EnginePosition>('engine'))if(position.engine==='hermes')this.put('engine',{...position,sessionId:null});
    });
    // Older sessions may contain a huge protected seed that engine compression cannot shrink.
    this.event('bounded-history-context-v1',()=>{
      for(const position of this.all<EnginePosition>('engine'))this.put('engine',{...position,sessionId:null,uncertain:true});
    });
  }
  get<T>(kind:string,id:string):T {const r:any=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);if(!r)throw Error(`${kind} not found`);return JSON.parse(r.data);}
  // A tool record keeps when it started and finished, for the action list's times (TRIS-TODO 4.1, A2).
  put<T extends {id:string}>(kind:string,value:T) {if(kind==='tool'){const tool:any=value;tool.started??=Date.now();if(!tool.finished&&['completed','failed','stopped'].includes(tool.status))tool.finished=Date.now();}this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,JSON.stringify(value));return value;}
  remove(kind:string,id:string){this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);}
  update<T extends {id:string}>(kind:string,id:string,patch:Partial<T>):T {const previous:any=this.get<T>(kind,id),v:any={...previous,...patch};if(kind==='turn'){v.lastActivity=Date.now();if(['stopped','interrupted','failed'].includes(v.status)&&!v.stopReason)v.stopReason='unknown';if(v.status!==previous.status||v.preparation!==previous.preparation||v.activity!==previous.activity)v.stageSince=Date.now();}if(kind==='turn'&&!v.finished&&['completed','stopped','failed','interrupted'].includes(v.status))v.finished=Date.now();this.put(kind,v);return v;}
  transaction<T>(fn:()=>T):T {if(this.db.isTransaction)return fn();this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  event(id:string,fn:()=>void){return this.transaction(()=>{if(!this.db.prepare('INSERT OR IGNORE INTO events VALUES(?)').run(id).changes)return false;fn();return true;});}
  defaultMode(value?:unknown):Mode {
    const valid=(mode:unknown):mode is Mode=>typeof mode==='string'&&['manual','accept-edits','plan','auto','bypass'].includes(mode);
    if(value!==undefined){if(!valid(value))throw Error('Choose a permission mode.');this.put('settings',{id:'default-permission-mode',mode:value});}
    const mode=this.all<{id:string;mode?:unknown}>('settings').find(row=>row.id==='default-permission-mode')?.mode;
    return valid(mode)?mode:'manual';
  }
  project(folder:string|null=null):Project {const id=randomUUID();const p:Project={id,name:"New project",folder,profile:"p-"+id,mode:this.defaultMode(),group:"Ungrouped"};this.put("project",p);return p;}
  chat(projectId:string):Chat {this.get('project',projectId);const c:Chat={id:randomUUID(),projectId,title:'New project',draft:'',model:'deepseek-flash',effort:'high',runtimeId:null,storedId:null,created:Date.now(),updated:Date.now(),position:this.all<Chat>('chat').length,readThrough:''};this.put('chat',c);return c;}
  accept(id:string,chatId:string,prompt:string,model?:string,source?:Pick<Turn,'remote'|'routine'|'voice'|'handoff'>):Turn {
    try{return this.get<Turn>('turn',id);}catch{}
    const c=this.get<Chat>('chat',chatId);
    return this.transaction(()=>{
      const picked=model||c.model,attachments=source?[]:c.attachments||[];
      const t:Turn={id,chatId,prompt,attachments,...source,text:'',reasoning:'',status:'queued',model:picked,efforts:{...c.efforts},effort:c.efforts?.[picked]||c.effort,error:null,usage:null,created:Date.now()};
      this.put('turn',t);
      this.update<Chat>('chat',chatId,{...(!source?{draft:'',attachments:[],selected:false,selectedModels:[]}:{}),title:['New chat','New project'].includes(c.title)?(prompt.slice(0,55)||attachments[0]?.name||c.title):c.title});
      return t;
    });
  }
  // tools:false leaves the tool rows out; window refreshes fetch only the turns a window shows (RUN-PLAN 3b).
  snapshot({tools=true}:{tools?:boolean}={}):Omit<Snapshot,'connected'|'backend'|'providerStatus'> {const turns=this.all<Turn>('turn').filter(turn=>!turn.contextSnapshot),ids=new Set(turns.map(turn=>turn.id));return {projects:this.all<Project>('project'),chats:this.all<Chat>('chat').filter(chat=>!chat.parentChatId),turns,tools:tools?this.all<ToolCall>('tool').filter(tool=>ids.has(tool.turnId)):[],approvals:this.all<Approval>('approval')};}
  interrupt(engine?:Engine,reason:Turn['stopReason']='app-restart') {
    const turns=this.all<Turn>('turn').filter(turn=>!engine||!turn.jobs?.length&&!turn.command&&(turn.model.startsWith('claude-code:')?'claude':'hermes')===engine),ids=new Set(turns.map(turn=>turn.id));
    for(const turn of turns)if(['running','waiting','dispatching','stopping'].includes(turn.status)||turn.parentTurnId&&turn.status==='queued')this.update<Turn>('turn',turn.id,{status:'interrupted',stopReason:turn.stopReason||reason,error:'Interrupted. Check any uncertain tool outcome before retrying.'});
    // After a restart old queued messages wait paused for one click (Koan, 2026-10-08), never auto-sent.
    if(!engine)for(const turn of turns)if(turn.status==='queued'&&!turn.parentTurnId&&!turn.automatic)this.update<Turn>('turn',turn.id,{paused:true});
    for(const approval of this.all<Approval>('approval'))if(ids.has(approval.turnId)&&approval.status==='pending')this.update<Approval>('approval',approval.id,{status:'expired'});
    for(const tool of this.all<ToolCall>('tool'))if(ids.has(tool.turnId)&&tool.status==='running')this.update<ToolCall>('tool',tool.id,{status:'uncertain'});
  }
}
