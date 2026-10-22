import pty from 'node-pty';
let terminal:pty.IPty|undefined;
process.parentPort.on('message',({data})=>{
  try{
    if(data.type==='start'&&!terminal){
      terminal=pty.spawn(data.shell,['-NoLogo','-NoProfile'],{name:'xterm-256color',cols:100,rows:28,cwd:data.directory,env:data.env,useConpty:true});
      terminal.onData(text=>process.parentPort.postMessage({type:'data',text}));
      terminal.onExit(({exitCode})=>{process.parentPort.postMessage({type:'exit',exitCode});terminal=undefined;process.exit(0);});
      process.parentPort.postMessage({type:'started'});
    }else if(data.type==='write')terminal?.write(data.text);
    else if(data.type==='resize')terminal?.resize(data.cols,data.rows);
  }catch{process.parentPort.postMessage({type:'error',message:'The terminal could not complete this operation.'});process.exit(1);}
});
