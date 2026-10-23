// backend: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import wakeModel from '../../backend/wake-model.json';
import {backend,data,hermesModels,root,store,taskScratchHint,usageBaseline} from '../main';
import {providerFor,wireModel} from '../models';
import {NativePluginInstall,hermesPluginCopies,hermesPluginKey,verifyPlugins} from '../native-plugins';
import {directAppTools} from '../saved-apps';
import type {Chat,Project,ToolCall,Turn} from '../types';
import {projectFor,workingDirectory,writePolicy} from './projects';
import {toolAccess,toolPaths} from './screen';
import {wakeSettings} from './voice';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function configure(project?:Project) {
  const home=project?path.join(data,'hermes','profiles',project.profile):path.join(data,'hermes');
  await fs.mkdir(home,{recursive:true});
  for(const dir of ['memories','sessions','logs','skills'])await fs.mkdir(path.join(home,dir),{recursive:true});
  await fs.mkdir(path.join(home,'plugins'),{recursive:true});
  await fs.cp(path.join(root,'plugins','trismegistus-permissions'),path.join(home,'plugins','trismegistus-permissions'),{recursive:true});
  const plugins=store.all<NativePluginInstall>('native-plugin').filter(row=>row.hermes);
  await verifyPlugins(plugins,path.join(data,'native-plugins'));
  const pluginKeys=await hermesPluginCopies(plugins,home,true);
  const mock=process.env.TRISMEGISTUS_TEST_PROVIDER_URL;
  const config={model:{default:'deepseek-flash',provider:'deepseek',base_url:mock||'https://api.deepseek.com/v1'},agent:{scratch_hint:taskScratchHint},
    compression:{threshold:0.85,codex_gpt55_autoraise:false,proactive_prune_tokens:48000,proactive_prune_min_result_chars:8000,proactive_prune_min_reclaim_tokens:4096},
    auth:{adopt_external_logins:false},approvals:{mode:'manual',unattended_mode:'deny',timeout:24*60*60},security:{redact_secrets:true,allow_lazy_installs:false},
    // Hermes's background skill and memory review is off: 33 runs on 10-13..20, 1.76M tokens, nothing saved (audit 5).
    skills:{external_dirs:project?[path.join(data,'hermes','skills')]:[],creation_nudge_interval:0},memory:{nudge_interval:0},
    browser:{backend:'off',agent_browser_path:toolPaths().browser||'',cloud_provider:'local',engine:'chrome',headed:false,use_real_profile:false},
    plugins:{enabled:['trismegistus-permissions',...pluginKeys],entries:Object.fromEntries(plugins.filter(row=>row.enabled&&row.configuration).map(row=>[hermesPluginKey(row),{settings:row.configuration!.settings}]))},
    secrets:{sources:['trismegistus_plugins'],profile_alias:false,trismegistus_plugins:{enabled:true}},updates:{check:false},desktop:{auto_continue:{enabled:false}},
    // A message typed while Hermes answers is read after its current step, as in Claude Code; never an interrupt (TURN-REVIEW part 2).
    display:{busy_input_mode:'steer'},
    wake_word:{enabled:!project&&wakeSettings().enabled,surface:'gui',provider:'sherpa',phrase:wakeSettings().phrase,profile_routing:false,start_new_session:false,capture:'client',sherpa:{model_dir:path.join(data,'models','wake',wakeModel.sha256)},sensitivity:.5},
    terminal:{cwd:project?workingDirectory(project):home},
    tools:{tool_search:{eager:[...directAppTools,'preview_page','skills_list','skill_view','search_web','read_web_page','read_chat_history','query_chat_history','save_chat_output','goal_status','background_process','connected_tools']},desktop:{enabled:['file','terminal','memory','session_search','todo','clarify','trismegistus_mcp','skills',...toolAccess().on],disabled:['cronjob','delegation','messaging',...['browser','computer_use'].filter(name=>!toolAccess().on.includes(name))]}},
    };
  await fs.writeFile(path.join(home,'config.yaml'),JSON.stringify(config,null,2));
  if(project&&!project.folder)await fs.mkdir(workingDirectory(project),{recursive:true});
  await writePolicy(project);
}
export async function session(chat:Chat,model=chat.model,signal?:AbortSignal){
  signal?.throwIfAborted();
  if(chat.runtimeId)return chat.runtimeId;
  const p=projectFor(chat);let result:any;
  if(chat.storedId){
    try{result=await backend.rpc.request('session.resume',{profile:p.profile,session_id:chat.storedId,source:'desktop',close_on_disconnect:false},30000,signal);}
    catch(error){
      const turns=store.all<Turn>('turn').filter(t=>t.chatId===chat.id);
      const hasWork=turns.some(t=>t.text||t.reasoning||t.usage||['completed','stopped'].includes(t.status))||store.all<ToolCall>('tool').some(tool=>turns.some(t=>t.id===tool.turnId));
      if((error as any).code!==4007||hasWork)throw error;
      // A failed first dispatch can leave a lazy session ID with no persisted Hermes row.
      store.update<Chat>('chat',chat.id,{storedId:null,runtimeId:null});
    }
    if(result?.running)throw Error('This chat still has active work; reconcile it before submitting.');
  }
  if(!result)result=await backend.rpc.request('session.create',{profile:p.profile,source:'desktop',cwd:workingDirectory(p),model:wireModel(model),provider:providerFor(model),reasoning_effort:chat.efforts?.[model]||chat.effort,close_on_disconnect:false},30000,signal);
  signal?.throwIfAborted();
  if(p.folder)await backend.rpc.request('session.cwd.set',{profile:p.profile,session_id:result.session_id,cwd:workingDirectory(p)},30000,signal);
  signal?.throwIfAborted();
  store.update<Chat>('chat',chat.id,{runtimeId:result.session_id,storedId:result.stored_session_id||chat.storedId});
  // A switch to the model the session already runs still adds Hermes's "model changed" note, which merges
  // into the user's message and drops plugin context from that turn.
  if(result.info?.model===wireModel(model)&&result.info?.provider===providerFor(model))hermesModels.set(result.session_id,model);
  usageBaseline.set(result.session_id,result.info?.usage||{});
  return result.session_id;
}
