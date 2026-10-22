// Update watch: a background job per app reads its sources and web searches, then a model turns new items into
// suggested updates. Pure logic here; main runs the job on a schedule and stores the results.
import {nextPresetFiring} from './routines';
import type {SavedApp} from './saved-apps';

export type WatchFrequency='off'|'daily'|'weekly';
export interface AppWatch {id:string;topics:string;sources:string;frequency:WatchFrequency;model:string;nextRun:number|null;lastRun?:number;seen:number;error?:string;unchecked?:string[];checked?:{line:string;feed:string;new:number;captions?:number}[];read?:string[];}
export interface WatchItem {id:string;url:string;title:string;excerpt:string;published?:number;source:string;}
export interface AppIdea {id:string;appId:string;title:string;summary:string;why:string;change:string;effort:'small'|'medium'|'large';sources:{url:string;title:string;published?:number}[];found:number;status:'new'|'dismissed'|'started';chatId?:string;}

export function updateModel(saved:string,models:string[],preferred=''){return saved?(models.includes(saved)?saved:''):models.includes(preferred)?preferred:models[0]||'';}
export const defaultWatch=(id:string):AppWatch=>({id,topics:'',sources:'',frequency:'off',model:'',nextRun:null,seen:0});
export function nextWatchRun(frequency:WatchFrequency,after:number){
 return frequency==='off'?null:nextPresetFiring(frequency==='weekly'?{kind:'preset',preset:'weekly',time:'09:00',day:1}:{kind:'preset',preset:'daily',time:'09:00'},after);
}
export function readWatch(input:any,previous:AppWatch,now:number):AppWatch{
 const text=(key:'topics'|'sources',max:number)=>{const value=input?.[key]??previous[key];if(typeof value!=='string'||value.length>max)throw Error('Enter '+(key==='topics'?'what to look for':'sources')+' in up to '+max.toLocaleString()+' characters.');return value.trim();};
 const frequency=input?.frequency??previous.frequency,model=input?.model??previous.model;
 if(!['off','daily','weekly'].includes(frequency))throw Error('Choose how often to check for updates.');
 if(typeof model!=='string'||model.length>200)throw Error('Choose an update model.');
 const nextRun=frequency===previous.frequency&&previous.nextRun!==null?previous.nextRun:nextWatchRun(frequency,now);
 return {...previous,topics:text('topics',2000),sources:text('sources',4000),frequency,model,nextRun};
}
const normal=(value:string)=>value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
// Keeps ideas that cite fetched items and are new to this app. A malformed idea is dropped, not the whole run.
export function readIdeas(raw:unknown,rawItems:unknown,existing:AppIdea[],appId:string,now:number):AppIdea[]{
 if(!Array.isArray(raw)||!Array.isArray(rawItems))throw Error('The update model returned an unusable report.');
 const items=new Map((rawItems as WatchItem[]).filter(item=>item&&typeof item.id==='string'&&typeof item.url==='string'&&/^https?:\/\//i.test(item.url)).map(item=>[item.id,item]));
 const urls=new Set(existing.flatMap(idea=>idea.sources.map(source=>source.url))),titles=new Set(existing.map(idea=>normal(idea.title))),out:AppIdea[]=[];
 const field=(value:unknown,max:number)=>typeof value==='string'&&value.trim()&&value.length<=max?value.trim():'';
 for(const idea of raw.slice(0,8) as any[]){
  const title=field(idea?.title,160),summary=field(idea?.summary,800),why=field(idea?.why,1000),change=field(idea?.change,1000);
  const sources=(Array.isArray(idea?.sources)?idea.sources:[]).slice(0,3).map((id:unknown)=>items.get(String(id))).filter(Boolean) as WatchItem[];
  if(!title||!summary||!change||!sources.length||titles.has(normal(title))||sources.every(source=>urls.has(source.url)))continue;
  titles.add(normal(title));for(const source of sources)urls.add(source.url);
  out.push({id:crypto.randomUUID(),appId,title,summary,why,change,effort:['small','medium','large'].includes(idea.effort)?idea.effort:'medium',sources:sources.map(source=>({url:source.url,title:String(source.title||'').slice(0,300),...(Number.isSafeInteger(source.published)?{published:source.published}:{})})),found:now,status:'new'});
 }
 return out;
}
export function ideasPrompt(app:Pick<SavedApp,'name'|'repositories'>,ideas:AppIdea[]){
 return 'Review these updates for '+app.name+' and plan how to use them.\n\n'+
  'Brief: check each update against the app’s code and notes. Say whether it is worth doing, why, and where it would fit. Then propose an implementation plan ordered by value and effort, with any licensing, hardware or compatibility caveats. Wait for my GO before changing code.'+
  (app.repositories?.length?'\n\nRepository folders: '+app.repositories.join(', '):'')+'\n\n'+
  ideas.map((idea,index)=>`${index+1}. ${idea.title} (${idea.effort} effort)\nWhat’s new: ${idea.summary}\n${idea.why?'Why it helps: '+idea.why+'\n':''}Suggested update: ${idea.change}\nSources: ${idea.sources.map(source=>source.url).join(', ')}`).join('\n\n');
}
