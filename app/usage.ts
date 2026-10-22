import type {Turn,ClaudeConnection,ModelPrice} from './types';
import {resetTime} from './availability';
import {modelLabel,providerFor} from './models';

export function usageModels(turns:Turn[],models:string[],contextUsage:{model:string}[]=[]){
  return [...new Set([...models,...contextUsage.map(row=>row.model),...turns.flatMap(turn=>[turn.model,...(turn.usage?.mixed_models||[]),...(turn.routingUsage?[turn.routingUsage.summaryModel]:[])])])].filter(model=>{
    // Saved command turns are history records, not model/provider accounts.
    try{providerFor(model);return true;}catch{return false;}
  });
}
/** The fullest context window among these models, in percent; null until one reports usage. */
export function contextPercent(turns:Turn[],models:string[]){
  const percentages=usageModels([],models).flatMap(model=>{const context=modelUsage(turns,model).context;return context?[context.used/context.max*100]:[];});
  return percentages.length?Math.max(...percentages):null;
}
export function contextTooltip(turns:Turn[],models:string[],labels?:{id:string;label:string}[]){
  const rows=usageModels([],models).map(model=>{
    const context=modelUsage(turns,model).context;
    return modelLabel(model,labels)+': '+(context?`${context.estimated?'≈ ':''}${Math.round(context.used/context.max*100)}% used · ${context.used.toLocaleString()} / ${context.max.toLocaleString()} tokens`:'Usage not reported yet');
  });
  return ['Context window · latest reported',...(rows.length?rows:['Select a model to see its context usage.'])].join('\n');
}

const number=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const claudeWindowLabels={five_hour:'5-hour limit',seven_day:'Weekly · all models',seven_day_opus:'Weekly · Opus',seven_day_sonnet:'Weekly · Sonnet',seven_day_oauth_apps:'Weekly · connected apps'};
export function claudeRateUsage(event:any,windows:NonNullable<ClaudeConnection['windows']>=[]){
 const info=event.type==='rate_limit_event'?event.rate_limit_info:null,label=info?claudeWindowLabels[info.rateLimitType as keyof typeof claudeWindowLabels]:undefined;
 if(!label||!number(info.utilization))return windows;
 const reset=resetTime(info.resetsAt),row={label,usedPercent:info.utilization*100,resetAt:reset===null?null:new Date(reset).toISOString()};
 return windows.some(window=>window.label===label)?windows.map(window=>window.label===label?row:window):[...windows,row];
}
export function modelUsage(turns:Turn[],model:string,contextUsage:{model:string;tokens:number|null}[]=[]){
  const own=turns.filter(turn=>!turn.jobs?.length&&(turn.model===model||turn.usage?.mixed_models?.includes(model)));
  const summaries=turns.filter(turn=>turn.routingUsage?.summaryModel===model),summaryTokens=summaries.filter(turn=>number(turn.routingUsage?.summaryTokens));
  const measured=own.filter(turn=>!turn.usage?.mixed_models&&number(turn.usage?.turn_total));
  const costs=own.filter(turn=>!turn.usage?.mixed_models&&number(turn.usage?.turn_cost_usd));
  const context=own.findLast(turn=>turn.model===model&&number(turn.usage?.context_used)&&number(turn.usage?.context_max)&&turn.usage.context_max>0);
  const compact=contextUsage.filter(row=>row.model===model),reported=compact.filter(row=>number(row.tokens)),contextTokens=reported.reduce((sum,row)=>sum+row.tokens!,0);
  return {
    tokens:measured.length+summaryTokens.length+reported.length?measured.reduce((sum,turn)=>sum+turn.usage.turn_total,0)+summaryTokens.reduce((sum,turn)=>sum+turn.routingUsage!.summaryTokens!,0)+contextTokens:null,
    contextTokens,
    summaryTokens:summaryTokens.reduce((sum,turn)=>sum+turn.routingUsage!.summaryTokens!,0),
    partial:measured.length<own.length||summaryTokens.length<summaries.length||reported.length<compact.length,
    cost:costs.length?costs.reduce((sum,turn)=>sum+turn.usage.turn_cost_usd,0):null,
    costPartial:costs.length<own.length||summaries.length>0||compact.length>0,
    context:context?{used:context.usage.context_used as number,max:context.usage.context_max as number,estimated:!!context.usage.context_estimated,source:context.usage.context_source||'provider_usage',created:context.created}:null,
  };
}

// Tooltip price lines: the model's list price, then how it compares with each other priced model in the chat.
// ponytail: compares a 3:1 input:output blend of list prices; weigh by the chat's real token mix if that misleads.
export function priceLines(model:string,pool:string[],prices:Record<string,ModelPrice>={},label:(id:string)=>string){
  const money=(n:number)=>'$'+(Number.isInteger(n)?String(n):n<0.01?String(Number(n.toPrecision(2))):n.toFixed(2));
  const blend=(id:string)=>{const price=prices[id];return price?.input!=null&&price.output!=null?(3*price.input+price.output)/4:null;};
  const own=prices[model],mine=blend(model);
  if(own?.input==null||own.output==null||mine===null)return ['Price unavailable'];
  if(!mine)return ['Free'];
  const times=(ratio:number)=>(ratio>=10?Math.round(ratio):Number(ratio.toFixed(1)))+'×';
  return [money(own.input)+' in · '+money(own.output)+' out per million tokens',...pool.flatMap(other=>{
    const theirs=blend(other);if(other===model||!theirs)return [];
    const ratio=mine/theirs;
    return [ratio>1.05?times(ratio)+' pricier than '+label(other):ratio<1/1.05?times(1/ratio)+' cheaper than '+label(other):'About the same price as '+label(other)];
  })];
}

export function windowLabel(label:string,seconds?:number|null){
  if(seconds===604800)return 'Weekly';
  if(seconds&&seconds%3600===0)return `${seconds/3600}-hour limit`;
  return label;
}

export function resetLabel(resetAt:string|null,now=Date.now()){
  if(!resetAt)return 'Reset time unavailable';
  const date=new Date(resetAt),remaining=date.getTime()-now;
  if(!Number.isFinite(remaining))return 'Reset time unavailable';
  if(remaining<=0)return 'Reset time passed · refresh usage';
  const minutes=Math.ceil(remaining/60000);
  return minutes<60?`Resets in ${minutes} min`:minutes<1440?`Resets in ${Math.floor(minutes/60)}h ${minutes%60}m`:`Resets ${date.toLocaleString()}`;
}

// get_usage is the CLI's public experimental control response. Its utilization
// values are percentages; stream rate_limit_event values use a different scale.
export function claudeUsage(response:any){
  const windows:{label:string;usedPercent:number|null;resetAt:string|null}[]=[];
  function add(label:string,value:any){
    if(!value||typeof value!=='object')return;
    windows.push({label,usedPercent:number(value.utilization)?value.utilization:null,
      resetAt:typeof value.resets_at==='string'&&Number.isFinite(Date.parse(value.resets_at))?value.resets_at:null});
  }
  if(response?.rate_limits_available===true){
    const limits=response.rate_limits||{};
    for(const [key,label] of Object.entries(claudeWindowLabels))add(label,limits[key]);
    if(Array.isArray(limits.model_scoped))for(const bucket of limits.model_scoped)if(typeof bucket.display_name==='string')add('Weekly · '+bucket.display_name.slice(0,80),bucket);
  }
  return {windows,plan:typeof response?.subscription_type==='string'?response.subscription_type:undefined,checkedAt:new Date().toISOString()};
}
