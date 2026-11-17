// List prices of the plans Ghidorah's suppliers sell: US dollars a month on monthly billing, each read from the
// supplier's own pricing page on the date given. A list price is an estimate of what the owner pays (tax, currency,
// yearly billing and offers change it), so a price from here is shown as an estimate until the owner types the real
// figure. A plan name that covers several prices (ChatGPT Pro) cannot be told apart by name: those give choices.
export interface PlanList {name:string;page:string;read:string;plans:Record<string,number|number[]>}
export const planLists:Record<string,PlanList>={
 'claude-code':{name:'Claude',page:'https://claude.com/pricing',read:'2026-11-18',plans:{free:0,pro:20,max:100,ultra:200}},
 'openai-codex':{name:'ChatGPT',page:'https://learn.chatgpt.com/docs/pricing',read:'2026-11-18',plans:{free:0,go:8,plus:20,pro:[100,200,500],business:25}},
 'xai-oauth':{name:'X subscription',page:'https://docs.x.ai/x-subscription/pricing',read:'2026-11-17',plans:{plus:8,premium:30,super:100,ultra:200}},
 nous:{name:'Nous Portal',page:'https://portal.nousresearch.com/',read:'2026-11-17',plans:{free:0,plus:20,super:100,ultra:200}},
 'minimax-oauth':{name:'MiniMax M Plan',page:'https://www.minimax.io/m-plan',read:'2026-11-17',plans:{go:22,explore:55,build:132}},
 'kimi-coding':{name:'Kimi membership',page:'https://www.kimi.com/membership/pricing',read:'2026-11-17',plans:{plus:19,pro:39,max:99,ultra:199}},
 zai:{name:'GLM Coding Plan',page:'https://z.ai/subscribe',read:'2026-11-17',plans:{lite:18,pro:80,max:168}},
 mistral:{name:'Le Chat',page:'https://mistral.ai/pricing',read:'2026-11-17',plans:{student:5.99,pro:14.99,team:24.99}},
 alibaba:{name:'Model Studio plans',page:'https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview',read:'2026-11-17',plans:{lite:6,essential:10,standard:18,pro:43}},
 elevenlabs:{name:'ElevenLabs',page:'https://elevenlabs.io/pricing',read:'2026-11-17',plans:{free:0,starter:6,creator:22,pro:99,scale:299,business:990}},
 cloudflare:{name:'Cloudflare Workers',page:'https://developers.cloudflare.com/workers/platform/pricing/',read:'2026-11-17',plans:{free:0,paid:5}},
};
export type PlanPrice={usd:number;page:string;read:string}|{choices:number[];page:string;read:string};
const plain=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]+/g,'');
/** The list price of a supplier's plan as the supplier names it ("max", "Plus", "chatgpt_plus"); null when the
 * supplier or the plan is not in the list. The longest plan name that fits wins, so "premium" never reads as "pro". */
export function planPrice(supplier:string,plan:string|null|undefined):PlanPrice|null{
 const list=Object.hasOwn(planLists,supplier)?planLists[supplier]:null;if(!list||!plan)return null;
 const name=plain(plan),found=Object.keys(list.plans).filter(row=>name===row||name.startsWith(row)||name.endsWith(row)).sort((a,b)=>b.length-a.length)[0];
 if(!found)return null;
 const price=list.plans[found],where={page:list.page,read:list.read};
 return Array.isArray(price)?{choices:[...price],...where}:{usd:price,...where};
}
