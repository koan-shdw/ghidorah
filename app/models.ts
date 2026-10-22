import {splitApiModel,apiModel,isApiProvider} from './api-catalog';
export function providerFor(model:string){
  const api=splitApiModel(model);if(api)return api.provider;
  if(/^deepseek-[a-zA-Z0-9.-]+$/.test(model))return 'deepseek';
  if(/^gpt-[a-zA-Z0-9.-]+$/.test(model))return 'openai-codex';
  if(/^claude-code:[a-zA-Z0-9._:-]+$/.test(model))return 'claude-code';
  throw Error('Unsupported model');
}
export function wireModel(model:string){return splitApiModel(model)?.model||model;}
export function appModel(provider:string,model:string){return isApiProvider(provider)?apiModel(provider,model):model;}
export function modelLabel(model:string,claudeModels?:{id:string;label:string}[]){return splitApiModel(model)?.model|| (model.startsWith('command:')?'Plugin · '+model.slice(8):claudeModels?.find(item=>item.id===model)?.label||(model==='deepseek-flash'?'DeepSeek':/^deepseek-/.test(model)?'DeepSeek '+model.slice(9).split('-').filter(Boolean).map(part=>part[0].toUpperCase()+part.slice(1)).join(' '):model.startsWith('claude-code:')?'Claude '+model.slice(12):model.replace(/^gpt/,'GPT').replace(/-(astra|sol|luna|terra)$/,(_,name:string)=>' '+name[0].toUpperCase()+name.slice(1))));}
export const modelEfforts=(model:string):Record<string,string>=>/^api:(?:gemini|vertex):/.test(model)?(/gemini-3.*flash/.test(model)?{low:'Low',medium:'Medium',high:'High'}:/gemini-3.*pro/.test(model)?{low:'Low',high:'High'}:{high:'On'}):model.startsWith('api:kimi-coding:')?(/(?:^|[-:])k3(?:[-:]|$)/.test(model)?{low:'Low',high:'High',max:'Max'}:{low:'Low',medium:'Medium',high:'High'}):model.startsWith('api:zai:')?(/glm-5\.3/i.test(model)?{low:'Low',medium:'Medium',high:'High',max:'Max'}:/glm-5\.2/i.test(model)?{high:'High',max:'Max'}:{high:'On'}):/^api:xai(?:-oauth)?:/.test(model)?{low:'Low',medium:'Medium',high:'High'}:/^deepseek-/.test(model)?{none:'None',high:'High',max:'Max'}:{low:'Low',medium:'Medium',high:'High',xhigh:'Extra high'};
// Newest first within each supplier. Suppliers that report no release date fall back to the version
// number in the model name, then to the supplier's own order (GPT and Claude already rank newest first).
export function newestFirst<T extends {id:string;supplier:string;created:number|null}>(models:T[],label:(id:string)=>string){
 const version=(id:string)=>Number(/(?:^|[-:_/])(\d+(?:\.\d+)?)(?=$|[-._:/])/.exec(label(id).replace(/\s+/g,'-'))?.[1]||/(?:^|[-:_/])(\d+(?:\.\d+)?)(?=$|[-._:/])/.exec(id)?.[1]||0);
 return models.map((model,order)=>({model,order})).sort((a,b)=>a.model.supplier.localeCompare(b.model.supplier)||(b.model.created||0)-(a.model.created||0)||version(b.model.id)-version(a.model.id)||a.order-b.order).map(row=>row.model);
}
