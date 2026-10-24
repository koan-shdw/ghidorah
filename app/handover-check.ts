// Handover protocol part 3 (notes/HANDOVER-MODE-PLAN.md): Ghidorah checks the handover itself, so the drifted model
// is not the only judge of its own handover.
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Part 3, Ghidorah's own check beside START HANDOVER: it reports and never blocks. */
export async function checkHandover(text:string,folder:string){
 const spans=[...new Set([...text.matchAll(/`([^`\n]{2,200})`/g)].map(m=>m[1].trim()))];
 // A path has a slash or a file extension (a line number after it is dropped); `sidebar.fork` is a name, not a file.
 const isPath=(s:string)=>!/\s/.test(s)&&!/^[a-z]+:\/\//i.test(s)&&(/[\\/]/.test(s)||/\.(tsx?|[mc]?js|json|md|css|html?|py|ps1|cmd|bat|txt|ya?ml|toml|sqlite|png|svg|lock)$/i.test(s));
 const paths=[...new Set(spans.map(s=>s.replace(/:\d+(?::\d+)?$/,'')).filter(isPath))],missingPaths:string[]=[];
 for(const p of paths)await fs.access(path.resolve(folder,p)).catch(()=>missingPaths.push(p));
 const names=[...new Set(spans.filter(s=>!isPath(s.replace(/:\d+(?::\d+)?$/,''))&&/^[A-Za-z_$][\w$.]*(\(\))?$/.test(s)).map(s=>s.replace(/\(\)$/,'').split('.').at(-1)!).filter(s=>s.length>=3))].slice(0,40);
 const found=(name:string)=>new Promise<boolean|null>(resolve=>execFile('git',['grep','--untracked','-q','-F','-e',name],{cwd:folder,windowsHide:true,timeout:15000},error=>resolve(!error?true:(error as any).code===1?false:null)));
 const missingNames:string[]=[];let namesChecked=true;
 for(let i=0;i<names.length;i+=8)(await Promise.all(names.slice(i,i+8).map(found))).forEach((hit,j)=>{if(hit===false)missingNames.push(names[i+j]);if(hit===null)namesChecked=false;});
 // Claims are the bullets of the sections that state facts; Goal, rulings, next step and questions are his or open.
 let section='';const unmarked:string[]=[];
 for(const line of text.split(/\r?\n/)){
  const heading=/^\s*(?:#+\s*|\*\*)([^*#]+?)(?:\*\*)?\s*:?\s*$/.exec(line);if(heading){section=heading[1].toLowerCase();continue;}
  if(/goal|ruling|next step|open question|question/.test(section)||!/^\s*(?:[-*]|\d+\.)\s+\S/.test(line))continue;
  if(!/\b(PROVEN|OPEN)\b/.test(line))unmarked.push(line.trim().replace(/^(?:[-*]|\d+\.)\s+/,'').slice(0,120));
 }
 return {missingPaths,missingNames:namesChecked?missingNames:[],namesChecked,unmarked:unmarked.slice(0,20),unmarkedTotal:unmarked.length};
}
