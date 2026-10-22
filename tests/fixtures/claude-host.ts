import {runClaude} from '../../app/claude';
import {SecretScrubber} from '../../app/redaction';
const options=JSON.parse(process.argv[2]);
await runClaude({...options,prompt:JSON.stringify({action:'cancel'}),signal:new AbortController().signal,scrubber:new SecretScrubber(),approve:async()=>false,event:(event:any)=>{if(event.childPid)process.stdout.write(JSON.stringify({childPid:event.childPid})+'\n');}});
