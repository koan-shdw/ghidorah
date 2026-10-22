// The "update" window's main side (5c, 5e) and the title bar chip. App updates work like Video Dancer's and KOAN.live's:
// electron-updater reads the public releases repo, downloads in the background and installs on Restart to update or on
// quit, never by itself. Only an installed copy can update itself. Before an install the chats are copied, and a watcher
// outside the app (scripts/update-watch.ps1) puts the version before back if the new one does not open.
import electronUpdater from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {compare} from 'semver';

export const APP_FEED={provider:'github' as const,owner:'koan-shdw',repo:'ghidorah'};
export type Feed=string|typeof APP_FEED;
export type UpdateMode='manual'|'automatic';
export interface WhatsNew {version:string;date:string;notes:string[]}
export function compareVersions(a:string,b:string){return compare(a,b);}
// What's new shows once per new version, and never on a profile that has no last-seen version yet.
export function unseenNotes(history:WhatsNew[],lastSeen:string|undefined,current:string){
 if(!lastSeen||lastSeen===current)return [];
 return history.filter(entry=>compareVersions(entry.version,lastSeen)>0&&compareVersions(entry.version,current)<=0).sort((a,b)=>compareVersions(b.version,a.version));
}
// An installed copy has the installer's uninstaller beside it, in whatever folder was picked; a build folder cannot
// replace itself.
export const installedCopy=(exe:string,packaged:boolean)=>packaged&&fs.existsSync(path.join(path.dirname(exe),'Uninstall Ghidorah.exe'));
// The version before, for a rollback: its installer on the releases page, or beside a test feed.
export const previousInstaller=(feed:Feed,version:string)=>(typeof feed==='string'?feed.replace(/\/+$/,''):`https://github.com/${feed.owner}/${feed.repo}/releases/download/v${version}`)+`/Ghidorah-${version}-Setup.exe`;
// A copy of the chats before every install (a consistent snapshot, taken while the app is open); the newest three stay.
export function backupChats(db:DatabaseSync,folder:string,version:string,now=new Date()){
 fs.mkdirSync(folder,{recursive:true});
 const file=path.join(folder,now.toISOString().replace(/[:.]/g,'-')+'_v'+version+'_chat.sqlite');
 db.exec(`VACUUM INTO '${file.replace(/'/g,"''")}'`);
 for(const old of fs.readdirSync(folder).filter(name=>name.endsWith('_chat.sqlite')).sort().reverse().slice(3))fs.rmSync(path.join(folder,old),{force:true});
 return file;
}
// One install as the watcher sees it. The new version sets opened once its window has loaded; the watcher sets
// rolledBack after putting the version before back, and that version's update window says so.
// hidden: the main window was hidden at the install (Ghidorah running in the background), so it comes back hidden.
export interface UpdateWatch {pid:number;from:string;to:string;dir:string;exe:string;installer:string;previous:string;restart:boolean;hidden:boolean;opened?:boolean;rolledBack?:boolean}
export function readUpdateWatch(file:string):UpdateWatch|null{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));}catch{return null;}}
export function markOpened(file:string,version:string){const watch=readUpdateWatch(file);if(watch&&watch.to===version&&!watch.opened)fs.writeFileSync(file,JSON.stringify({...watch,opened:true}));}

