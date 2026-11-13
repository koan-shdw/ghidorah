import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Store,PREVIEW_CUT,previewOf,filePointers} from '../app/store';
import {Sidebar} from '../app/sidebar';
import type {Chat,ToolCall,Turn} from '../app/types';

// STORAGE 2026-11-13. Koan's chat.sqlite was 10.1 GB: 19,147 picture reads saved as base64 text (7.1 GB), 1.9 GB of
// rows an old build saved whole after the split, and deleting any chat read and parsed every record (4 s, 3 GB).
const picture=(letters=600000)=>[{type:'image',source:{type:'base64',data:'A'.repeat(letters),media_type:'image/jpeg'}}];
const place=(file:string,letters=600000)=>[{type:'image',source:{type:'file',path:file,media_type:'image/jpeg',bytes:Math.floor(letters*3/4)}}];
const fixture=()=>{const store=new Store(':memory:'),chat=store.chat(store.project().id),turn=store.accept('t1',chat.id,'Work');return {store,chat,turn};};
const count=(store:Store,sql:string)=>(store.db.prepare(sql).get() as any).n as number;
const saved=(store:Store,kind:string,id:string)=>JSON.parse((store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id) as any).data);

test('a picture read from a file is saved as the file, not a copy; a picture with no file is saved as before',()=>{
  const {store,turn}=fixture(),file='I:\\pics\\a.jpg';
  store.put<ToolCall>('tool',{id:'read',turnId:turn.id,name:'Read',args:{file_path:file},result:picture(),status:'completed'});
  assert.deepEqual(saved(store,'tool','read').result,place(file));assert.equal(saved(store,'tool','read').resultCut,undefined);
  assert.equal(count(store,'SELECT count(*) AS n FROM results'),0,'no copy is kept');
  assert.ok(JSON.stringify(saved(store,'tool','read')).length<500);
  // Text beside the picture stays; a document counts like a picture; a POSIX path counts.
  const mixed=[{type:'text',text:'caption'},...picture()];
  assert.deepEqual(filePointers(mixed,{path:'/home/k/a.jpg'}),[{type:'text',text:'caption'},...place('/home/k/a.jpg')]);
  assert.equal(filePointers([{type:'document',source:{type:'base64',data:'A'.repeat(4000),media_type:'application/pdf'}}],{file_path:file})[0].source.type,'file');
  assert.deepEqual(filePointers(picture(),JSON.stringify({file_path:file})),place(file),'arguments saved as JSON text');
  // Claude Code's own record of a picture read: {type:'image',file:{base64,type,originalSize,dimensions}}.
  const record={type:'image',file:{base64:'A'.repeat(600000),type:'image/jpeg',originalSize:900000,dimensions:{originalWidth:4000,originalHeight:3000,displayWidth:2000,displayHeight:1500}}};
  assert.deepEqual(filePointers(record,{file_path:file}),{type:'image',file:{type:'image/jpeg',originalSize:900000,dimensions:record.file.dimensions,path:file,bytes:450000}});
  assert.equal(filePointers({type:'text',file:{filePath:file,content:'x'.repeat(5000)}},{file_path:file}).file.content.length,5000,'a text read is left alone');
  // No file named, a relative path, a small icon, plain text: saved as before, the same value back.
  for(const [result,args] of [[picture(),{}],[picture(),{file_path:'pics/a.jpg'}],[picture(100),{file_path:file}],['plain text',{file_path:file}],[{output:'x'.repeat(5000)},{file_path:file}]] as const)assert.equal(filePointers(result,args),result);
  store.put<ToolCall>('tool',{id:'shot',turnId:turn.id,name:'mcp__screen__get_window_state',args:{},result:picture(),status:'completed'});
  assert.equal(saved(store,'tool','shot').resultCut,true);assert.deepEqual(store.whole('tool',store.get('tool','shot')),picture());
  store.db.close();
});

