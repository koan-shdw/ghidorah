// plugins handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import artFonts from '../../../third-party/taag/fonts.json';
import {backend,data,emit,handlers,mcp,mcpLogins,mcpRows,namespace,pluginChanges,pluginReviews,pluginRuntime,queuePluginChange,refreshMcp,store} from '../../main';
import {NativePluginInstall,hermesPluginKey,installNativePlugin,nativePluginCatalog,pluginServer,reviewHermesPlugin,reviewNativePlugin,verifyPlugins} from '../../native-plugins';
import {changePlugin} from '../context';
import {shell} from 'electron';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const pluginsHandlers:Record<string,(args:any)=>any>={
  async skillsBrowse({query='',page=1}){return backend.host('skills_browse',{query,page});},
  async skillReview({identifier}){
    const review=await reviewHermesPlugin(await backend.host('skill_review',{identifier})),token=randomUUID();pluginReviews.clear();pluginReviews.set(token,review);return {...review,token};
  },
  async pluginConversionReview({id}){
    const {catalog}=await handlers.nativePlugins({});const row=catalog.find((item:any)=>item.id===id);if(!row)throw Error('This plugin is no longer installed in Claude Code.');
    const review=await reviewHermesPlugin(await backend.host('plugin_convert',{source:row.source,repository:'installed:'+row.id,commit:row.commit})),token=randomUUID();
    review.id='converted:'+row.id;pluginReviews.clear();pluginReviews.set(token,review);return {...review,token};
  },
  async pluginServerReview({id,index}){if(!Number.isInteger(index)||index<0)throw Error('Invalid server selection.');return pluginServer([store.get<NativePluginInstall>('native-plugin',id)],path.join(data,'native-plugins'),index);},
  async pluginRepositoryReview({repository,commit}){
    const review=await reviewHermesPlugin(await backend.host('plugin_review',{repository,commit:commit||''})),token=randomUUID();
    pluginReviews.clear();pluginReviews.set(token,review);return {...review,token};
  },
  async nativePlugins(){return {catalog:await nativePluginCatalog(namespace.startsWith('Trismegistus/Test/')?path.join(data,'fixture-claude-home'):path.join(os.homedir(),'.claude')),installed:store.all<NativePluginInstall>('native-plugin')};},
  async nativePluginReview({id}){
    const {catalog}=await handlers.nativePlugins({});const row=catalog.find((item:any)=>item.id===id);if(!row)throw Error('This plugin is no longer installed in Claude Code.');
    const review=await reviewNativePlugin(row),token=randomUUID();pluginReviews.clear();pluginReviews.set(token,review);return {...review,token};
  },
  async nativePluginInstall({token,values={}}){
    const review=pluginReviews.get(token);if(!review)throw Error('Review this plugin before importing it.');
    return queuePluginChange('install:'+review.id+':'+review.hash,review.name,'Install',async(signal,activate)=>{
    const duplicate=store.all<NativePluginInstall>('native-plugin').find(row=>row.enabled&&row.id!==review.id&&row.name.toLowerCase()===review.name.toLowerCase());
    if(duplicate)throw Error('Turn off the other '+review.name+' installation before enabling this version.');
      const item=await installNativePlugin(review,path.join(data,'native-plugins'));
      if(item.setup?.fields.length){
        const previous=store.all<NativePluginInstall>('native-plugin').find(row=>row.id===item.id);
        const {redact,...configuration}=await backend.host('plugin_configuration_save',{source:item.directory,values,previous:previous?.configuration?.revision},signal);
        for(const value of redact)backend.scrubber.register(value);item.configuration=configuration;
      }
      const next=[...store.all<NativePluginInstall>('native-plugin').filter(row=>row.enabled&&row.hermes&&row.id!==item.id),item];
      await backend.host('plugin_dependencies_check',{plugins:next.filter(row=>row.hermes).map(row=>({directory:row.directory,name:row.name,version:row.version,key:hermesPluginKey(row)}))},signal);
      const runtime=item.setup?.python.length?await backend.host('plugin_runtime_prepare',{sources:next.filter(row=>row.hermes).map(row=>row.directory),features:(pluginRuntime() as any)?.features||[]},signal):undefined;
      if(runtime)item.runtime=runtime;
      signal.throwIfAborted();
      activate();const result=await changePlugin(item,runtime);pluginReviews.delete(token);return result;
    });
  },
  async pluginSetupCancel({id}:{id?:string}={}){pluginChanges.cancel(id);},
  async pluginConfigure({id,values}){
    const name=store.get<NativePluginInstall>('native-plugin',id).name;
    return queuePluginChange('configure:'+id,name,'Save settings',async(signal,activate)=>{
      const item=store.get<NativePluginInstall>('native-plugin',id);
      await verifyPlugins([{...item,enabled:true}],path.join(data,'native-plugins'));
      const {redact,...configuration}=await backend.host('plugin_configuration_save',{source:item.directory,values,previous:item.configuration?.revision},signal);
      for(const value of redact)backend.scrubber.register(value);
      activate();return await changePlugin({...item,configuration});
    });
  },
  async nativePluginRemove({id}){
    const name=store.get<NativePluginInstall>('native-plugin',id).name;
    return queuePluginChange('remove:'+id,name,'Remove',async(signal,activate)=>{
    const item=store.get<NativePluginInstall>('native-plugin',id),root=path.join(data,'native-plugins');
    if(item.enabled)throw Error('Turn '+item.name+' off before removing it.');
    // Only this version's own snapshot folder inside the app's plugin store is deleted.
    const owned=path.dirname(item.directory)===root&&path.basename(item.directory).startsWith(item.hash+'-')&&(await fs.lstat(item.directory).catch(()=>null))?.isDirectory();
    activate();if(owned)await fs.rm(item.directory,{recursive:true,force:true});store.remove('native-plugin',id);emit();
    });
  },
  async nativePluginToggle({id,enabled}){
    if(typeof enabled!=='boolean')throw Error('Invalid plugin selection.');
    const name=store.get<NativePluginInstall>('native-plugin',id).name;
    return queuePluginChange('toggle:'+id+':'+enabled,name,enabled?'Enable':'Disable',async(signal,activate)=>{
    const item=store.get<NativePluginInstall>('native-plugin',id);
    if(enabled&&store.all<NativePluginInstall>('native-plugin').some(row=>row.enabled&&row.id!==id&&row.name.toLowerCase()===item.name.toLowerCase()))throw Error('Turn off the other '+item.name+' installation first.');
      let runtime;
      if(enabled){
        await verifyPlugins([{...item,enabled:true}],path.join(data,'native-plugins'));
        const specs=[...store.all<NativePluginInstall>('native-plugin').filter(row=>row.enabled&&row.id!==id),item].flatMap(row=>row.setup?.python||[]);
        if(specs.length){
          runtime=[pluginRuntime(),item.runtime].find(candidate=>candidate&&specs.every(spec=>candidate.specs.includes(spec))&&((pluginRuntime() as any)?.features||[]).every((feature:string)=>(candidate as any).features?.includes(feature)));
          if(!runtime)throw Error('These dependencies need a combined setup. Review and import this plugin version again.');
          await backend.host('plugin_runtime_check',{runtime},signal);
        }
      }
      activate();return await changePlugin({...item,enabled},runtime);
    });
  },
  async mcpAdd({name,config}){try{return await mcp.request('add',{name,config});}finally{await refreshMcp();}},
  async mcpAction({id,action}){
    if(!['test','on','off','remove','revoke','cancelLogin'].includes(action)||typeof id!=='string')throw Error('Unknown connection action.');
    if(mcpLogins.has(id)){
      if(['test','on'].includes(action))throw Error('Finish or cancel sign-in first.');
      mcpLogins.get(id)!.abort();
    }
    try{await mcp.request(action,{id});}finally{await refreshMcp();}
  },
  async mcpLogin({id}){
    if(typeof id!=='string'||!mcpRows.some(row=>row.id===id))throw Error('Connection not found.');
    if(mcpLogins.has(id))throw Error('Sign-in is already open.');
    const controller=new AbortController();mcpLogins.set(id,controller);emit();
    try{await mcp.login(id,url=>shell.openExternal(url),controller.signal);}catch(error){if(!controller.signal.aborted)throw error;}finally{mcpLogins.delete(id);await refreshMcp();}
  },
  async mcpRefresh(){await refreshMcp();},
  async artFont({font}){if(typeof font!=='string'||!Object.hasOwn(artFonts,font))throw Error('Unknown artwork font');return (await fs.readFile(path.join(__dirname,'taag','fonts',artFonts[font as keyof typeof artFonts]))).toString('base64');}
};
