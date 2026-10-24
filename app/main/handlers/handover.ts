// Handover mode handlers (notes/HANDOVER-MODE-PLAN.md). /handoff itself is read in submitTurn (app/main/context.ts).
import {handoverStart,pushText,seriesTitles,unpushed} from '../../handover';
import {checkHandover} from '../../handover-check';
import type {Routine} from '../../routines';
import {saveApp,type SavedApp} from '../../saved-apps';
import type {Chat,Turn} from '../../types';
import {data,emit,goals,managingChats,sidebar,store,win} from '../../main';
import {configure} from '../backend';
import {goalHold,submitTurn} from '../context';
import {changeProjectMode,projectFor,requireStableFolder,workingDirectory} from '../projects';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const pushing=new Set<string>();
/** The old chat of a live handover, from either of its two chats. */
function live(chatId:string){
 const chat=sidebar.root(chatId),old=chat.handover?chat:store.all<Chat>('chat').find(c=>c.handover?.newChatId===chat.id);
 if(!old?.handover)throw Error('Handover mode is not on for this chat.');
 return old;
}

export const handoverHandlers:Record<string,(args:any)=>any>={
  async handoverCheck({chatId,turnId}){
    const chat=sidebar.root(chatId),turn=store.get<Turn>('turn',turnId);if(turn.chatId!==chat.id)throw Error('This message belongs to another chat.');
    return checkHandover(turn.text,workingDirectory(projectFor(chat)));
  },
  // START HANDOVER: the next chat in the series with every setting the same; the handover is its only message.
  async handoverStart({chatId,turnId,model}){
    requireStableFolder();
    const old=sidebar.root(chatId),turn=store.get<Turn>('turn',turnId);
    if(old.handover?.stage!=='writing')throw Error('Ask this chat for a handover first.');
    const last=store.all<Turn>('turn').filter(t=>t.chatId===old.id&&!t.parentTurnId).at(-1);
    if(turn.chatId!==old.id||turn.id!==last?.id||turn.status!=='completed'||!turn.text.trim())throw Error('Start from the latest finished handover reply.');
    const pick=typeof model==='string'&&model?model:turn.model;if(!(old.pool||[]).includes(pick))throw Error('Add this model to the chat first.');
    if(managingChats.has(old.id))throw Error('This chat is already changing.');
    const hold=goalHold(old.id);if(hold)throw Error(hold);
    managingChats.add(old.id);
    try{
      goals.pause(old.id,'Moved to the next chat by handover');
      const id=sidebar.fork(old.id,{handover:true}),fresh=store.get<Chat>('chat',id),oldProject=projectFor(old);
      try{
        await configure(projectFor(fresh));
        // Project memory is his, not the old chat's context (his answer 10-24): the new chat starts with a copy.
        const memories=(profile:string)=>path.join(data,'hermes','profiles',profile,'memories');
        await fs.cp(memories(oldProject.profile),memories(projectFor(fresh).profile),{recursive:true,force:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }catch(error){sidebar.delete(id);store.db.prepare("DELETE FROM records WHERE kind='project' AND id=?").run(fresh.projectId);store.db.prepare("DELETE FROM records WHERE kind='goal' AND id=?").run(id);throw error;}
      const titles=seriesTitles(old.title);
      store.transaction(()=>{
        store.update<Chat>('chat',id,{title:titles.next,handoverFrom:old.id,pinned:true,archived:false});
        store.update<Chat>('chat',old.id,{title:titles.old,handover:{stage:'live',newChatId:id,mode:oldProject.mode,pushedToOld:null,pushedToNew:turn.id}});
        for(const routine of store.all<Routine>('routine'))if(routine.chatId===old.id)store.put('routine',{...routine,chatId:id});
        if(goals.get(old.id))goals.clear(old.id);
        for(const entry of store.all<SavedApp>('saved-app'))if(entry.chatIds.includes(old.id))saveApp(store,{id:entry.id,chatIds:[...entry.chatIds,id]});
      });
      // The old chat reads but does not change files until Close brings its own mode back.
      if(oldProject.mode!=='plan')await changeProjectMode(oldProject.id,'plan').catch(error=>store.update<Chat>('chat',old.id,{engineNotice:'Could not switch this chat to Plan mode: '+String(error).replace(/^Error: /,'')}));
      await submitTurn({id:randomUUID(),chatId:id,text:handoverStart(titles.old,turn.text),models:[pick]},{handoff:{id:'handover-'+turn.id,sourceChatId:old.id,sourceTurnId:turn.id,title:titles.old,push:true}});
      emit();win.webContents.send('select-chat',id);return id;
    }finally{managingChats.delete(old.id);}
  },
  // Show old chat / Send to new chat: what is new since the last push in that direction, as one message.
  async handoverPush({chatId,throughTurnId}){
    const old=live(chatId),from=sidebar.root(chatId),toOld=from.id!==old.id;
    if(old.handover!.stage!=='live')throw Error('Start the handover first.');
    if(pushing.has(old.id))throw Error('A push is already on its way.');
    pushing.add(old.id);
    try{
      const rows=unpushed(store.all<Turn>('turn'),from.id,toOld?old.handover!.pushedToOld:old.handover!.pushedToNew,throughTurnId);
      if(!rows.length)throw Error('Nothing new to send.');
      const id=randomUUID(),to=toOld?old.id:old.handover!.newChatId!;
      await submitTurn({id,chatId:to,text:pushText(store,rows,from.title,toOld)},{handoff:{id:'handover-'+id,sourceChatId:from.id,sourceTurnId:rows.at(-1)!.id,title:from.title,push:true}});
      const current=store.get<Chat>('chat',old.id).handover!;
      store.update<Chat>('chat',old.id,{handover:{...current,...(toOld?{pushedToOld:rows.at(-1)!.id}:{pushedToNew:rows.at(-1)!.id})}});
      emit();return id;
    }finally{pushing.delete(old.id);}
  },
  // Close handover (or cancel one still being written): the old chat stays, numbered and unpinned, in its own mode.
  async handoverClose({chatId}){
    const old=live(chatId),handover=old.handover!;
    if(handover.mode&&handover.mode!=='plan'&&projectFor(old).mode==='plan')await changeProjectMode(old.projectId,handover.mode);
    store.update<Chat>('chat',old.id,{handover:undefined,...(handover.stage==='live'?{pinned:false}:{})});
    emit();return {oldChatId:old.id,newChatId:handover.newChatId};
  },
  handoverChipHide({chatId}){store.update<Chat>('chat',sidebar.root(chatId).id,{handoverChipHidden:true});emit();},
};