test('pictures saved before become file places a batch at a time; other saved results stay',()=>{
  const {store,turn}=fixture(),file='I:\\pics\\a.jpg',text={output:'x'.repeat(20000)};
  const old=(kind:string,value:any)=>store.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run(kind,value.id,JSON.stringify(value));
  const whole=(kind:string,id:string,result:any)=>store.db.prepare('INSERT INTO results(kind,id,data) VALUES(?,?,?)').run(kind,id,JSON.stringify(result));
  const action=(id:string,toolId:string,values:any)=>({id,toolId,job:turn.id,group:'g',name:'Read',args:{file_path:file},resource:'.',access:'read',signature:id,status:'completed',...values});
  // What an old build left after the split had finished: the tool row and its action row, both whole.
  old('tool',{id:'left',turnId:turn.id,name:'Read',args:{file_path:file},result:picture(),status:'completed'});
  old('work-action',action('left-action','left',{result:picture()}));
  // What the app saved since: a preview on the row, the whole picture in results; its action reads through the tool.
  for(let i=0;i<5;i++){old('tool',{id:'p'+i,turnId:turn.id,name:'Read',args:{file_path:file},result:previewOf(picture()),resultCut:true,status:'completed'});whole('tool','p'+i,picture());}
  old('work-action',action('p0-action','p0',{result:previewOf(picture()),resultCut:true}));
  // Not pictures from a file: a screenshot and a long text keep their whole results.
  old('tool',{id:'shot',turnId:turn.id,name:'screen',args:{},result:previewOf(picture()),resultCut:true,status:'completed'});whole('tool','shot',picture());
  old('tool',{id:'text',turnId:turn.id,name:'Bash',args:{},result:previewOf(text),resultCut:true,status:'completed'});whole('tool','text',text);
  // A long text an old build left whole goes to results, as the split does.
  old('tool',{id:'left-text',turnId:turn.id,name:'Bash',args:{},result:text,status:'completed'});
  let passes=0;while(!store.slimResults(2))passes++;
  assert.ok(passes>=5,'small batches');assert.equal(store.slimResults(),true,'remembered as done');
  for(const id of ['left','p0','p1','p2','p3','p4']){const tool=store.get<ToolCall>('tool',id);assert.deepEqual(tool.result,place(file),id);assert.equal(tool.resultCut,undefined);assert.equal(tool.started,undefined,'old rows are not stamped');}
  assert.deepEqual(store.get<any>('work-action','left-action').result,place(file));
  assert.deepEqual(store.whole('work-action',store.get('work-action','p0-action')),place(file),'an action reads the place through its tool row');
  assert.deepEqual(store.whole('tool',store.get('tool','shot')),picture());assert.deepEqual(store.whole('tool',store.get('tool','text')),text);assert.deepEqual(store.whole('tool',store.get('tool','left-text')),text);
  assert.equal(count(store,'SELECT count(*) AS n FROM results'),3,'the screenshot and the two texts');
  assert.ok(count(store,"SELECT sum(length(data)) AS n FROM records WHERE kind IN ('tool','work-action')")<11*3*PREVIEW_CUT);
  store.db.close();
});

