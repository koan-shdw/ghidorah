// How a desktop test reaches the chat's controls since they moved (Koan 2026-11-19): the + menu and the Options menu
// inside the message box, and the Workspace switch in the chat's title bar. `scope` is a page or a region of one.
import type {Locator,Page} from 'playwright';

type Scope=Page|Locator;
const press=(target:Locator)=>target.first().evaluate((element:HTMLElement)=>element.click());

/** Opens the chat's Options menu (View, Send now, Wake-ups, RLM history, Auto-compact, Speak replies, Connections)
 * if it is closed, so its controls can be seen and clicked. */
export async function chatOptions(scope:Scope){
 const menu=scope.locator('details.chat-options').first();await menu.waitFor({state:'attached'});
 if(!await menu.evaluate((element:HTMLDetailsElement)=>element.open))await press(menu.locator('summary'));
 return menu;
}
/** Closes the Options menu again. */
export async function closeChatOptions(scope:Scope){
 const menu=scope.locator('details.chat-options').first();
 if(await menu.evaluate((element:HTMLDetailsElement)=>element.open))await press(menu.locator('summary'));
}
/** Picks a row of the message box's + menu: 'Attach files', 'Skills and commands', 'Side chat', 'Voice helper', 'Add a model'. */
export async function addMenu(scope:Scope,row:string){
 const add=scope.getByLabel('Add',{exact:true}).first();await add.waitFor();
 if(await add.getAttribute('aria-expanded')!=='true')await press(add);
 await press(scope.getByRole('menuitem',{name:row,exact:true}));
}
/** The chat's view as its Options menu shows it: 'normal', 'thinking' or 'verbose'. Readable while the menu is closed. */
export function chatView(scope:Scope){return scope.locator('.chat-view-tabs [aria-pressed=true]').first().evaluate((element:HTMLElement)=>(element.textContent||'').trim().toLowerCase());}
/** Sets the chat's view from its Options menu. */
export async function setChatView(scope:Scope,view:'normal'|'thinking'|'verbose'){await press(scope.locator('.chat-view-tabs button').filter({hasText:new RegExp('^'+view+'$','i')}));}

const tools={files:'Files',changes:'Changes',terminal:'Terminal',preview:'Preview'} as const;
/** Opens the Workspace panel from the title bar's switch if it is closed. 'plan' and 'tasks' are sections of the
 * panel; the other four are tools, opened by their row in the panel's Tools section. */
export async function openWorkspace(scope:Scope,view:'plan'|'tasks'|keyof typeof tools){
 const button=scope.getByRole('button',{name:'Workspace',exact:true}).first();await button.waitFor();
 if(await button.getAttribute('aria-pressed')!=='true')await press(button);
 const page='page' in scope?scope.page():scope,panel=page.getByRole('complementary',{name:'Workspace',exact:true});await panel.waitFor();
 // A tool may be open in the sections' place: go back to them first.
 const back=panel.locator('.ws-back button').filter({hasText:'Workspace'});
 if(await back.count()&&view in tools&&await panel.locator('.ws-back strong').first().textContent()===tools[view as keyof typeof tools])return;
 if(await back.count())await press(back);
 await panel.locator('.ws-sec').first().waitFor();
 if(view in tools)await press(panel.locator('[data-section="tools"] [data-open="'+view+'"]'));
}
/** Picks a model for the next message: by its chip, or from the one folded chip's menu when the chat has more models
 * than fit in the message box. */
export async function pickModel(scope:Scope,label:string){
 const chip=scope.locator('.model-tab').filter({hasText:label});
 if(await chip.count()){await press(chip);return;}
 const page='page' in scope?scope.page():scope;
 await press(scope.getByLabel('Models in this chat',{exact:true}));
 await press(page.getByRole('menuitem').filter({hasText:label}));
}
/** Opens a model chip's right-click menu, at the chip, and returns its item, such as 'Remove from chat'. */
export async function modelMenuItem(scope:Scope,model:string,item:string|RegExp){
 const page='page' in scope?scope.page():scope,chip=scope.locator('.model-pill:not(.jev)').filter({hasText:model}).first();
 const at=await chip.evaluate((element:HTMLElement)=>{const box=element.getBoundingClientRect();return {clientX:Math.round(box.left+box.width/2),clientY:Math.round(box.top+box.height/2)};});
 await chip.dispatchEvent('contextmenu',{bubbles:true,cancelable:true,...at});
 return page.getByRole('menuitem',{name:item}).first();
}
/** Removes a model from the chat by its chip's right-click menu (the hover × is gone since 2026-11-19). */
export async function removeModel(scope:Scope,model:string){await press(await modelMenuItem(scope,model,'Remove from chat'));}
