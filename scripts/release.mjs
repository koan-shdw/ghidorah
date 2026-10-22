// "push it" on Ghidorah, in two steps with the release checks between them.
// npm run release -- [patch|minor|major] "What changed" ... cuts the next version from a clean commit: bumps the version,
// writes the notes into app/whats-new.json (a version already written there keeps its notes when none are given), packs,
// hardens and builds the checked installer (scripts/installer.mjs), then commits "Ghidorah X" with a local tag vX.
// npm run release -- --publish then pushes main and the tag to koan-shdw/ghidorah and puts that version on its Releases:
// Ghidorah-X-Setup.exe, the same file as Ghidorah-Windows-Setup.exe for the download button, latest.yml and the
// blockmap. Installed copies find it there and update themselves.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const RELEASES='koan-shdw/ghidorah';
const byVersion=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
/** The release history with this version's notes: new notes replace the entry; none keep the written ones. */
export function withNotes(history,version,notes,date){
 const written=history.find(entry=>entry.version===version);
 if(!notes.length&&!written)throw Error(`Write what changed: npm run release -- "What changed" ...`);
 return [...history.filter(entry=>entry.version!==version),{version,date,notes:notes.length?notes:written.notes}].sort((a,b)=>byVersion(a.version,b.version));
}
/** app/whats-new.json as it is written by hand: one version a line, one note a line. */
export const historyText=history=>'[\n'+history.map(entry=>`  {"version":${JSON.stringify(entry.version)},"date":${JSON.stringify(entry.date)},"notes":[\n    `+entry.notes.map(note=>JSON.stringify(note)).join(',\n    ')+'\n  ]}').join(',\n')+'\n]\n';

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=path.resolve(import.meta.dirname,'..'),installers=path.join(root,'updates','installer'),history=path.join(root,'app','whats-new.json');
 const run=(command,args)=>execFileSync(command,args,{cwd:root,stdio:'inherit',shell:command==='npm',windowsHide:true});
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 const args=process.argv.slice(2),flags=['patch','minor','major','--publish'];
 const bump=['patch','minor','major'].find(level=>args.includes(level))||'patch',publish=args.includes('--publish'),notes=args.filter(arg=>!flags.includes(arg));
 if(git('status','--porcelain'))throw Error('Commit the changes first: a release is built from a commit.');
 const current=()=>JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
 if(!publish){
  run('npm',['version',bump,'--no-git-tag-version']);
  const version=current();
  try{
   fs.writeFileSync(history,historyText(withNotes(JSON.parse(fs.readFileSync(history,'utf8')),version,notes,new Date().toISOString().slice(0,10))));
   fs.rmSync(path.join(root,'updates','build'),{recursive:true,force:true});fs.rmSync(installers,{recursive:true,force:true});
   run('npm',['run','pack']);
   run(process.execPath,['scripts/harden.mjs','updates/build/win-unpacked/Ghidorah.exe']);
   run(process.execPath,['scripts/installer.mjs']);
  }catch(error){git('checkout','package.json','package-lock.json','app/whats-new.json');throw error;}
  run('git',['commit','-qam','Ghidorah '+version]);run('git',['tag','v'+version]);
  console.log(`Ghidorah ${version} is cut: updates\\installer\\Ghidorah-${version}-Setup.exe (tag v${version}). Run the release checks on updates\\build\\win-unpacked\\Ghidorah.exe, then npm run release -- --publish.`);
 }else{
  // Publishes the version that was cut and checked: its tag and its installer must be here.
  const version=current(),installer=path.join(installers,`Ghidorah-${version}-Setup.exe`);
  if(git('tag','-l','v'+version)!=='v'+version||!fs.existsSync(installer))throw Error(`Cut ${version} first: npm run release -- "What changed" ...`);
  const button=path.join(installers,'Ghidorah-Windows-Setup.exe');fs.copyFileSync(installer,button);
  const entry=JSON.parse(fs.readFileSync(history,'utf8')).find(row=>row.version===version);
  run('git',['push','origin','HEAD:main','v'+version]);
  run('gh',['release','create','v'+version,'--repo',RELEASES,'--title','Ghidorah '+version,'--notes',entry.notes.map(note=>'- '+note).join('\n'),installer,button,installer+'.blockmap',path.join(installers,'latest.yml')]);
  console.log(`Published on https://github.com/${RELEASES}/releases/tag/v${version}`);
 }
}
