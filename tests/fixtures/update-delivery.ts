import {app} from 'electron';
import electronUpdater from 'electron-updater';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {AppUpdates} from '../../app/updates';

// Real electron-updater HTTP, checksum, cache and quit handling. Only installer execution is intercepted.
const data=process.env.TRIS_UPDATE_TEST_DATA!,scenario=process.env.TRIS_UPDATE_TEST_SCENARIO!;
assert.ok(data&&path.basename(path.dirname(data)).startsWith('update-delivery-'));
app.setPath('userData',path.join(data,'profile'));
app.whenReady().then(async()=>{
 const bytes=Buffer.alloc(256*1024,42),sha512=createHash('sha512').update(bytes).digest('base64');
 let damaged=scenario==='retry',requests=0,installations=0,changes=0,failed=false;
 const feed=createServer((req,res)=>{
  if(req.url?.startsWith('/latest.yml')){res.end(`version: 9.9.9\nfiles:\n  - url: update.exe\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: update.exe\nsha512: ${sha512}\n`);return;}
  if(req.url==='/update.exe'){requests++;res.setHeader('Content-Length',bytes.length);res.end(damaged?Buffer.alloc(bytes.length,43):bytes);return;}
  res.writeHead(404).end();
 });
 await new Promise<void>(resolve=>feed.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+(feed.address() as {port:number}).port;
 const updater=electronUpdater.autoUpdater as electronUpdater.NsisUpdater;
 const config=path.join(data,'update.yml');updater.updateConfigPath=config;
 fs.writeFileSync(config,`updaterCacheDirName: delivery-cache\n`);
 updater.disableDifferentialDownload=true;updater.disableWebInstaller=true;updater.logger=null;
 (updater as any).doInstall=(options:any)=>{
  assert.equal(failed,false,'never install after a failed verification');
  assert.equal(options.isSilent,true,'ordinary quit installs silently');
  assert.equal(options.isForceRunAfter,false,'ordinary quit does not reopen the app');
  assert.equal(createHash('sha512').update(fs.readFileSync((updater as any).installerPath)).digest('base64'),sha512);
  installations++;return true;
 };
 (updater as any).spawnLog=()=>{throw Error('The test must never launch an installer');};
 const updates=new AppUpdates(url,scenario!=='build',()=>scenario==='automatic'?'automatic':'manual',()=>changes++,true);
 const quitListeners=app.listenerCount('quit');
 const receipt=()=>({scenario,requests,installations,changes,downloaded:updates.downloaded,status:updates.status});
 try{
  await updates.check();assert.equal(updates.available?.version,'9.9.9');
  if(scenario!=='automatic'){
   assert.equal(requests,0,'manual checks do not download');
   await updates.download();
  }else{
   const deadline=Date.now()+15000;
   while(!updates.downloaded&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(scenario==='build'){
   assert.equal(requests,0);assert.equal(updates.downloaded,false);assert.match(updates.status,/build folder/);
  }else{
   if(scenario==='retry'){
    assert.equal(updates.downloaded,false);assert.match(updates.status,/sha512|checksum/i);
    assert.equal(updater.autoInstallOnAppQuit,false,'a corrupt download cannot arm installation');
    assert.equal(app.listenerCount('quit'),quitListeners,'a failed download cannot register an install hook');
    damaged=false;await updates.download();
   }
   assert.equal(updates.downloaded,true);assert.match(updates.status,/is downloaded/);
   assert.equal(updater.autoInstallOnAppQuit,true);
   assert.equal(app.listenerCount('quit'),quitListeners+1,'verified download must register installation before ordinary quit');
   assert.equal(requests,scenario==='retry'?2:scenario==='cache'?0:1);
   await updates.download();assert.equal(requests,scenario==='retry'?2:scenario==='cache'?0:1,'duplicate download does not transfer again');
  }
  app.on('quit',()=>{
   assert.equal(installations,scenario==='build'?0:1,'ordinary quit installs a verified download exactly once');
   fs.writeFileSync(path.join(data,scenario+'.json'),JSON.stringify(receipt(),null,2));
  });
 }catch(error){failed=true;updater.autoInstallOnAppQuit=false;console.error(error);process.exitCode=1;}
 finally{feed.close();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
