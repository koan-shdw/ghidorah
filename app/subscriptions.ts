// The Subscriptions page's rows: every connection Ghidorah holds, what it costs a month and where that figure
// comes from, what is left, and the supplier's own pages for everything an app cannot do (no supplier lets an app
// cancel or change a plan, or read the price it charges; ElevenLabs alone reports its next invoice).
// A monthly figure is one of three things:
//   confirmed  the owner typed it, or the supplier reports the money;
//   estimate   the list price of the plan the supplier reports (plan-prices.ts);
//   unknown    paid, with no figure: a plan whose price cannot be told from its name, or a key paid by use
//              (no reply saves a cost, so use cannot be priced yet).
// Pure: the window builds the rows from the state it already has plus what the `subscriptions` command returns.
import {apiSuppliers,type ApiProvider} from './api-catalog';
import type {ElevenLabsAccount} from './elevenlabs-account';
import {providerFor} from './models';
import {planPrice} from './plan-prices';
import type {Snapshot} from './types';
import {creditsDetail,windowLabel} from './usage';

export type PriceSource='confirmed'|'estimate'|'unknown';
/** `usd` is null when unknown, or when the supplier bills in another currency (then `other` holds that figure). */
export interface SubscriptionPrice {usd:number|null;source:PriceSource;why:string;other?:string}
export interface SubscriptionWindow {label:string;left:number;resetAt:string|null}
export interface SubscriptionRow {id:string;group:'subscription'|'use';name:string;vendor:string;plan:string;how:string;price:SubscriptionPrice;
 /** The list price to show as the price field's hint. */
 listUsd?:number;windows:SubscriptionWindow[];balance?:string;
 /** The supplier id its models belong to (providerFor), for the row's share of a month's tokens. */
 provider?:string;facts:[string,string][];links:{label:string;kind:string}[]}
export interface SubscriptionFree {name:string;what:string}
export interface SubscriptionExtras {prices:Record<string,number>;elevenlabs?:ElevenLabsAccount|null;elevenlabsNote?:string}

// The suppliers' own pages, opened in the browser. The window names a link by its kind; only these addresses open.
const pages:Record<string,[string,string][]>={
 claude:[['Billing','https://claude.ai/settings/billing'],['Usage and credits','https://claude.ai/settings/usage']],
 chatgpt:[['Plans','https://chatgpt.com/pricing'],['Usage','https://chatgpt.com/codex/settings/usage']],
 deepseek:[['Top up','https://platform.deepseek.com/top_up'],['Usage','https://platform.deepseek.com/usage']],
 gemini:[['Spend','https://aistudio.google.com/spend'],['Billing','https://aistudio.google.com/billing']],
 vertex:[['Billing','https://console.cloud.google.com/billing/reports']],
 xai:[['Billing','https://console.x.ai/team/default/billing']],
 'xai-oauth':[['Subscription','https://grok.com/?_s=billing']],
 'openrouter-api':[['Credits','https://openrouter.ai/settings/credits'],['Activity','https://openrouter.ai/activity']],
 mistral:[['Billing','https://console.mistral.ai/billing']],
 'openai-api':[['Billing','https://platform.openai.com/settings/organization/billing'],['Usage','https://platform.openai.com/usage']],
 zai:[['Subscription','https://z.ai/manage-apikey/subscription'],['Billing','https://z.ai/manage-apikey/billing']],
 minimax:[['Balance','https://platform.minimax.io/user-center/payment/balance']],
 'minimax-oauth':[['Plan','https://platform.minimax.io/console/plan']],
 nous:[['Subscription','https://portal.nousresearch.com/manage-subscription']],
 elevenlabs:[['Subscription','https://elevenlabs.io/app/subscription']],
 deepgram:[['Console','https://console.deepgram.com/']],
 zyphra:[['Zyphra Cloud','https://cloud.zyphra.com/']],
};
for(const [id,supplier] of Object.entries(apiSuppliers))if(!pages[id])pages[id]=[['Account',supplier.keys]];
export const subscriptionLinks:Record<string,string>=Object.fromEntries(Object.entries(pages).flatMap(([id,list])=>list.map(([,url],index)=>['sub:'+id+':'+index,url])));
const links=(id:string)=>(pages[id]||[]).map(([label],index)=>({label,kind:'sub:'+id+':'+index}));

const title=(text:string)=>text.replace(/[_-]+/g,' ').replace(/\b[a-z]/g,letter=>letter.toUpperCase());
const usd=(amount:number)=>'$'+amount.toFixed(2);
const left=(used:number|null)=>used==null?null:Math.max(0,Math.min(100,100-used));
const signIn=(provider:string)=>provider==='nous'||provider.endsWith('-oauth');

