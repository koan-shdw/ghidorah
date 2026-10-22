import type {Page,ElectronApplication} from 'playwright';
import type {Snapshot} from '../../app/types';

export async function mainWindow(app:ElectronApplication){
  for(const end=Date.now()+30000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){
    const page=app.windows().find(view=>/index\.html$/.test(view.url()));if(page)return page;
  }
  throw Error('The main window did not open.');
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
