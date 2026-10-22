import {chromium} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {getCurrentFuseWire,FuseV1Options} from '@electron/fuses';
import assert from 'node:assert/strict';

// The release disables the Node inspector. Exercise it through Chromium CDP,
// as repo-map-app.e2e does, without changing its executable or security fuses.
// hidden:false shows the window, as the source-mode test does, so page screenshots can paint.
export async function launchPackaged(env:NodeJS.ProcessEnv,{hidden=true}={}){
 const executable=process.env.TRISMEGISTUS_EXE!;assert.ok(executable);
 assert.equal((await getCurrentFuseWire(executable))[FuseV1Options.EnableNodeCliInspectArguments],48);
 const child=spawn(executable,[...hidden?['--hidden']:[],'--remote-debugging-port=0','--disable-renderer-backgrounding','--disable-background-timer-throttling'],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});
 const terminate=()=>{if(child.pid&&child.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}};
 try{
  const endpoint=await new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Packaged browser endpoint timed out')),60000);let output='';
   child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Packaged app exited: '+code));});
   child.stderr!.on('data',chunk=>{output=(output+chunk).slice(-16000);const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  const browser=await chromium.connectOverCDP(endpoint),context=browser.contexts()[0];
  const page=context.pages().find(page=>page.url().endsWith('index.html'))||await context.waitForEvent('page');await page.waitForURL(/index\.html$/);
  assert.match(page.url(),/\/resources\/app\.asar\/dist\/index\.html$/);
  return {page,close:async()=>{await browser.close().catch(()=>{});terminate();}};
 }catch(error){terminate();throw error;}
}