/** A row's monthly figure: the owner's typed one first, then money the supplier reports, then the plan's list price. */
function price(typed:number|undefined,supplier:string,plan:string|undefined,reported?:SubscriptionPrice|null):{price:SubscriptionPrice;listUsd?:number}{
 const list=planPrice(supplier,plan),listUsd=list&&'usd' in list?list.usd:undefined;
 if(typed!==undefined)return {price:{usd:typed,source:'confirmed',why:'You typed this figure'},listUsd};
 if(reported)return {price:reported,listUsd};
 if(list&&'usd' in list)return {price:{usd:list.usd,source:'estimate',why:'List price of '+title(plan!)+', read '+list.read+' from '+new URL(list.page).hostname.replace(/^www\./,'')},listUsd};
 if(list)return {price:{usd:null,source:'unknown',why:title(plan!)+' has several prices ('+list.choices.map(usd).join(', ')+'). Type yours'}};
 return {price:{usd:null,source:'unknown',why:plan?'No list price is known for '+title(plan):'The supplier reports no plan or price to apps'}};
}

type State=Pick<Snapshot,'claude'|'codex'|'connected'|'balance'|'apiProviders'|'voice'|'voices'|'remote'|'share'|'decisionEngine'>;
export function subscriptionRows(state:State,extras:SubscriptionExtras):{rows:SubscriptionRow[];free:SubscriptionFree[]}{
 const rows:SubscriptionRow[]=[],free:SubscriptionFree[]=[],typed=(id:string)=>Object.hasOwn(extras.prices,id)?extras.prices[id]:undefined;
 const windows=(list:{label:string;usedPercent:number|null;resetAt:string|null;durationSeconds?:number|null}[]|undefined)=>(list||[]).flatMap(window=>{const value=left(window.usedPercent);return value===null?[]:[{label:windowLabel(window.label,window.durationSeconds),left:value,resetAt:window.resetAt}];});
 if(state.claude?.connected){const plan=state.claude.plan;
  rows.push({id:'claude',group:'subscription',name:'Claude Code',vendor:'anthropic',plan:plan?title(plan):'Subscription',how:'Subscription · Anthropic sign-in',...price(typed('claude'),'claude-code',plan),
   windows:windows(state.claude.windows),provider:'claude-code',facts:state.claude.credits?[['Usage credits',(state.claude.credits.enabled?'On':'Off')+(creditsDetail(state.claude.credits)?' · '+creditsDetail(state.claude.credits):'')]]:[],links:links('claude')});}
 if(state.codex?.connected){const plan=state.codex.plan;
  rows.push({id:'chatgpt',group:'subscription',name:'ChatGPT',vendor:'openai',plan:plan?title(plan):'Subscription',how:'Subscription · ChatGPT sign-in',...price(typed('chatgpt'),'openai-codex',plan),
   windows:windows(state.codex.windows),provider:'openai-codex',facts:state.codex.credits?[['Credits',(state.codex.credits.enabled?'On':'Off')+(creditsDetail(state.codex.credits)?' · '+creditsDetail(state.codex.credits):'')]]:[],links:links('chatgpt')});}
 if(state.voice?.listening?.connected?.elevenlabs){const account=extras.elevenlabs,invoice=account?.invoice;
  const reported:SubscriptionPrice|null=invoice?invoice.currency==='usd'?{usd:invoice.amount/invoice.months,source:'confirmed',why:'Your next invoice, as ElevenLabs reports it'+(invoice.months>1?' (for '+invoice.months+' months)':'')}
   :{usd:null,source:'confirmed',why:'Your next invoice, as ElevenLabs reports it',other:(invoice.amount/invoice.months).toFixed(2)+' '+invoice.currency.toUpperCase()}:null;
  rows.push({id:'elevenlabs',group:'subscription',name:'ElevenLabs',vendor:'elevenlabs',plan:account?title(account.tier):'API key',how:'Subscription · API key · listening',...price(typed('elevenlabs'),'elevenlabs',account?.tier,reported),
   windows:account&&account.limit>0?[{label:'Credits this period',left:Math.max(0,Math.min(100,(account.limit-account.used)/account.limit*100)),resetAt:account.resetAt}]:[],
   facts:[['Used for','Dictation'],...(account?[['Credits used',account.used.toLocaleString()+' of '+account.limit.toLocaleString()] as [string,string]]:extras.elevenlabsNote?[['Account',extras.elevenlabsNote] as [string,string]]:[])],links:links('elevenlabs')});}
 for(const row of state.apiProviders||[]){if(!row.connected)continue;const provider=row.provider as ApiProvider,subscription=signIn(provider);
  rows.push({id:provider,group:subscription?'subscription':'use',name:apiSuppliers[provider].name,vendor:provider,plan:subscription?'Sign-in':'API key',how:subscription?'Subscription · sign-in':'Pay per use · API key',
   ...price(typed(provider),provider,undefined),windows:[],...(row.keyBudgetRemaining!=null?{balance:usd(row.keyBudgetRemaining)+(row.keyLimitReset?' · resets '+row.keyLimitReset:'')}:{}),provider,
   facts:[['Models',String(row.models.length)]],links:links(provider)});}
 if(state.connected)rows.push({id:'deepseek',group:'use',name:'DeepSeek',vendor:'deepseek',plan:'Prepaid',how:'Prepaid credit · API key',...price(typed('deepseek'),'deepseek',undefined),windows:[],...(state.balance?{balance:state.balance}:{}),provider:'deepseek',facts:[],links:links('deepseek')});
 if(state.voice?.listening?.connected?.deepgram)rows.push({id:'deepgram',group:'use',name:'Deepgram',vendor:'deepgram',plan:'API key',how:'Pay per use · API key · listening',...price(typed('deepgram'),'deepgram',undefined),windows:[],facts:[['Used for','Dictation']],links:links('deepgram')});
 if(state.voices?.zonos?.connected)rows.push({id:'zyphra',group:'use',name:'Zyphra · Zonos',vendor:'zyphra',plan:'API key',how:'Pay per use · API key · reply voice',...price(typed('zyphra'),'zyphra',undefined),windows:[],facts:[['Used for','Reading replies aloud']],links:links('zyphra')});
 if(state.voice?.freeKeySaved)free.push({name:'Gemini voice',what:'free tier key'});
 if(state.remote?.tokenSaved)free.push({name:'Telegram remote',what:'free'});
 if(state.share?.ready)free.push({name:'Cloudflare share site',what:'plan not read'});
 for(const row of state.decisionEngine?.pickers||[])if(row.connected)free.push({name:row.label,what:/local/i.test(row.label)?'on this PC':'cost not read'});
 if(state.voice?.installed?.length)free.push({name:'Whisper',what:'on this PC'});
 if(state.voices?.installed)free.push({name:'Kokoro voices',what:'on this PC'});
 if(state.voice?.wake?.installed)free.push({name:'Wake word',what:'on this PC'});
 return {rows,free};
}
/** The foot of the page: what is confirmed, what is estimated, and how many paid rows have no figure in dollars. */
export function subscriptionTotals(rows:SubscriptionRow[]){
 let confirmed=0,estimated=0,unknown=0;
 for(const {price} of rows){if(price.usd===null)unknown++;else if(price.source==='estimate')estimated+=price.usd;else confirmed+=price.usd;}
 return {confirmed,estimated,unknown,sum:confirmed+estimated};
}
/** The window of a row with the least left. */
export function tightest(row:SubscriptionRow){return row.windows.length?[...row.windows].sort((a,b)=>a.left-b.left)[0]:null;}
/** What needs the owner first: a limit nearly spent, a paid row with no figure, and list prices still unconfirmed. */
export function needsLook(rows:SubscriptionRow[]):{id:string;tone:'warning'|'plain';lead:string;rest:string}[]{
 const out:{id:string;tone:'warning'|'plain';lead:string;rest:string}[]=[];
 for(const row of rows){const window=tightest(row);if(window&&window.left<=20)out.push({id:row.id,tone:'warning',lead:row.name+': '+Math.round(window.left)+'% left on '+window.label+'.',rest:''});}
 for(const row of rows)if(row.price.source==='unknown')out.push({id:row.id,tone:'plain',lead:row.name+' is paid, amount unknown.',rest:'Type it in, or open its page.'});
 const estimates=rows.filter(row=>row.price.source==='estimate');
 if(estimates.length)out.push({id:estimates[0].id,tone:'plain',lead:estimates.length===1?'1 price is a list price:':estimates.length+' prices are list prices:',rest:estimates.map(row=>row.name).join(', ')+'. Type the real '+(estimates.length===1?'figure':'figures')+' to confirm.'});
 return out;
}
/** The tokens a row's models used, from a month's per-model sums. */
export function usedBy(row:SubscriptionRow,models:Record<string,number>){
 if(!row.provider)return null;
 let total=0;for(const [model,tokens] of Object.entries(models)){try{if(providerFor(model)===row.provider)total+=tokens;}catch{}}
 return total;
}
