// connections handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {apiSuppliers,isApiProvider} from '../../api-catalog';
import {imageSettings} from '../../images';
import {apiChanging,apiProviders,backend,background,checkAccount,checkClaude,checkCodex,codex,connected,emit,gliner,handlers,health,jevControllers,native,pickerKeyNames,pickerKeyStatus,pickerKeys,signOutCodex,startBackend,store,win} from '../../main';
import {providerFor} from '../../models';
import {PickerId,isPicker,picker} from '../../pickers';
import type {Chat,Turn} from '../../types';
import {projectSettingsReview,trustRecord} from '../accounts';
import {defaultFolder,defaultModels,favouriteModels} from '../apps';
import {availableModels,connectedModels,fixtureClaude} from '../models';
import {projectFor,workingDirectory} from '../projects';
import {hasWork} from '../turns';
import {shell} from 'electron';

export const connectionsHandlers:Record<string,(args:any)=>any>={
  async codexDisconnect(){await signOutCodex();},
  async nousLogin(){
    if(hasWork()||apiChanging)throw Error('Wait for active work or connection changes to finish before signing in.');
    if(backend.loginChild)throw Error('Finish or cancel the open sign-in first.');
    const provider='nous';
    apiProviders.loginState('Starting sign-in…',null,provider);
    backend.startCodexLogin(event=>{
      if(event.type==='device')apiProviders.loginState('Waiting for sign-in',{url:event.url,code:event.code},provider);
      else if(event.type==='connected'){
        apiProviders.forget(provider);health.clear(provider,['auth','billing','limit','model'],Date.now());
        apiProviders.loginState('Checking connection…',null,provider);
        void handlers.restart({}).catch((error:unknown)=>apiProviders.loginState(backend.scrubber.text(String(error)),null,provider));
      }else apiProviders.loginState(event.type==='error'?event.message:'Sign-in cancelled',null,provider);
    },'nous');
  },
  nousCancel(){backend.cancelCodexLogin('nous');apiProviders.loginState('Sign-in cancelled',null,'nous');},
  async nousOpen(){const login=apiProviders.rows().find(row=>row.provider==='nous')?.login;if(!login)throw Error('Start sign-in first.');await shell.openExternal(login.url);},
  async openrouterLogin(){
    if(hasWork()||apiChanging)throw Error('Wait for active work or connection changes to finish before signing in.');
    if(backend.loginChild)throw Error('Finish or cancel the open sign-in first.');
    const provider='openrouter-api';
    apiProviders.loginState('Starting sign-in…',null,provider);
    backend.startCodexLogin(event=>{
      if(event.type==='device')apiProviders.loginState('Waiting for sign-in',{url:event.url,code:event.code},provider);
      else if(event.type==='connected'){
        apiProviders.forget(provider);health.clear(provider,['auth','billing','limit','model'],Date.now());
        apiProviders.loginState('Checking connection…',null,provider);
        void handlers.restart({}).catch((error:unknown)=>apiProviders.loginState(backend.scrubber.text(String(error)),null,provider));
      }else apiProviders.loginState(event.type==='error'?event.message:'Sign-in cancelled',null,provider);
    },'openrouter');
  },
  openrouterCancel(){backend.cancelCodexLogin('openrouter');apiProviders.loginState('Sign-in cancelled',null,'openrouter-api');},
  async openrouterOpen(){const login=apiProviders.rows().find(row=>row.provider==='openrouter-api')?.login;if(!login)throw Error('Start sign-in first.');await shell.openExternal(login.url);},
  async minimaxLogin({region='global'}){
    if(region!=='global'&&region!=='cn')throw Error('Choose Global or China.');
    if(hasWork()||apiChanging)throw Error('Wait for active work or connection changes to finish before signing in.');
    if(backend.loginChild)throw Error('Finish or cancel the open sign-in first.');
    apiProviders.loginState('Starting sign-in…',null,'minimax-oauth');
    backend.startCodexLogin(event=>{
      if(event.type==='device')apiProviders.loginState('Waiting for sign-in',{url:event.url,code:event.code},'minimax-oauth');
      else if(event.type==='connected'){
        apiProviders.forget('minimax-oauth');health.clear('minimax-oauth',['auth','billing','limit','model'],Date.now());
        apiProviders.loginState('Checking connection…',null,'minimax-oauth');
        void handlers.restart({}).catch((error:unknown)=>apiProviders.loginState(backend.scrubber.text(String(error)),null,'minimax-oauth'));
      }else apiProviders.loginState(event.type==='error'?event.message:'Sign-in cancelled',null,'minimax-oauth');
    },'minimax',region);
  },
  minimaxCancel(){backend.cancelCodexLogin('minimax');apiProviders.loginState('Sign-in cancelled',null,'minimax-oauth');},
  async minimaxOpen(){const login=apiProviders.rows().find(row=>row.provider==='minimax-oauth')?.login;if(!login)throw Error('Start sign-in first.');await shell.openExternal(login.url);},
  async grokLogin(){
    if(hasWork()||apiChanging)throw Error('Wait for active work or connection changes to finish before signing in.');
    if(backend.loginChild)throw Error('Finish or cancel the open sign-in first.');
    apiProviders.loginState('Starting sign-in…');
    backend.startCodexLogin(event=>{
      if(event.type==='device')apiProviders.loginState('Waiting for sign-in',{url:event.url,code:event.code});
      else if(event.type==='connected'){
        apiProviders.forget('xai-oauth');health.clear('xai-oauth',['auth','billing','limit','model'],Date.now());
        apiProviders.loginState('Checking connection…');
        void handlers.restart({}).catch((error:unknown)=>apiProviders.loginState(backend.scrubber.text(String(error))));
      }else apiProviders.loginState(event.type==='error'?event.message:'Sign-in cancelled');
    },'grok');
  },
  grokCancel(){backend.cancelCodexLogin('grok');apiProviders.loginState('Sign-in cancelled');},
  async grokOpen(){const login=apiProviders.rows().find(row=>row.provider==='xai-oauth')?.login;if(!login)throw Error('Start sign-in first.');await shell.openExternal(login.url);},
  async codexCheck(){await checkCodex();},
  async claudeCheck(){await checkClaude();},
  async projectTrustReview({chatId}={}){const folder=chatId?workingDirectory(projectFor(store.get<Chat>('chat',chatId))):defaultFolder();if(!folder)throw Error('Choose the root working folder first.');const {definitions,...review}=await projectSettingsReview(folder);return backend.scrubber.value({...review,trusted:!!review.hash&&trustRecord(review.folder)?.hash===review.hash});},
  async projectTrust({hash,enabled,chatId}){
    if(hasWork())throw Error('Wait for active work before changing project trust.');
    const folder=chatId?workingDirectory(projectFor(store.get<Chat>('chat',chatId))):defaultFolder();if(!folder)throw Error('Choose the root working folder first.');
    const review=await projectSettingsReview(folder);
    if(enabled&&(review.error||review.hash!==hash))throw Error(review.error||'Project settings changed. Review them again.');
    store.put('trust',{id:'root:'+review.folder,folder:review.folder,hash:enabled?review.hash:'',skillFolders:review.skillFolders});emit();
  },
  async codexOpen(){if(!codex.login)throw Error('Start sign-in first.');await shell.openExternal('https://auth.openai.com/codex/device');},
  addModel({chatId,model}){if(!connectedModels().includes(model))throw Error('Connect this model first.');const c=store.get<Chat>('chat',chatId);store.update<Chat>('chat',chatId,{pool:[...new Set([...(c.pool||['deepseek-flash']),model])],efforts:{...c.efforts,[model]:c.efforts?.[model]||'high'}});emit();},
  removeModel({chatId,model}){const c=store.get<Chat>('chat',chatId);if([...background.rows(),...native.rows()].some(row=>(row.chatId===chatId||store.get<Chat>('chat',row.chatId).parentChatId===chatId)&&['running','checking','stopping'].includes(row.status)&&store.get<Turn>('turn',row.turnId).model===model))throw Error('Stop this model’s background work before removing it.');if(store.all<Turn>('turn').some(t=>(t.chatId===chatId||store.get<Chat>('chat',t.chatId).parentChatId===chatId)&&(t.models||[t.model]).includes(model)&&['queued','running','waiting','dispatching','stopping'].includes(t.status)))throw Error('Stop this model’s work before removing it.');const selectedModels=(c.selectedModels||(c.selected?['deepseek-flash']:[])).filter(id=>id!==model);store.update<Chat>('chat',chatId,{pool:(c.pool||['deepseek-flash']).filter(id=>id!==model),selectedModels,selected:selectedModels.includes('deepseek-flash'),lockedModel:c.lockedModel===model?null:c.lockedModel,selector:c.selector===model?null:c.selector});emit();},
  favouriteModel({model,enabled}){providerFor(model);if(typeof enabled!=='boolean'||enabled&&!connectedModels().includes(model))throw Error('Connect this model first.');const models=enabled?[...new Set([...favouriteModels(),model])]:favouriteModels().filter(id=>id!==model);store.put('settings',{id:'favourite-models',models});emit();},
  defaultPermissionMode({mode}){if(mode===undefined)throw Error('Choose a permission mode.');store.defaultMode(mode);emit();},
  defaultModel({model,enabled}){providerFor(model);if(typeof enabled!=='boolean'||enabled&&!connectedModels().includes(model))throw Error('Connect this model first.');const models=enabled?[...new Set([...defaultModels(),model])]:defaultModels().filter(m=>m!==model);store.put('settings',{id:'default-models',models});emit();},
  async checkAccount(){const credential=await backend.host('read_key');if(credential.key)await checkAccount(credential.key);},
  decisionEngine({engine}){if(!isPicker(engine))throw Error('Choose a listed picker.');if(jevControllers.size)throw Error('Wait for model selection to finish.');store.put('settings',{id:'decision-engine',engine});if(engine!=='gliner')gliner.unload();emit();},
  async pickerKeySave({id,key}){const provider=pickerKeyNames[id as PickerId];if(!provider)throw Error('Unknown picker.');if(jevControllers.size)throw Error('Wait for model selection to finish.');if(typeof key!=='string'||!key.trim())throw Error('Enter a key.');await backend.host('save_key',{provider,key});pickerKeys[id as PickerId]=key.trim();backend.scrubber.register(key.trim());delete pickerKeyStatus[id as PickerId];emit();},
  async pickerKeyDelete({id}){const provider=pickerKeyNames[id as PickerId];if(!provider)throw Error('Unknown picker.');if(jevControllers.size)throw Error('Wait for model selection to finish.');await backend.host('delete_key',{provider});pickerKeys[id as PickerId]=null;delete pickerKeyStatus[id as PickerId];emit();},
  pickerSave({id,summaryModel,confidence,timeoutMs}){if(!isPicker(id)||id==='jev')throw Error('Unknown picker.');if(jevControllers.size)throw Error('Wait for model selection to finish.');if(!availableModels().includes(summaryModel)||typeof confidence!=='number'||!Number.isFinite(confidence)||confidence<0||confidence>1||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>(id==='glide'?300000:60000))throw Error('Check the '+picker(id)!.short+' settings.');store.put('settings',{...store.all<any>('settings').find(row=>row.id===id),id,summaryModel,confidence,timeoutMs});emit();},
  async glinerInstall(){if(jevControllers.size)throw Error('Wait for model selection to finish.');await gliner.install();await gliner.check();},
  glinerCancel(){gliner.cancelInstall();},
  async glinerCheck(){return await gliner.check();},
  imageSettings(args:any={}){return imageSettings(store,backend,args.selection);},
  openConnections(){win.show();win.focus();win.webContents.send('open-connections');},
  async refreshUsage(){await Promise.allSettled([...apiProviders.rows().filter(row=>row.connected).map(row=>apiProviders.check(row.provider)),...(connected?[handlers.checkAccount({})]:[]),checkCodex(),...(!process.env.TRISMEGISTUS_TEST_DATA||fixtureClaude()?[checkClaude()]:[])]);},
  apiCheck:({provider})=>apiProviders.check(provider),
  apiRetry({provider}){if(!isApiProvider(provider))throw Error('Unknown supplier.');health.clear(provider,['billing','limit','model'],Date.now());const row=apiProviders.rows().find(row=>row.provider===provider);if(row?.connected)row.status='Unverified · ready to retry';emit();},
  apiModel:({provider,model})=>apiProviders.addNamedModel(provider,model),
  async apiLink({provider}){if(!isApiProvider(provider))throw Error('Unknown supplier.');await shell.openExternal(apiSuppliers[provider].keys);},
  async saveKey({key}){if(hasWork())throw Error('Wait for active work to finish before changing the key.');if(typeof key!=='string')throw Error('Invalid key');backend.scrubber.register(key.trim());await backend.host('save_key',{key});await backend.stop();for(const c of store.all<Chat>('chat'))store.update<Chat>('chat',c.id,{runtimeId:null});await startBackend();return true;}
};
