import React,{useEffect,useState} from 'react';
import type {SavedApp} from './saved-apps';
import type {Snapshot} from './types';
import {modelLabel} from './models';
import {updateModel} from './app-watch';
import {SidebarIcon} from './kit';
import {Field} from './app-overview';

const clean=(error:unknown)=>String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,'').replace(/^Error: /,'');
export function UpdatesCard({app,state,call,choose,notice}:{app:SavedApp;state:Snapshot;call:(method:string,args?:any)=>Promise<any>;choose:(id:string)=>void;notice:(message:string)=>void}){
 const watch=app.watch,updates=app.updates||[],fresh=updates.filter(idea=>idea.status==='new'),started=updates.filter(idea=>idea.status==='started');
 const [picked,setPicked]=useState<string[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState('');
 // Opens by itself only for an empty watch, then stays as the user leaves it while they edit.
 const [listOpen,setListOpen]=useState(()=>!app.watch?.topics&&!app.watch?.sources);
 useEffect(()=>{if(app.watchUnread)void call('savedAppWatchSeen',{id:app.id}).catch(()=>{});},[app.id,app.watchUnread]);
 if(!watch)return null;
 const models=state.availableModels||[],model=updateModel(watch.model,models,state.jev?.summaryModel),chosen=picked.filter(id=>fresh.some(idea=>idea.id===id));
 async function act(name:string,action:()=>Promise<any>){setBusy(name);setError('');try{return await action();}catch(e){setError(clean(e));}finally{setBusy('');}}
 const save=(patch:any)=>call('savedAppWatchSave',{id:app.id,...patch});
 async function start(){await act('start',async()=>{const result=await call('savedAppIdeasStart',{app:app.id,ids:chosen});setPicked([]);choose(result.chatId);if(result.warning)notice(result.warning);});}
 const status=watch.running?watch.step||'Checking for updates…':watch.frequency==='off'?'Automatic checks off':(watch.frequency==='weekly'?'Weekly':'Daily')+(watch.nextRun?' · next '+new Date(watch.nextRun).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'');
 return <section className="app-card app-note-section app-updates" aria-label="Latest updates">
  <header><h2>Latest updates <small aria-live="polite">{watch.running&&<span className="app-watch-spinner" aria-hidden="true"/>}{status}{watch.lastRun?' · last checked '+new Date(watch.lastRun).toLocaleDateString():''}</small></h2><div className="app-updates-actions"><select title="Model that plans searches and writes ideas" aria-label="Update model" value={model} onChange={event=>void act('model',()=>save({model:event.target.value}))}>{!model&&<option value="" disabled>{models.length?'Choose a connected model':'No connected models'}</option>}{models.map(id=><option key={id} value={id}>{modelLabel(id,state.claude?.models)}</option>)}</select><select aria-label="Update check frequency" value={watch.frequency} onChange={event=>void act('frequency',()=>save({frequency:event.target.value}))}><option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select>{watch.running?<button onClick={()=>void call('savedAppWatchStop',{id:app.id})}>Stop</button>:<button disabled={!!busy||!model} onClick={()=>void act('run',()=>call('savedAppWatchRun',{id:app.id}))}>Check now</button>}</div></header>
  {(error||watch.error&&!watch.running)&&<p role="alert" className="error">{error||watch.error}</p>}
  <details className="app-watch-list" open={listOpen} onToggle={event=>setListOpen(event.currentTarget.open)}><summary>What to watch</summary>
   <p>Say in your own words what to look for. Each check searches for exactly that, reads your sources (videos by what is said in them), and suggests updates that could help this app.</p>
   <Field label="What to look for" value={watch.topics} multiline maxLength={2000} placeholder="For example: new video, image, voice and music models, and new ways AI is used in video production and editing. Skip cloud-only tools." save={topics=>save({topics})}/>
   <Field label="Sources to check" value={watch.sources} multiline maxLength={4000} placeholder={'One per line, for example:\nhttps://www.youtube.com/@Fireship\nr/StableDiffusion\nhttps://github.com/comfyanonymous/ComfyUI\nhttps://huggingface.co/blog'} save={sources=>save({sources})}/>
   <div className="app-watch-options"><button disabled={!!busy||watch.running||!model} onClick={()=>void act('suggest',()=>call('savedAppWatchSuggest',{id:app.id}))}>{busy==='suggest'?'Suggesting…':'Suggest sources'}</button></div>
   {!!watch.checked?.length&&<small className="app-watch-checked">Last check read: {watch.checked.map(row=>row.line+(row.feed&&!row.line.toLowerCase().includes(row.feed.toLowerCase())?' → '+row.feed:'')+' ('+row.new+' new'+(row.captions!==undefined&&row.new?', captions for '+(row.captions===row.new?'all':row.captions+' of '+row.new):'')+')').join(' · ')}</small>}
   {!!watch.unchecked?.length&&<small className="app-watch-checked">No feed found or over the 40-source limit, so only searched: {watch.unchecked.join(' · ')}</small>}
  </details>
  {fresh.length?<ul className="app-ideas">{fresh.map(idea=><li key={idea.id}><input type="checkbox" aria-label={'Select update '+idea.title} checked={chosen.includes(idea.id)} onChange={event=>setPicked(list=>event.target.checked?[...list,idea.id]:list.filter(id=>id!==idea.id))}/><div className="app-idea-copy"><strong>{idea.title} <span className={'app-idea-effort '+idea.effort}>{idea.effort}</span></strong><p>{idea.summary}</p><details><summary>Why and how</summary>{idea.why&&<p><b>Why it helps:</b> {idea.why}</p>}<p><b>Suggested update:</b> {idea.change}</p></details><div className="app-idea-sources">{idea.sources.map(source=><button key={source.url} title={source.url} onClick={()=>void act('open',()=>call('savedAppIdeaOpen',{id:idea.id,url:source.url}))}>↗ {source.title||source.url.replace(/^https?:\/\//,'').slice(0,60)}</button>)}</div></div><button className="app-task-remove" aria-label={'Dismiss update '+idea.title} title="Dismiss" onClick={()=>void act('dismiss',()=>call('savedAppIdea',{id:idea.id,status:'dismissed'}))}><SidebarIcon name="trash"/></button></li>)}</ul>:<p>{watch.running?'Reading sources and searching for updates…':watch.lastRun?'No new updates yet.':'Choose what to watch, then check now or turn on automatic checks.'}</p>}
  {!!fresh.length&&<button className="app-ideas-start" disabled={!chosen.length||!!busy} onClick={()=>void start()}><SidebarIcon name="chats"/>{busy==='start'?'Starting…':chosen.length?'Start chat with '+chosen.length+(chosen.length===1?' update':' updates'):'Select updates to start a chat'}</button>}
  {!!started.length&&<details className="app-completed"><summary>Started · {started.length}</summary><ul className="app-ideas-started">{started.map(idea=><li key={idea.id}><button disabled={!idea.chatId||!state.chats.some(chat=>chat.id===idea.chatId)} onClick={()=>choose(idea.chatId!)}>{idea.title}</button></li>)}</ul></details>}
 </section>;
}
