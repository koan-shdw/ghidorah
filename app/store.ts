import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {Chat,Project,Turn,ToolCall,Approval,Snapshot,Mode} from './types';
import type {Engine,EnginePosition} from './history';
import {providerFor} from './models';

// A failure that overflowed the context would fail again in the same session (batch 5, 7c).
const contextOverflow=(error:unknown)=>/context|too long|too large|maximum.{0,20}tokens|token limit|tokens? exceed/i.test(String(error??''));

// Long tool outputs live in their own table (OUTPUTS, 2026-11-09). A tool or work-action row keeps a short preview
// and resultCut, as pushed window states already did; whole() reads the saved output when a row is opened, exported,
// forked or read into history. Before this every output was saved whole, twice (the tool row and its work-action
// row): 2.6 GB of Koan's 2.9 GB file, and the paths that read every row of a kind (startup, the end of every reply)
// parsed 1.3 GB at a time: ten seconds frozen, and the engine's 4.3 GB memory limit reached, so the app closed with
// no error shown.
export const PREVIEW_CUT=2000;
export const PREVIEW_MARK='\n… [cut here: open the row for the whole result]';
// The preview's mark once the whole text has been aged out (ageResults): the row is all that is left.
export const AGED_MARK='\n… [cut; the whole result was removed after its keep time]';
// Whole outputs are kept this many days, then aged out (Koan 2026-11-09: they grew about 210 MB a day).
export const OUTPUT_KEEP_DAYS=14;
// The marks as they read inside JSON text (the newline escaped), for checks on a saved row's text.
const inJson=(mark:string)=>JSON.stringify(mark).slice(1,-1);
const MARK_IN_JSON=inJson(PREVIEW_MARK),AGED_IN_JSON=inJson(AGED_MARK);
function cutStrings(value:any,depth=0):any{
  if(typeof value==='string')return value.length>PREVIEW_CUT?value.slice(0,PREVIEW_CUT)+PREVIEW_MARK:value;
  if(!value||typeof value!=='object'||depth>20)return value;
  const next:any=Array.isArray(value)?[]:{};for(const [key,item] of Object.entries(value))next[key]=cutStrings(item,depth+1);return next;
}
// The preview keeps the result's shape: long strings are cut, numbers and fields stay, so status checks (exit_code,
// is_error) still read the row. When even that is long (many strings), the start of the text. Every preview carries
// PREVIEW_MARK, which is how a re-saved row is told from a new result.
export function previewOf(result:unknown){
  const shaped=cutStrings(result),text=JSON.stringify(shaped);
  return text.length<=8*PREVIEW_CUT&&text.includes(MARK_IN_JSON)?shaped:JSON.stringify(result).slice(0,PREVIEW_CUT)+PREVIEW_MARK;
}

const indexedFields=['turnId','job','status','signature','chatId'] as const;
type IndexedField=typeof indexedFields[number];
const turnFields=['jobs','remote'] as const;
const chatFields=['parentChatId','runtimeId'] as const;

