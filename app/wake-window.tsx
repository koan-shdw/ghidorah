import {useEffect} from 'react';
import {microphoneFrames} from './voice-audio';

// This hidden window only captures PCM. Main owns settings, detector and destination.
export function WakeWindow(){
 useEffect(()=>{
  const controller=new AbortController();let pending=0,tail=Promise.resolve();
  const fail=(error:unknown)=>{if(controller.signal.aborted)return;controller.abort();void window.desktop.invoke('wakeFailure',{message:String(error).slice(0,500)}).catch(()=>{});};
  void microphoneFrames(frame=>{
   if(controller.signal.aborted)return;
   if(++pending>8){fail(Error('Wake-word audio fell behind. Turn listening off and on to retry.'));return;}
   tail=tail.then(async()=>{if(!controller.signal.aborted)await window.desktop.invoke('wakeFeed',{bytes:new Uint8Array(frame.buffer,frame.byteOffset,frame.byteLength)});}).catch(fail).finally(()=>{pending--;});
  },controller.signal,fail).then(()=>{if(!controller.signal.aborted)return window.desktop.invoke('wakeReady');}).catch(fail);
  return ()=>controller.abort();
 },[]);
 return null;
}
