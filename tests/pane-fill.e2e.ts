import {pollState} from './fixtures/poll-state';
import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
// 10-20: his saved layout (chat 0.674, workspace 0.464) with the workspace hidden left the right third of the window
// empty at every size. The chat pane must reach the window's right edge.
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/pane-fill-')),namespace='Trismegistus/Test/'+path.basename(data);
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
try{
 const main=await app.firstWindow();main.setDefaultTimeout(15000);const call=(method:string,args:any={})=>main.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(main,state=>state.backend==='ready');await main.getByLabel('Close settings',{exact:true}).click();
 const tree={type:'split',id:'window-layout',orientation:'row',children:[{type:'group',id:'main-group',panes:['main'],active:'main'},{type:'group',id:'workspace-group',panes:['workspace'],active:'workspace'}],weights:[0.6737662846126894,0.46444760678734254]};
 await call('paneLayout',{tree,workspace:{visible:false,view:'tasks'}});await main.reload();await pollState(main,state=>state.backend==='ready'&&!!state.paneLayout);
 // The saved layout is in use (arranged), not the default one, whose weights are all 1.
 await main.waitForSelector('[data-group="main-group"].arranged',{state:'attached'});
 const sizes:Record<string,number>={};
 for(const [width,height] of [[900,650],[1400,900],[1900,1100]]){
  await app.evaluate(({BrowserWindow},[width,height])=>BrowserWindow.getAllWindows()[0].setContentSize(width,height),[width,height]);
  await main.waitForFunction(width=>document.documentElement.clientWidth===width,width);
  const edge=await main.evaluate(()=>{const pane=document.querySelector('[data-group="main-group"]')!.getBoundingClientRect(),chat=document.querySelector('.primary-chat-pane')!.getBoundingClientRect();return {pane:pane.right,chat:chat.right,window:document.documentElement.clientWidth};});
  assert.ok(Math.abs(edge.pane-edge.window)<=1&&Math.abs(edge.chat-edge.window)<=1,`at ${width}: chat ends at ${edge.chat}, window ${edge.window}`);
  sizes[width]=edge.chat;
 }
 console.log('PASS the chat reaches the right edge with the workspace hidden',JSON.stringify(sizes));
}finally{await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",namespace],{windowsHide:true});}
