import {BrowserWindow,WebContentsView,session,type Rectangle,type Session} from 'electron';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveChatLink} from './chat-links';
import {findChatFile,readChatFile,type ChatFile} from './chat-files';
import {previewFileResponse,previewable} from './preview-files';
import {savedPreviewResponse} from './saved-preview';
import {PreviewPdf} from './preview-pdf';
import type {Store} from './store';

export interface PreviewState {url:string;title:string;loading:boolean;back:boolean;forward:boolean;error:string;restore?:boolean;savedCopy?:boolean;}
type Saved={id:string;chatId:string;chatFileId?:string;name?:string;url?:string;file?:string;root?:string;location?:string};
type Entry={savedFile?:ChatFile;view:WebContentsView;session:Session;source?:{base:string;host:string};pdf?:PreviewPdf;state:PreviewState};
export class Previews{
 private entries=new Map<string,Entry>();
 // decorate: Koan's own pages open as him (FEATURE-SPECS 4); external: a page's trismegistus:// Chat link.
 constructor(private window:BrowserWindow,private store:Store,private root:()=>string|null,private protectedRoots:string[],private poppler:string,private data?:string,private decorate?:(url:string)=>Promise<string>,private external?:(url:string)=>void){}
 private saved(chatId:string){return this.store.all<Saved>('preview').find(item=>item.id===chatId);}
 state(chatId:string):PreviewState{
  const entry=this.entries.get(chatId);if(entry){const web=entry.view.webContents;return {...entry.state,loading:web.isLoading(),back:web.navigationHistory.canGoBack(),forward:web.navigationHistory.canGoForward()};}
  const saved=this.saved(chatId);return {savedCopy:!!saved?.chatFileId,url:saved?.url||saved?.file||saved?.name||'',title:saved?'Saved preview':'Preview',loading:false,back:false,forward:false,error:'',restore:!!saved};
 }
 private create(chatId:string){
  const partition=session.fromPartition('preview-'+randomUUID(),{cache:false});
  partition.setPermissionCheckHandler(()=>false);partition.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));partition.setDevicePermissionHandler(()=>false);
  partition.on('will-download',event=>event.preventDefault());
  const view=new WebContentsView({webPreferences:{session:partition,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,navigateOnDragDrop:false,webviewTag:false,plugins:true}});
  const entry:Entry={view,session:partition,state:{url:'',title:'Preview',loading:false,back:false,forward:false,error:''}},web=view.webContents;
  partition.protocol.handle('tris-preview',async request=>{
   if(!entry.source)return new Response('Unavailable',{status:403});
   if(entry.savedFile){
    try{const url=new URL(request.url);if(url.hostname!==entry.source.host||!['GET','HEAD'].includes(request.method))return new Response('Unavailable',{status:403});
     const row=findChatFile(this.store,chatId,entry.savedFile.id);if(entry.pdf){if(decodeURIComponent(url.pathname).slice(1)!==row.name)return new Response('Unavailable',{status:403});await readChatFile(this.data!,row);return entry.pdf.response(request);}
     return savedPreviewResponse(request,this.data!,row);
    }catch{return new Response('The saved copy is missing or changed.',{status:410});}
   }
   if(entry.pdf){const url=new URL(request.url);return url.hostname===entry.source.host&&request.method==='GET'?entry.pdf.response(request):new Response('Unavailable',{status:403});}
   return previewFileResponse(request,entry.source.base,entry.source.host,this.protectedRoots);
  });
  partition.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const url=new URL(details.url);callback({cancel:url.protocol==='file:'||!!entry.savedFile&&!(url.protocol==='tris-preview:'&&url.hostname===entry.source?.host||['data:','blob:'].includes(url.protocol))});});
  const navigation=(url:string)=>{try{const target=new URL(url);return !entry.savedFile&&['http:','https:'].includes(target.protocol)&&!target.username&&!target.password||target.protocol==='tris-preview:'&&target.hostname===entry.source?.host;}catch{return false;}};
  web.setWindowOpenHandler(()=>{entry.state.error='Pop-up blocked. Open the destination in the address field.';return {action:'deny'};});
  web.on('will-frame-navigate',event=>{if(event.url.startsWith('trismegistus:')){event.preventDefault();this.external?.(event.url);return;}if(!navigation(event.url)){event.preventDefault();entry.state.error='This destination cannot be opened in Preview.';}else if(event.isMainFrame&&!event.url.startsWith('tris-preview:'))entry.source=undefined;});
  web.on('will-redirect',(event,url)=>{if(!navigation(url))event.preventDefault();else if(!url.startsWith('tris-preview:'))entry.source=undefined;});
  web.on('will-attach-webview',event=>event.preventDefault());
  web.on('did-fail-load',(_event,code,description,_url,main)=>{if(main&&code!==-3)entry.state.error='Could not load this preview: '+description;});
  web.on('render-process-gone',()=>{entry.state.error='The preview stopped. Reload to reopen it.';});
  web.on('page-title-updated',(_event,title)=>{entry.state.title=title.slice(0,200);});
  const changed=()=>{const url=web.getURL();if(/^https?:/.test(url)){entry.state.savedCopy=false;entry.savedFile=undefined;entry.state.url=url;this.store.put<Saved>('preview',{id:chatId,chatId,url});}else if(entry.source){const current=new URL(url),saved=this.saved(chatId);if(saved&&current.hostname===entry.source.host)this.store.put<Saved>('preview',{...saved,location:current.pathname+current.search+current.hash});}};
  web.on('did-navigate',changed);web.on('did-navigate-in-page',changed);
  this.window.contentView.addChildView(view);view.setVisible(false);this.entries.set(chatId,entry);return entry;
 }
 async open(chatId:string,target:{url?:string;file?:string;chatFileId?:string}){
  let url:string,source:Entry['source'],saved:Saved,title:string;
  if(target.chatFileId!==undefined){
   if(!this.data)throw Error('Saved file previews are unavailable.');const row=findChatFile(this.store,chatId,target.chatFileId);if(!row.artifact&&!previewable(row.name))throw Error('Use Chat files to read or save this file.');await readChatFile(this.data,row);
   this.close(chatId,false);const entry=this.create(chatId);entry.savedFile=row;entry.source={base:'',host:randomUUID()};entry.state={...entry.state,url:row.name,title:row.name,savedCopy:true};this.store.put<Saved>('preview',{id:chatId,chatId,chatFileId:row.id,name:row.name});
   if(/\.pdf$/i.test(row.name))entry.pdf=new PreviewPdf(this.poppler,()=>path.join(this.data!,row.kind==='upload'?'attachments':'outputs',row.blob,'source'));
   void entry.view.webContents.loadURL('tris-preview://'+entry.source.host+'/'+(row.artifact?.entry||row.name).split('/').map(encodeURIComponent).join('/')).catch(error=>{entry.state.error='Could not load this saved preview: '+String(error.message);});return this.state(chatId);
  }
  if(target.file!==undefined){
    const link=resolveChatLink(this.root(),target.file,this.protectedRoots);if(link.kind!=='file'||link.directory||!previewable(link.path))throw Error('Choose an HTML, PDF, image, audio or video file to preview.');
    const absolute=path.join(link.root,link.path);source={base:path.dirname(absolute),host:randomUUID()};url='tris-preview://'+source.host+'/'+encodeURIComponent(path.basename(absolute));saved={id:chatId,chatId,file:link.path,root:this.root()!};title=path.basename(link.path);
  }else{
    let address=typeof target.url==='string'?target.url.trim():'';if(/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(address))address='http://'+address;
    const link=resolveChatLink(null,address);if(link.kind!=='web')throw Error('Enter an HTTP or HTTPS address.');url=link.url;saved={id:chatId,chatId,url};title='Preview';
  }
  // A fresh view/session ends the previous page before granting another local
  // document directory. Remote pages never inherit local-file access.
  this.close(chatId,false);const entry=this.create(chatId);entry.source=source;entry.state={...entry.state,url:saved.url||saved.file!,title};this.store.put('preview',saved);
  if(saved.file&&/\.pdf$/i.test(saved.file)){const pdfFile=saved.file;entry.pdf=new PreviewPdf(this.poppler,()=>{const link=resolveChatLink(saved.root!,pdfFile,this.protectedRoots);if(link.kind!=='file'||link.directory)throw Error('Unavailable');return path.join(link.root,link.path);});}
  void (source||!this.decorate?Promise.resolve(url):this.decorate(url)).then(address=>entry.view.webContents.loadURL(address)).catch(error=>{entry.state.error='Could not load this preview: '+String(error.message);});return this.state(chatId);
 }
 async action(chatId:string,action:string){
  const entry=this.entries.get(chatId);
  if(action==='close'){this.close(chatId,true);return this.state(chatId);}
  if(!entry){const saved=this.saved(chatId);if(action==='reload'&&saved){if(saved.file&&saved.root!==this.root())throw Error('The saved preview belongs to a different working folder.');return this.open(chatId,saved);}return this.state(chatId);}
  if(action==='reload')entry.view.webContents.reload();else if(action==='stop')entry.view.webContents.stop();else if(action==='back'&&entry.view.webContents.navigationHistory.canGoBack())entry.view.webContents.navigationHistory.goBack();else if(action==='forward'&&entry.view.webContents.navigationHistory.canGoForward())entry.view.webContents.navigationHistory.goForward();
  return this.state(chatId);
 }
 layout(chatId:string,bounds:Rectangle|null){
  for(const [id,entry] of this.entries)entry.view.setVisible(id===chatId&&!!bounds);
  const entry=this.entries.get(chatId);if(!entry||!bounds)return;
  if(!Object.values(bounds).every(value=>typeof value==='number'&&Number.isFinite(value))){entry.view.setVisible(false);throw Error('Invalid preview bounds.');}
  const zoom=this.window.webContents.getZoomFactor();bounds={x:bounds.x*zoom,y:bounds.y*zoom,width:bounds.width*zoom,height:bounds.height*zoom};
  const [width,height]=this.window.getContentSize();if(!Object.values(bounds).every(value=>typeof value==='number'&&Number.isFinite(value))||bounds.x<0||bounds.y<40||bounds.width<1||bounds.height<1||bounds.x+bounds.width>width+1||bounds.y+bounds.height>height+1){entry.view.setVisible(false);throw Error('Invalid preview bounds.');}
  entry.view.setBounds(Object.fromEntries(Object.entries(bounds).map(([key,value])=>[key,Math.round(value)])) as unknown as Rectangle);
 }
 close(chatId:string,forget=false){const entry=this.entries.get(chatId);if(entry){entry.pdf?.close();this.window.contentView.removeChildView(entry.view);entry.view.webContents.close({waitForBeforeUnload:false});void entry.session.clearStorageData();this.entries.delete(chatId);}if(forget)this.store.db.prepare("DELETE FROM records WHERE kind='preview' AND id=?").run(chatId);}
 move(chatId:string,target:Previews){const entry=this.entries.get(chatId);if(!entry||target===this)return;target.close(chatId);this.window.contentView.removeChildView(entry.view);entry.view.setVisible(false);target.window.contentView.addChildView(entry.view);target.entries.set(chatId,entry);this.entries.delete(chatId);}
 closeAll(){for(const id of this.entries.keys())this.close(id);}
}
