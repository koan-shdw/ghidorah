// Main-process timing for the lag hunt (Koan 2026-11-09: "up to half a second on anything you do"). Off unless
// TRISMEGISTUS_TIMING names a log file; then every emit, window state, IPC request and slow store call writes a line,
// an event-loop monitor writes each stall over 40 ms with what was running, and TRISMEGISTUS_PROFILE names a
// .cpuprofile written when the app quits (or after TRISMEGISTUS_PROFILE_SECONDS). Nothing here runs for users.
import fs from 'node:fs';
import inspector from 'node:inspector';
import {app} from 'electron';

const file=process.env.TRISMEGISTUS_TIMING||'';
export const timing={
  on:Boolean(file),
  label:'idle',
  log(line:string){if(!file)return;try{fs.appendFileSync(file,`${new Date().toISOString()} ${line}\n`);}catch{}},
  /** Runs fn under a label; logs its time (always when over `min` ms, or always when min is 0). */
  time<T>(label:string,fn:()=>T,min=0):T{
    if(!file)return fn();
    const outer=timing.label;timing.label=label;const start=performance.now();
    try{return fn();}finally{const ms=performance.now()-start;timing.label=outer;if(ms>=min)timing.log(`${label} ms=${ms.toFixed(1)}`);}
  },
  async timeAsync<T>(label:string,fn:()=>Promise<T>,min=0):Promise<T>{
    if(!file)return fn();
    const start=performance.now();timing.label=label;
    try{return await fn();}finally{const ms=performance.now()-start;if(timing.label===label)timing.label='idle';if(ms>=min)timing.log(`${label} ms=${ms.toFixed(1)}`);}
  },
  /** Starts the event-loop stall monitor and the CPU profile. Call once the app is up. */
  start(){
    if(!file)return;
    let expected=performance.now()+50;
    const tick=setInterval(()=>{const now=performance.now(),late=now-expected;expected=now+50;if(late>40)timing.log(`stall ms=${late.toFixed(0)} during=${timing.label}`);},50);
    tick.unref?.();
    const profile=process.env.TRISMEGISTUS_PROFILE;
    if(profile){
      const session=new inspector.Session();session.connect();
      session.post('Profiler.enable');session.post('Profiler.setSamplingInterval',{interval:500});session.post('Profiler.start');
      let written=false;
      const stop=()=>{if(written)return;written=true;session.post('Profiler.stop',(error,result)=>{try{if(!error)fs.writeFileSync(profile,JSON.stringify((result as any).profile));timing.log(`profile written=${!error}`);}catch{}});};
      const seconds=Number(process.env.TRISMEGISTUS_PROFILE_SECONDS||'0');
      if(seconds>0){const timer=setTimeout(stop,seconds*1000);timer.unref?.();}
      app.once('before-quit',stop);process.on('exit',stop);
      (timing as any).stopProfile=stop;
    }
    timing.log('timing started');
  },
  /** Wraps a store so calls over 3 ms are logged with their kind. */
  wrapStore(store:any){
    if(!file)return;
    for(const method of ['put','update','remove','all','where','whereIn','idsWhere','toolsOf','withResults','whole','get','snapshot','interrupt','splitResults','ageResults','transaction']){
      const original=store[method];if(typeof original!=='function')continue;
      store[method]=function(this:any,...args:any[]){
        const start=performance.now(),outer=timing.label;timing.label=`store.${method}`;
        try{return original.apply(this,args);}
        finally{const ms=performance.now()-start;timing.label=outer;if(ms>=3)timing.log(`store.${method} kind=${typeof args[0]==='string'?args[0]:'-'} ms=${ms.toFixed(1)}`);}
      };
    }
  }
};
