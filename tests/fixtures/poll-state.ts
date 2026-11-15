import type {Page,ElectronApplication} from 'playwright';
import type {Snapshot} from '../../app/types';

// Test windows are often never shown, and a never-shown window does not advance CSS transitions: a row's 120 ms
// background fade stays at its start and a panel's entrance stays on its first frame, so Playwright never sees the
// element settle and every click waits out its timeout (2026-10-23). Test pages run without transitions, and keyframe
// animations finish at once (their names stay, so a test can still read which one ran).
const NO_TRANSITIONS='*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}';
export async function mainWindow(app:ElectronApplication){
  for(const end=Date.now()+30000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){
    const page=app.windows().find(view=>/index\.html$/.test(view.url()));
    if(page){await page.addStyleTag({content:NO_TRANSITIONS}).catch(()=>{});return page;}
  }
  throw Error('The main window did not open.');
}

// A hidden test window draws about one frame a second, sometimes none for seconds, and Playwright's click waits for
// the element to hold still across frames, so a click can wait out its timeout (settings-layout and chat-window,
// found 2026-11-15). One hidden screenshot taken with stayAwake makes a window draw 60 frames a second from then on.
// This wakes every open window and each window opened later; a test whose clicks stall calls it after mainWindow().
export async function wakeWindows(app:ElectronApplication){
  // No named function in here: the test loader wraps one in a helper the app's own process does not have.
  await app.evaluate(({app,BrowserWindow})=>{
    for(const view of BrowserWindow.getAllWindows())void view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).catch(()=>{});
    app.on('browser-window-created',(_event:unknown,view:any)=>{view.webContents.once('did-finish-load',()=>{void view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).catch(()=>{});});});
  });
}

// Playwright waitForFunction treats an async predicate's Promise as truthy before awaiting it.
export async function pollState(page:Page,ready:(state:Snapshot)=>boolean,timeout=90000){
  const end=Date.now()+timeout;
  do {
    const state=await page.evaluate(()=>window.desktop.invoke('state')) as Snapshot;
    if(ready(state))return state;
    await page.waitForTimeout(100);
  }while(Date.now()<end);
  throw Error('Timed out waiting for the expected app state');
}
