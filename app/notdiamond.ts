// Not Diamond (3a-5): POST /v2/modelRouter/modelSelect with a Bearer key (docs.notdiamond.ai, read 2 October).
// It sees the routing summary and the chat's models in its own provider names, and returns one model.
import {jevHttp,localEndpoint,type JevDecision,type JevSettings,type JevState} from './jev';
import {providerFor,wireModel} from './models';
import {withLearning} from './learning';

export const notDiamondEndpoint=(test?:string)=>test?localEndpoint(test):'https://api.notdiamond.ai/v2';
// The app's suppliers in Not Diamond's provider names. Suppliers it does not list are left out of the question.
const providers:Record<string,string>={deepseek:'deepseek','openai-codex':'openai','openai-api':'openai','claude-code':'anthropic',gemini:'google',vertex:'google',mistral:'mistral',xai:'x-ai','xai-oauth':'x-ai',minimax:'minimax','minimax-cn':'minimax','minimax-oauth':'minimax',alibaba:'qwen'};

export function notDiamondRequest(state:JevState,catalog:{provider:string;model:string}[]){
 const asked:{id:string;provider:string;model:string}[]=[],left:string[]=[];
 for(const model of state.models.filter(row=>row.available)){
  const provider=providers[providerFor(model.id)];
  const name=model.id.startsWith('claude-code:')?model.id.slice(12):wireModel(model.id);
  if(provider&&catalog.some(row=>row.provider===provider&&row.model===name))asked.push({id:model.id,provider,model:name});else left.push(model.label);
 }
 return {asked,left,body:{messages:[{role:'user',content:withLearning(state.summary,state.history)}],llm_providers:[...new Map(asked.map(({provider,model})=>[provider+':'+model,{provider,model}])).values()]}};
}

export async function decideNotDiamond(endpoint:string,key:string,state:JevState,settings:JevSettings,signal:AbortSignal):Promise<JevDecision>{
 const started=Date.now(),deadline=AbortSignal.any([signal,AbortSignal.timeout(settings.timeoutMs)]);
 const catalog=await jevHttp(endpoint,key,'/models',deadline,undefined,'Not Diamond');
 if(!Array.isArray(catalog?.models)||catalog.models.some((row:any)=>typeof row?.provider!=='string'||typeof row?.model!=='string'))throw Error('Not Diamond returned an invalid model list.');
 const {asked,left,body}=notDiamondRequest(state,catalog.models);
 if(!asked.length)throw Error('Not Diamond does not list any model in this chat.');
 const answer=await jevHttp(endpoint,key,'/modelRouter/modelSelect',deadline,body,'Not Diamond');
 const pick=answer?.providers?.[0],match=asked.find(row=>row.provider===pick?.provider&&row.model===pick?.model);
 if(!match)throw Error('Not Diamond returned an invalid decision.');
 return {model:match.id,order:[match.id],confidence:NaN,message:'Not Diamond selected this model.'+(left.length?' Not asked: '+left.join(', ')+'.':''),answers:{providers:answer.providers,session_id:answer.session_id},usage:null,elapsedMs:Date.now()-started};
}
