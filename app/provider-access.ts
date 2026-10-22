import {isApiProvider} from './api-catalog';
import {appModel} from './models';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {AccountHealth,blockedFor,availabilityMessage} from './availability';

// Private worker channel: main owns availability; workers never write the chat DB.
export async function providerAccess(health:AccountHealth,changed:()=>void){
 const token=randomBytes(32).toString('hex');
 const rejected=new Map<string,Set<string>>(),authObserved=new Map<string,number>();
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'||request.url!=='/'||request.headers.authorization!=='Bearer '+token){response.writeHead(403).end();return;}
  try{
   let body='';for await(const chunk of request){body+=chunk;if(body.length>8192)throw Error('Invalid availability request.');}
   const message=JSON.parse(body),{provider,model,phase}=message;
   if((!['deepseek','openai-codex'].includes(provider)&&!isApiProvider(provider))||typeof model!=='string'||!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)||!['request','response'].includes(phase))throw Error('Invalid provider identity.');
   const credential=message.credential;
   if(credential!==undefined&&(typeof credential!=='string'||!/^[a-f0-9]{64}$/.test(credential)))throw Error('Invalid credential identity.');
   const renewable=provider==='nous'||provider==='openai-codex'||provider.endsWith('-oauth');
   if(phase==='response'){
    const surface=message.surface;
    if(!surface||surface.provider!==provider||surface.model!==model||typeof surface.code!=='string'||typeof surface.layer!=='string')throw Error('Invalid provider response.');
    health.hermes(appModel(provider,model),{error_surface:surface},provider);changed();
    if(renewable&&surface.layer==='auth'&&credential){
     const known=rejected.get(provider)||new Set<string>();known.add(credential);rejected.set(provider,known);
     authObserved.set(provider,health.rows().find(row=>row.provider===provider&&row.key==='auth'&&row.scope==='account')!.observedAt);
    }
   }
   if(phase==='request'&&renewable&&credential&&rejected.has(provider)){
    const auth=health.rows().find(row=>row.provider===provider&&row.key==='auth'&&row.scope==='account');
    if(auth&&!auth.blocked&&auth.observedAt!==authObserved.get(provider)){rejected.delete(provider);authObserved.delete(provider);}
    if(rejected.get(provider)?.has(credential)){response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({blocked:true,reason:'auth',message:'Sign in again'}));return;}
    // A refreshed bearer can retry; it cannot clear newer auth evidence or billing/model blocks.
    if(auth?.blocked&&auth.observedAt===authObserved.get(provider)){const now=Date.now();health.clear(provider,['auth'],now);authObserved.set(provider,now);changed();}
   }
   const blocked=blockedFor(health.rows(),appModel(provider,model),Date.now(),provider);
   response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(blocked?{blocked:true,reason:blocked.reason,resetAt:blocked.resetAt,message:availabilityMessage(blocked)}:{blocked:false}));
  }catch{if(!response.headersSent)response.writeHead(400).end();}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});server.unref();
 const address=server.address();if(!address||typeof address==='string')throw Error('Availability owner did not start.');
 return {connection:{url:`http://127.0.0.1:${address.port}/`,token},close:()=>{if(server.listening){server.closeAllConnections();server.close();}}};
}