test("deleting a chat removes its own records and no others, and reads no other chat's rows",()=>{
  const store=new Store(':memory:'),sidebar=new Sidebar(store),project=store.project().id;
  const fill=(name:string)=>{
    const chat=store.chat(project),turn=store.accept(name+'-turn',chat.id,'Work'),job=store.chat(project);
    store.update<Chat>('chat',job.id,{parentChatId:chat.id});const jobTurn=store.accept(name+'-job-turn',job.id,'Part');
    for(const id of [turn.id,jobTurn.id]){
      store.update<Turn>('turn',id,{status:'completed'});
      store.put<ToolCall>('tool',{id:id+':tool',turnId:id,name:'Bash',args:{},result:{output:'x'.repeat(50000)},status:'completed'});
      store.put('work-action',{id:id+':action',toolId:id+':tool',job:id,group:turn.id,name:'Bash',args:{},resource:'.',access:'write',signature:id,status:'completed',result:'ok'});
      store.put('work-claim',{id:id+':claim',group:turn.id,job:id,resource:'.',task:'t',status:'released'});
      store.put('goal-report',{id,text:'report'});store.put('route',{id:id+':route',turnId:id,reason:'selected'});
    }
    store.put('work-note',{id:name+':note',group:turn.id,job:'gone',text:'kept only by its group'});
    store.put('goal',{id:chat.id,status:'paused'});store.put('background',{id:name+':bg',chatId:chat.id,status:'exited'});
    return chat;
  };
  // Twice: before the group index is made (group lookups walk the kinds that carry one) and after.
  for(const indexed of [false,true]){
  if(indexed)store.indexGroup();
  const kept=fill('kept-'+indexed),gone=fill('gone-'+indexed);
  const all=()=>(store.db.prepare('SELECT kind,id,data FROM records').all() as any[]);
  // What the delete has always removed: the old rule, read here over every row.
  const chats=new Set(sidebar.owned(gone.id).map(chat=>chat.id)),turns=new Set(store.all<Turn>('turn').filter(turn=>chats.has(turn.chatId)).map(turn=>turn.id));
  const expected=all().filter(row=>{const value=JSON.parse(row.data);return chats.has(value.chatId)||turns.has(value.turnId)||turns.has(value.job)||turns.has(value.group)||row.kind==='turn'&&turns.has(row.id)||['chat','goal'].includes(row.kind)&&chats.has(row.id)||row.kind==='goal-report'&&turns.has(row.id);}).map(row=>row.kind+' '+row.id);
  assert.ok(expected.length>=17);
  const before=new Set(all().map(row=>row.kind+' '+row.id)),queries:string[]=[],prepare=store.db.prepare.bind(store.db);
  store.db.prepare=(sql:string)=>{queries.push(sql);return prepare(sql);};
  sidebar.delete(gone.id);
  store.db.prepare=prepare;
  const after=new Set(all().map(row=>row.kind+' '+row.id));
  assert.deepEqual([...before].filter(row=>!after.has(row)).sort(),expected.sort());
  assert.ok(store.get('chat',kept.id));assert.equal(count(store,'SELECT count(*) AS n FROM results'),indexed?4:2,"the other chats' whole results stay");
  const reads=queries.filter(sql=>/^SELECT\b/i.test(sql)&&/\bdata\b/.test(sql.slice(0,sql.search(/\bFROM\b/i))));
  assert.ok(reads.every(sql=>/\bid=\?/.test(sql)),'a row is read only by its own id: '+reads.find(sql=>!/\bid=\?/.test(sql)));
  }
  assert.throws(()=>store.all('checkpoint-blob'),/never all at once/);
  store.put('checkpoint-blob',{id:'b1',bytes:'AAAA'});assert.deepEqual(store.ids('checkpoint-blob'),['b1']);
  store.db.close();
});

// The fault found twice (OUTPUTS 2026-11-09, STORAGE 2026-11-13): a query that reads the data of every row. Every
// SELECT in the app that reads data names the kind it reads, or walks a bounded batch by rowid.
test('no query in the app reads the data of every row',async()=>{
  const root=path.resolve('app'),bad:string[]=[];
  const walk=async(folder:string):Promise<string[]>=>(await Promise.all((await fs.readdir(folder,{withFileTypes:true})).map(entry=>entry.isDirectory()?walk(path.join(folder,entry.name)):/\.tsx?$/.test(entry.name)?[path.join(folder,entry.name)]:[]))).flat();
  for(const file of await walk(root)){
    const source=await fs.readFile(file,'utf8');
    for(const [sql] of source.matchAll(/SELECT\b[^;`'"]*?\bFROM (?:records|results)\b[^;`'"]*/g)){
      const columns=sql.slice(0,sql.search(/\bFROM\b/)).replace(/count\(\*\)/g,'');
      const bounded=/\bkind\s*(?:=|IN\b)/.test(sql)||/\browid>\?/.test(sql)&&/\bLIMIT\b/.test(sql);
      if(/\bdata\b|\*/.test(columns)&&!bounded)bad.push(path.relative(root,file)+': '+sql.slice(0,100));
    }
  }
  assert.deepEqual(bad,[]);
});