/** C19: a failed update check in plain words; the release server's own message is not shown. */
export function updateCheckFailure(error:unknown){
 const message=String((error as any)?.message||error);
 return /404|latest\.yml|Cannot find channel|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message)?"Couldn't check for app updates: the release server didn't answer. Check again later.":"Couldn't check for app updates. Check again later.";
}
// Being offline is not a failed update, so it never turns the chip red.
const offline=(error:unknown)=>/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRE|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION/i.test(String((error as any)?.message||error));
export class AppUpdates{
 status='';available:{version:string;notes:string}|null=null;downloaded=false;checking=false;
 private updater=electronUpdater.autoUpdater;
 downloading=false;percent:number|null=null;failed='';
 // skipped: a version that did not open last time; it waits for Download update instead of coming by itself.
 constructor(private feed:Feed,private canInstall:boolean,private mode:()=>UpdateMode,private changed:()=>void,test=false,private skipped:()=>string|undefined=()=>undefined){
  if(!feed){this.status='No update feed yet. Updates start once the GitHub repository exists.';return;}
  this.updater.setFeedURL(typeof feed==='string'?{provider:'generic',url:feed}:feed);this.updater.autoDownload=false;this.updater.autoInstallOnAppQuit=false;
  // Source tests can read a local feed; build-folder copies still cannot install updates.
  if(test)this.updater.forceDevUpdateConfig=true;
  this.updater.on('update-available',info=>{
   if(this.available?.version!==info.version)this.downloaded=false;
   this.available={version:info.version,notes:typeof info.releaseNotes==='string'?info.releaseNotes:Array.isArray(info.releaseNotes)?info.releaseNotes.map(note=>note.note).join('\n'):''};
   const skip=info.version===this.skipped();this.status=skip?info.version+" didn't open last time, so it waits: Download update tries it again.":'Version '+info.version+' is available.';this.changed();
   if(this.mode()==='automatic'&&this.canInstall&&!skip)void this.download();
  });
  this.updater.on('update-not-available',()=>{this.available=null;this.failed='';this.status='Up to date.';this.changed();});
  this.updater.on('download-progress',progress=>{this.percent=Math.round(progress.percent);this.status='Downloading '+(this.available?.version||'')+' · '+this.percent+'%';this.changed();});
  // electron-updater registers its quit hook immediately after this event, before downloadUpdate resolves.
  this.updater.on('update-downloaded',info=>{this.updater.autoInstallOnAppQuit=true;this.downloaded=true;this.failed='';this.status=info.version+' is downloaded. Restart to update, or it installs when you quit.';this.changed();});
  this.updater.on('error',error=>{this.status=updateCheckFailure(error);this.failed=offline(error)?'':this.status;this.checking=false;this.changed();});
 }
 // Checks 4 s after start, then every 3 hours.
 start(){setTimeout(()=>void this.check(),4000);setInterval(()=>void this.check(),3*60*60*1000);}
 async check(){
  if(this.checking||this.downloading||this.downloaded)return;
  if(!this.feed){this.changed();return;}
  this.checking=true;this.status='Checking for updates…';this.changed();
  try{await this.updater.checkForUpdates();}catch(error){this.status=updateCheckFailure(error);this.failed=offline(error)?'':this.status;}finally{this.checking=false;this.changed();}
 }
 async download(){
  if(!this.feed||!this.available||this.downloading||this.downloaded)return;
  if(!this.canInstall){this.status='This copy runs from a build folder, so it cannot update itself. Install Ghidorah to get updates.';this.changed();return;}
  this.downloading=true;this.percent=0;this.status='Downloading '+this.available.version+'…';this.changed();
  try{await this.updater.downloadUpdate();}
  catch(error){this.status="Couldn't download "+this.available.version+': '+String((error as any)?.message||error).slice(0,200);this.failed=offline(error)?'':this.status;}
  finally{this.downloading=false;this.percent=null;this.changed();}
 }
 /** The downloaded installer, which the watcher waits on. */
 get installer():string{return (this.updater as any).installerPath||'';}
 /** Restart to update: a silent install; the watcher opens the new version (the installer's own reopen goes through
  * the Start Menu shortcut, whatever it points at). */
 restart(){if(this.downloaded)this.updater.quitAndInstall(true,false);}
}

// Hermes release notice (5e): NousResearch/hermes-agent's releases, newer than the pinned one.
export const HERMES_RELEASES='https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=10';
export interface HermesRelease {tag:string;name:string;published:string;notes:string;url:string}
export async function hermesReleases(feed=HERMES_RELEASES,signal?:AbortSignal):Promise<HermesRelease[]>{
 const response=await fetch(feed,{headers:{Accept:'application/vnd.github+json'},redirect:'follow',signal:signal||AbortSignal.timeout(20000)});
 if(!response.ok)throw Object.assign(Error('Hermes releases are unavailable (HTTP '+response.status+').'),{status:response.status});
 const rows=await response.json();if(!Array.isArray(rows))throw Error('Hermes releases are unavailable.');
 return rows.filter((row:any)=>!row?.draft&&!row?.prerelease&&typeof row?.tag_name==='string').map((row:any)=>({tag:row.tag_name,name:String(row.name||row.tag_name).slice(0,200),published:String(row.published_at||''),notes:String(row.body||'').slice(0,20000),url:String(row.html_url||'')}));
}
export const newerReleases=(releases:HermesRelease[],pinned:{tag:string;published:string})=>releases.filter(row=>row.tag!==pinned.tag&&row.published>pinned.published);