export class Store {
  db:DatabaseSync;
  constructor(file:string) {
    this.db=new DatabaseSync(file);
    // WAL and a busy timeout: an outside reader (a report, an investigation) never makes a write fail (TURN-REVIEW
    // section 2 item 8: 21 of 37 writes were refused during one read).
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS results(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      PRAGMA user_version=1;`);
    for(const field of indexedFields)this.db.exec(`CREATE INDEX IF NOT EXISTS records_${field} ON records(kind,json_extract(data,'$.${field}'))`);
    // Partial indexes hold only the few rows that carry the field, so these reads never parse the rest (SPEED-PLAN 1a).
    for(const field of turnFields)this.db.exec(`CREATE INDEX IF NOT EXISTS records_turn_${field} ON records(kind) WHERE kind='turn' AND json_extract(data,'$.${field}') IS NOT NULL`);
    for(const field of chatFields)this.db.exec(`CREATE INDEX IF NOT EXISTS records_chat_${field} ON records(json_extract(data,'$.${field}')) WHERE kind='chat'`);
    this.db.exec(`DROP INDEX IF EXISTS records_chat_parent`);
    // Retired picker preferences migrate without changing chat selectors or past usage.
    this.transaction(()=>{
      const engine=this.all<{id:string;engine?:string}>('settings').find(row=>row.id==='decision-engine');
      if(engine?.engine==='laya')this.put('settings',{...engine,engine:'jev'});
      this.remove('settings','laya');
    });
  }
  // Streamed reply text waits here and goes to disk at most every 250 ms (SPEED-PLAN 5: each piece rewrote the whole
  // growing row with a full sync, 1.8 s of main-process work for 600 pieces). Every read in this process sees it; any
  // other change to the turn writes it at once. A crash can lose the last 250 ms of a reply's partial text.
  private streamed=new Map<string,Partial<Turn>>();private streamTimer?:NodeJS.Timeout;
  private parse(kind:string,data:string){const value=JSON.parse(data);if(kind==='turn'&&this.streamed.size){const pending=this.streamed.get(value.id);if(pending)Object.assign(value,pending);}return value;}
  stream(id:string,patch:Pick<Partial<Turn>,'text'|'reasoning'|'activity'>):Turn {
    const previous=this.get<Turn>('turn',id),v:Turn={...previous,...patch,lastActivity:Date.now()};
    if(v.activity!==previous.activity)v.stageSince=Date.now();
    this.streamed.set(id,{text:v.text,reasoning:v.reasoning,activity:v.activity,lastActivity:v.lastActivity,stageSince:v.stageSince});
    this.streamTimer??=setTimeout(()=>this.flush(),250);this.streamTimer.unref?.();
    return v;
  }
  flush(){
    clearTimeout(this.streamTimer);this.streamTimer=undefined;if(!this.streamed.size||!this.db.isOpen)return;
    const pending=[...this.streamed];this.streamed.clear();
    this.transaction(()=>{for(const [id,patch] of pending){const r:any=this.db.prepare("SELECT data FROM records WHERE kind='turn' AND id=?").get(id);if(r)this.db.prepare("UPDATE records SET data=? WHERE kind='turn' AND id=?").run(JSON.stringify({...JSON.parse(r.data),...patch}),id);}});
  }
  // Tool and work-action rows are never read all at once (OUTPUTS 2026-11-09: on Koan's data that parsed 1.3 GB
  // after every reply). They are read by turn, job or status.
  all<T>(kind:string):T[] {if(kind==='tool'||kind==='work-action')throw Error(`Read ${kind} records by turn, job or status (where, whereIn, toolsOf), never all at once.`);return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map((r:any)=>this.parse(kind,r.data));}
  // Per-tool lookups read only matching rows through expression indexes; all() parses every row (RUN-PLAN 3c:
  // 244 ms for Koan's 7,179 tool rows, several times per tool call).
  where<T>(kind:string,field:IndexedField,value:string):T[] {return this.db.prepare(`SELECT data FROM records WHERE kind=? AND json_extract(data,'$.${field}')=? ORDER BY rowid`).all(kind,value).map((r:any)=>this.parse(kind,r.data));}
  whereIn<T>(kind:string,field:IndexedField,values:string[]):T[] {
    const rows:{rowid:number;data:string}[]=[];
    for(let i=0;i<values.length;i+=900){const chunk=values.slice(i,i+900);rows.push(...this.db.prepare(`SELECT rowid,data FROM records WHERE kind=? AND json_extract(data,'$.${field}') IN (${chunk.map(()=>'?').join(',')})`).all(kind,...chunk) as any[]);}
    return rows.sort((a,b)=>a.rowid-b.rowid).map(r=>this.parse(kind,r.data));
  }
  // Turns that carry parallel jobs or came from remote, in saved order.
  turnsWith<T=Turn>(field:typeof turnFields[number]):T[] {if(!turnFields.includes(field))throw Error('Unknown turn field');return this.db.prepare(`SELECT data FROM records WHERE kind='turn' AND json_extract(data,'$.${field}') IS NOT NULL ORDER BY rowid`).all().map((r:any)=>this.parse('turn',r.data));}
  // Turns that finished after a time, for copying desktop work into Telegram topics.
  // ponytail: scans every turn; index finished if this shows up in profiles.
  turnsFinishedAfter<T=Turn>(at:number):T[] {return this.db.prepare(`SELECT data FROM records WHERE kind='turn' AND json_extract(data,'$.finished')>? ORDER BY rowid`).all(at).map((r:any)=>this.parse('turn',r.data));}
  // A chat's turns and those of its job chats, in saved order: every turn whose root message is in this chat.
  // Automatic follow-ups are saved in their own chat, parallel jobs in a child chat (SPEED-PLAN 1a, 3).
  ownedTurns<T=Turn>(chatId:string):T[] {return this.whereIn<T>('turn','chatId',[chatId,...this.chatsWhere('parentChatId',chatId).map(chat=>chat.id)]);}
  // What a send needs from history: the chat's own and job turns, and their tools (SPEED-PLAN 3: the whole database
  // was read two or three times per send).
  chatRecords(chatId:string):{turns:Turn[];tools:ToolCall[]} {const turns=this.ownedTurns<Turn>(chatId);return {turns,tools:this.toolsOf(turns)};}
  toolsOf(turns:readonly {id:string}[]):ToolCall[] {return this.whereIn<ToolCall>('tool','turnId',turns.map(turn=>turn.id));}
  // The whole result of a tool or work-action row saved as a preview: its own results row, or for an action the
  // tool row that took its result. A row saved short comes back as it is.
  whole(kind:string,record:any):any {
    if(!record?.resultCut)return record?.result;
    const own:any=this.db.prepare('SELECT data FROM results WHERE kind=? AND id=?').get(kind,record.id);if(own)return JSON.parse(own.data);
    if(kind==='work-action'&&record.toolId){const tool=this.find<ToolCall>('tool',record.toolId);if(tool&&tool.turnId===record.job)return this.whole('tool',tool);}
    return record.result;
  }
  // Rows with their whole results, for an export, a fork or a history page; one read per 900 rows.
  withResults<T extends {id:string;result?:any;resultCut?:boolean}>(kind:string,rows:T[]):T[] {
    const cut=rows.filter(row=>row.resultCut);if(!cut.length)return rows;
    const found=new Map<string,string>();
    for(let i=0;i<cut.length;i+=900){const chunk=cut.slice(i,i+900);for(const r of this.db.prepare(`SELECT id,data FROM results WHERE kind=? AND id IN (${chunk.map(()=>'?').join(',')})`).all(kind,...chunk.map(row=>row.id)) as any[])found.set(String(r.id),r.data);}
    return rows.map(row=>{const data=found.get(row.id);if(data===undefined)return row;const {resultCut,...rest}=row;return {...rest,result:JSON.parse(data)} as T;});
  }
  // The saved size of the given rows' whole results, summed inside SQLite: for history measures (auto-compaction).
  resultsSize(kind:string,ids:string[]):number {
    let total=0;
    for(let i=0;i<ids.length;i+=900){const chunk=ids.slice(i,i+900);total+=Number((this.db.prepare(`SELECT sum(length(data)) AS n FROM results WHERE kind=? AND id IN (${chunk.map(()=>'?').join(',')})`).get(kind,...chunk) as any)?.n||0);}
    return total;
  }
  // Ids among the given rows whose saved whole result contains the text, matched inside SQLite: nothing is parsed.
  resultsContaining(kind:string,ids:string[],needle:string):Set<string> {
    const hits=new Set<string>();if(!needle)return hits;
    for(let i=0;i<ids.length;i+=900){const chunk=ids.slice(i,i+900);for(const r of this.db.prepare(`SELECT id FROM results WHERE kind=? AND id IN (${chunk.map(()=>'?').join(',')}) AND instr(lower(data),?)>0`).all(kind,...chunk,needle.toLowerCase()) as any[])hits.add(String(r.id));}
    return hits;
  }
  // Rows saved whole by earlier versions move to the results table a few at a time, so the window never waits (the
  // whole pass over Koan's 2.9 GB file is about a minute; scripts/split-results.ts runs it to the end). True once
  // every row is done; the pass is remembered in events.
  splitResults(rows=40):boolean {
    if(!this.db.isOpen)return false;
    if(this.db.prepare("SELECT 1 FROM events WHERE id='results-split-v1'").get())return true;
    const progress=this.find<{id:string;rowid:number}>('settings','results-split')?.rowid||0;
    // NOT INDEXED: the batch walks the table from the last rowid. Through the kind index SQLite re-read and sorted
    // every tool row for each batch (5,000 rows a minute on Koan's file).
    const batch=this.db.prepare(`SELECT rowid,kind,id,data FROM records NOT INDEXED WHERE rowid>? AND kind IN ('tool','work-action') AND length(data)>? ORDER BY rowid LIMIT ?`).all(progress,PREVIEW_CUT,rows) as any[];
    if(!batch.length){this.transaction(()=>{this.remove('settings','results-split');this.event('results-split-v1',()=>{});});return true;}
    this.transaction(()=>{
      for(const row of batch){
        const value=JSON.parse(row.data);if(value.resultCut||value.result==null||JSON.stringify(value.result).length<=PREVIEW_CUT)continue;
        // Written straight, not through put(): put stamps an old tool row without a start time with today's.
        this.db.prepare('UPDATE records SET data=? WHERE rowid=?').run(JSON.stringify(this.pack(row.kind,value)),row.rowid);
        // An action whose tool row never took its result keeps the whole text itself.
        if(row.kind==='work-action'&&!['uncertain','background'].includes(value.status)){const tool=value.toolId?this.find<ToolCall>('tool',value.toolId):undefined;if(!tool||tool.turnId!==value.job||tool.result==null)this.db.prepare('INSERT INTO results(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run('work-action',value.id,JSON.stringify(value.result));}
      }
      this.put('settings',{id:'results-split',rowid:batch.at(-1).rowid});
    });
    return false;
  }
  // Whole outputs whose message is older than keepDays go; the preview stays, its mark saying so. Uncertain and
  // background actions keep theirs (the start-up repair reads them). A chunk per call, like splitResults; true when
  // nothing is left to age. The file does not shrink: SQLite reuses the freed pages, so it stops growing.
  ageResults(keepDays=OUTPUT_KEEP_DAYS,rows=200):boolean {
    if(!this.db.isOpen||!(keepDays>0))return true;
    const before=Date.now()-keepDays*86400000;
    const old=this.db.prepare(`SELECT s.kind,s.id FROM results s JOIN records r ON r.kind=s.kind AND r.id=s.id JOIN records t ON t.kind='turn' AND t.id=json_extract(r.data,CASE s.kind WHEN 'tool' THEN '$.turnId' ELSE '$.job' END) WHERE json_extract(t.data,'$.created')<? AND NOT (s.kind='work-action' AND json_extract(r.data,'$.status') IN ('uncertain','background')) LIMIT ?`).all(before,rows) as any[];
    if(!old.length)return true;
    this.transaction(()=>{for(const row of old){this.db.prepare('DELETE FROM results WHERE kind=? AND id=?').run(row.kind,row.id);this.db.prepare('UPDATE records SET data=replace(data,?,?) WHERE kind=? AND id=?').run(MARK_IN_JSON,AGED_IN_JSON,row.kind,row.id);}});
    return old.length<rows;
  }
  // A read on a field with no index: SQLite walks the kind's rows, only the matches are parsed. For tests and the
  // group lookups that have no job list; everyday paths use where/whereIn.
  scan<T>(kind:string,field:string,value:string):T[] {if(!/^\w+$/.test(field))throw Error('Unknown field');return this.db.prepare(`SELECT data FROM records WHERE kind=? AND json_extract(data,'$.${field}')=? ORDER BY rowid`).all(kind,value).map((r:any)=>this.parse(kind,r.data));}
  chatsWhere(field:typeof chatFields[number],value:string):Chat[] {if(!chatFields.includes(field))throw Error('Unknown chat field');return this.db.prepare(`SELECT data FROM records WHERE kind='chat' AND json_extract(data,'$.${field}')=? ORDER BY rowid`).all(value).map((r:any)=>JSON.parse(r.data));}
  // Record ids only, straight from the index: nothing is parsed (SPEED-PLAN 1).
  idsWhere(kind:string,field:IndexedField,values:string[]):string[] {
    const ids:{rowid:number;id:string}[]=[];
    for(let i=0;i<values.length;i+=900){const chunk=values.slice(i,i+900);ids.push(...this.db.prepare(`SELECT rowid,id FROM records WHERE kind=? AND json_extract(data,'$.${field}') IN (${chunk.map(()=>'?').join(',')})`).all(kind,...chunk) as any[]);}
    return ids.sort((a,b)=>a.rowid-b.rowid).map(row=>String(row.id));
  }
  has(kind:string,id:string){return !!this.db.prepare('SELECT 1 FROM records WHERE kind=? AND id=?').get(kind,id);}
  find<T>(kind:string,id:string):T|undefined {const r:any=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);return r?this.parse(kind,r.data):undefined;}
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
  get<T>(kind:string,id:string):T {const r:any=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);if(!r)throw Error(`${kind} not found`);return this.parse(kind,r.data);}
  // A tool record keeps when it started and finished, for the action list's times (TRIS-TODO 4.1, A2).
  put<T extends {id:string}>(kind:string,value:T) {if(kind==='tool'){const tool:any=value;tool.started??=Date.now();if(!tool.finished&&['completed','failed','stopped'].includes(tool.status))tool.finished=Date.now();}if(kind==='turn')this.streamed.delete(value.id);const row=kind==='tool'||kind==='work-action'?this.pack(kind,value):value;this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,JSON.stringify(row));return value;}
  // The row saved for a tool or work-action. A long result becomes a preview; the whole text goes to the results
  // table when no other row holds it: always for a tool, for an action while it is uncertain or in the background,
  // or when no tool row of its job will take its result (a finished action's result is otherwise on its tool row).
  // A row that already carries a preview is kept as is.
  private pack(kind:string,value:any){
    const text=value.result===undefined?undefined:JSON.stringify(value.result);
    if(value.resultCut===true&&text!==undefined&&(text.includes(MARK_IN_JSON)||text.includes(AGED_IN_JSON)))return value;
    if(text!==undefined&&text.length>PREVIEW_CUT){
      const holder=kind==='work-action'&&value.toolId&&!['uncertain','background'].includes(value.status)?this.find<ToolCall>('tool',value.toolId):undefined;
      if(kind==='tool'||!(holder&&holder.turnId===value.job))this.db.prepare('INSERT INTO results(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,text);
      else this.db.prepare('DELETE FROM results WHERE kind=? AND id=?').run(kind,value.id);
      return {...value,result:previewOf(value.result),resultCut:true};
    }
    this.db.prepare('DELETE FROM results WHERE kind=? AND id=?').run(kind,value.id);
    if(value.resultCut===undefined)return value;const {resultCut,...rest}=value;return rest;
  }
  remove(kind:string,id:string){if(kind==='turn')this.streamed.delete(id);this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);if(kind==='tool'||kind==='work-action')this.db.prepare('DELETE FROM results WHERE kind=? AND id=?').run(kind,id);}
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
  chat(projectId:string):Chat {this.get('project',projectId);const c:Chat={id:randomUUID(),projectId,title:'New chat',draft:'',model:'deepseek-flash',effort:'high',runtimeId:null,storedId:null,created:Date.now(),updated:Date.now(),position:this.all<Chat>('chat').length,readThrough:''};this.put('chat',c);return c;}
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
  snapshot({tools=true}:{tools?:boolean}={}):Omit<Snapshot,'connected'|'backend'|'providerStatus'> {const turns=this.all<Turn>('turn').filter(turn=>!turn.contextSnapshot);return {projects:this.all<Project>('project'),chats:this.all<Chat>('chat').filter(chat=>!chat.parentChatId),turns,tools:tools?this.toolsOf(turns):[],approvals:this.all<Approval>('approval')};}
  interrupt(engine?:Engine,reason:Turn['stopReason']='app-restart') {
    const turns=this.all<Turn>('turn').filter(turn=>!engine||!turn.jobs?.length&&!turn.command&&(turn.model.startsWith('claude-code:')?'claude':'hermes')===engine),ids=new Set(turns.map(turn=>turn.id));
    for(const turn of turns)if(['running','waiting','dispatching','stopping'].includes(turn.status)||turn.parentTurnId&&turn.status==='queued')this.update<Turn>('turn',turn.id,{status:'interrupted',stopReason:turn.stopReason||reason,error:'Interrupted. Check any uncertain tool outcome before retrying.'});
    // After a restart old queued messages wait paused for one click (Koan, 2026-10-08), never auto-sent.
    if(!engine)for(const turn of turns)if(turn.status==='queued'&&!turn.parentTurnId&&!turn.automatic)this.update<Turn>('turn',turn.id,{paused:true});
    for(const approval of this.all<Approval>('approval'))if(ids.has(approval.turnId)&&approval.status==='pending')this.update<Approval>('approval',approval.id,{status:'expired'});
    for(const tool of this.where<ToolCall>('tool','status','running'))if(ids.has(tool.turnId))this.update<ToolCall>('tool',tool.id,{status:'uncertain'});
  }
}
