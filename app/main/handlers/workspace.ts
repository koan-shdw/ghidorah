// workspace handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {diffReviewPrompt} from '../../diff-review';
import {backend,browserPreviews,emit,gitOperation,handlers,managingChats,previews,sidebar,store,terminals,workspaceWindows} from '../../main';
import {redactPastedKeys} from '../../redaction';
import type {SavedApp} from '../../saved-apps';
import type {Chat} from '../../types';
import {listWorkspace,readWorkspaceFile,saveWorkspaceFile,workspacePath} from '../../workspace-files';
import {defaultFolder} from '../apps';
import {projectFor,requireStableFolder,workingDirectory} from '../projects';
import {openWorkspaceWindow} from '../windows';
import {shell} from 'electron';
import {createHash,randomUUID} from 'node:crypto';

export const workspaceHandlers:Record<string,(args:any)=>any>={
  async previewBrowser({chatId,url,file,chatFileId}){store.get<Chat>('chat',chatId);await browserPreviews.open(chatId,url!==undefined||file!==undefined||chatFileId!==undefined?{url,file,chatFileId}:undefined);return {opened:true};},
  previewState({chatId}){store.get<Chat>('chat',chatId);return previews.state(chatId);},
  previewOpen({chatId,url,file,chatFileId}){store.get<Chat>('chat',chatId);return previews.open(chatId,{url,file,chatFileId});},
  previewAction({chatId,action}){store.get<Chat>('chat',chatId);if(!['back','forward','reload','stop','close'].includes(action))throw Error('Invalid preview action.');return previews.action(chatId,action);},
  previewLayout({chatId,bounds}){if(chatId)store.get<Chat>('chat',chatId);previews.layout(chatId,bounds);},
  workspaceDraft(){throw Error('Editor state requires a window owner.');},
  workspaceWindowOpen(args){return openWorkspaceWindow(args);},
  workspaceWindowReturn({view}){workspaceWindows.get(view)?.window.close();},
  workspaceList({directory=''}){return listWorkspace(defaultFolder(),directory);},
  workspaceRead({file}){return {...readWorkspaceFile(defaultFolder(),file),root:defaultFolder()};},
  workspaceSave({root:expected,file,text,revision}){requireStableFolder();if(expected!==defaultFolder())throw Error('The working folder changed. Your draft is kept; reopen the original folder before saving.');return {...saveWorkspaceFile(defaultFolder(),file,text,revision),root:defaultFolder()};},
  async workspaceChanges({directory='',file,staged=false}){if(typeof staged!=='boolean')throw Error('Invalid diff selection.');const root=defaultFolder(),result=await backend.host('workspace_changes',{directory:workspacePath(root,directory),file,staged});return {...result,root,...(typeof result.text==='string'?{revision:createHash('sha256').update(result.text).digest('hex')}:{})};},
  workspaceGitCancel({chatId}){if(gitOperation){if(gitOperation.chatId!==chatId)throw Error('This Git operation belongs to another chat.');gitOperation.controller.abort();}},
  async reviewDraft({chatId,directory='',file,staged=false,revision,root,comments=[]}){
    sidebar.root(chatId);if(root!==defaultFolder())throw Error('The working folder changed. Refresh this diff.');
    const diff=await handlers.workspaceChanges({directory,file,staged});if(root!==defaultFolder()||diff.revision!==revision)throw Error('The diff changed. Refresh it before preparing a review.');
    if(!diff.text||diff.text.length>200000)throw Error('Choose a textual diff of up to 200,000 characters.');
    const prompt=diffReviewPrompt([directory,file].filter(Boolean).join('/'),staged,diff.text,comments),chat=sidebar.root(chatId);
    if(chat.archived||managingChats.has(chatId))throw Error('Restore this chat before preparing a review.');
    const draft=redactPastedKeys(backend.scrubber.text([chat.draft,prompt].filter(Boolean).join('\n\n')));store.update<Chat>('chat',chatId,{draft,draftRevision:randomUUID()});emit();return {chatId};
  },
  workspaceExplorer(){const folder=defaultFolder();if(!folder)throw Error('Choose the root working folder in Settings first.');return shell.openPath(folder);},
  terminalList({chatId}){store.get<Chat>('chat',chatId);return terminals.list(chatId);},
  terminalOpen({chatId}){requireStableFolder();const chat=store.get<Chat>('chat',chatId);if(managingChats.has(chat.parentChatId||chatId)||chat.archived)throw Error('Restore this chat before opening a terminal.');return terminals.open(chatId,projectFor(chat).folder?workingDirectory(projectFor(chat)):workspacePath(defaultFolder()));},
  terminalRead({chatId,id,after}){return terminals.read(chatId,id,after);},
  terminalWrite({chatId,id,data}){return terminals.write(chatId,id,data);},
  terminalResize({chatId,id,cols,rows}){return terminals.resize(chatId,id,cols,rows);},
  terminalClose({chatId,id}){return terminals.close(chatId,id);},
  async openRepository({repository}){
    if(typeof repository!=='string'||!/^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+([/][A-Za-z0-9_.-]+)*$/.test(repository)||repository.split('/').includes('..'))throw Error('Unknown repository.');
    const [owner,name,...rest]=repository.split('/');await shell.openExternal('https://github.com/'+owner+'/'+name+(rest.length?'/tree/HEAD/'+rest.join('/'):''));
  },
  async worktreeSources(){
    const root=defaultFolder();if(!root)throw Error('Choose the root working folder in Settings first.');
    return (await backend.host('worktree',{action:'sources',root,repositories:store.all<SavedApp>('saved-app').flatMap(app=>app.repositories||[])})).map(({path,label}:any)=>({path,label}));
  }
};
