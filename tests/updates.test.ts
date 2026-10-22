import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DatabaseSync} from 'node:sqlite';
import {compareVersions,unseenNotes,installedCopy,previousInstaller,backupChats,readUpdateWatch,markOpened,APP_FEED} from '../app/updates';
import {UpdateChip} from '../app/update-window';
import {withNotes,historyText} from '../scripts/release.mjs';
import whatsNew from '../app/whats-new.json';

fs.mkdirSync('work',{recursive:true});const work=fs.mkdtempSync(path.join(path.resolve('work'),'updates-'));

test('what\'s new: once per new version, never on a fresh profile, newest first',()=>{
 const history=[{version:'0.1.0',date:'1',notes:['a']},{version:'0.2.0',date:'2',notes:['b']},{version:'0.3.0',date:'3',notes:['c']}];
 assert.deepEqual(unseenNotes(history,undefined,'0.3.0'),[],'a profile with no last-seen version sees nothing');
 assert.deepEqual(unseenNotes(history,'0.3.0','0.3.0'),[]);
 assert.deepEqual(unseenNotes(history,'0.1.0','0.3.0').map(row=>row.version),['0.3.0','0.2.0']);
 assert.deepEqual(unseenNotes(history,'0.1.0','0.2.0').map(row=>row.version),['0.2.0'],'notes for versions not yet installed stay hidden');
 assert.equal(compareVersions('v0.10.0','0.9.9'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);assert.equal(compareVersions('0.1.0','0.2.0'),-1);
});

test('the news holds every version from 0.1.0 on, oldest first, each with lines',()=>{
 const versions=whatsNew.map(entry=>entry.version);
 assert.equal(versions[0],'0.1.0');
 for(let i=1;i<versions.length;i++)assert.equal(compareVersions(versions[i],versions[i-1]),1,versions[i]+' follows '+versions[i-1]);
 for(let minor=0;minor<=20;minor++)assert.ok(versions.includes('0.1.'+minor),'0.1.'+minor+' has notes');
 assert.ok(whatsNew.every(entry=>/^\d{4}-\d\d-\d\d$/.test(entry.date)&&entry.notes.length&&entry.notes.every(note=>note&&!note.includes('—'))));
});

test('an installed copy is one with the installer\'s uninstaller beside it, in any folder',()=>{
 const picked=path.join(work,'I-APPS','Ghidorah'),build=path.join(work,'updates','current');
 for(const dir of [picked,build]){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'Ghidorah.exe'),'');}
 fs.writeFileSync(path.join(picked,'Uninstall Ghidorah.exe'),'');
 assert.equal(installedCopy(path.join(picked,'Ghidorah.exe'),true),true);
 assert.equal(installedCopy(path.join(picked,'Ghidorah.exe'),false),false,'a source run never installs');
 assert.equal(installedCopy(path.join(build,'Ghidorah.exe'),true),false,'a build folder cannot replace itself');
});

test('a rollback takes the version before from the releases page, or from beside a test feed',()=>{
 assert.equal(previousInstaller(APP_FEED,'0.1.20'),'https://github.com/koan-shdw/ghidorah/releases/download/v0.1.20/Ghidorah-0.1.20-Setup.exe');
 assert.equal(previousInstaller('http://127.0.0.1:5000/feed/','0.1.20'),'http://127.0.0.1:5000/feed/Ghidorah-0.1.20-Setup.exe');
});

test('chats are copied before every install; the newest three copies stay',()=>{
 const db=new DatabaseSync(path.join(work,'chat.sqlite'));db.exec("PRAGMA journal_mode=WAL;CREATE TABLE records(kind,id,data);INSERT INTO records VALUES('chat','a','{}')");
 const folder=path.join(work,'backups'),copies:string[]=[];
 for(let i=0;i<5;i++)copies.push(backupChats(db,folder,'0.1.'+(20+i),new Date(Date.UTC(2026,9,23,10,i))));
 db.close();
 assert.deepEqual(fs.readdirSync(folder).sort(),copies.slice(2).map(file=>path.basename(file)).sort());
 assert.match(path.basename(copies[4]),/^2026-10-23T10-04-00-000Z_v0\.1\.24_chat\.sqlite$/);
 const copy=new DatabaseSync(copies[4]);assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM records').get() as any).n,1,'the copy is a whole database');copy.close();
});

test('the new version marks only its own install as opened, and reads a watch file PowerShell wrote',()=>{
 const file=path.join(work,'update-watch.json'),watch={pid:1,from:'0.1.20',to:'0.1.21',dir:'I:\\APPS\\Ghidorah',exe:'I:\\APPS\\Ghidorah\\Ghidorah.exe',installer:'x',previous:'y',restart:true};
 fs.writeFileSync(file,'\uFEFF'+JSON.stringify(watch));
 markOpened(file,'0.1.20');assert.equal(readUpdateWatch(file)?.opened,undefined,'the version before is not the new one');
 markOpened(file,'0.1.21');assert.equal(readUpdateWatch(file)?.opened,true);
 assert.equal(readUpdateWatch(path.join(work,'none.json')),null);
});

test('the title bar chip: updating, restart to update, update failed, and nothing otherwise',()=>{
 const chip=(updates:any)=>renderToStaticMarkup(React.createElement(UpdateChip,{state:{updates} as any,call:async()=>{}}));
 const base={current:'0.1.20',available:{version:'0.1.21',notes:''},downloaded:false,downloading:false,failed:''};
 assert.match(chip({...base,downloading:true,percent:42}),/updating 42%/);
 assert.match(chip({...base,downloaded:true}),/class="update-chip ready"[^>]*>.*restart to update \(0\.1\.21\)/);
 assert.match(chip({...base,failed:"Couldn't download 0.1.21."}),/update failed/);
 assert.equal(chip({...base,available:null}),'');assert.equal(chip(base),'','an available version waiting for Download update shows no chip');
});

test('a release writes its notes into the history; a version already written keeps its notes',()=>{
 const history=[{version:'0.1.9',date:'1',notes:['a']},{version:'0.1.10',date:'2',notes:['b']}];
 assert.deepEqual(withNotes(history,'0.1.11',['c'],'3').map(row=>row.version),['0.1.9','0.1.10','0.1.11']);
 assert.deepEqual(withNotes(history,'0.1.10',[],'4').at(-1),{version:'0.1.10',date:'4',notes:['b']});
 assert.throws(()=>withNotes(history,'0.1.11',[],'3'),/Write what changed/);
 assert.deepEqual(JSON.parse(historyText(whatsNew)),whatsNew);
 assert.equal(fs.readFileSync(path.resolve('app/whats-new.json'),'utf8').replace(/\r\n/g,'\n'),historyText(whatsNew),'the history file is written the way a release writes it');
});
