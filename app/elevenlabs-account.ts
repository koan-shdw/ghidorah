// What ElevenLabs reports about the account behind the listening key: the plan, the credits used and when they
// refill, and the next invoice. It is the one supplier that tells an app what it will charge. Read only:
// GET /v1/user/subscription with the key the app already holds (elevenlabs.io/docs/api-reference/user/subscription/get).
export const ELEVENLABS_API='https://api.elevenlabs.io';
type Fetch=typeof fetch;
export interface ElevenLabsAccount {
 tier:string;status:string;
 /** Credits used and allowed in the current period. */
 used:number;limit:number;
 /** When the credits refill, if the account has a period. */
 resetAt:string|null;
 /** The next invoice in the account's own currency, and the months it covers (1, 3, 6 or 12). */
 invoice:{amount:number;currency:string;months:number}|null;
 checkedAt:string;
}
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const months:Record<string,number>={monthly_period:1,'3_month_period':3,'6_month_period':6,annual_period:12};
/** The account from the service's answer, or null when the answer is not the documented shape. */
export function readElevenLabsAccount(body:any,now=new Date()):ElevenLabsAccount|null{
 if(!body||typeof body!=='object'||typeof body.tier!=='string'||!body.tier.trim()||!count(body.character_count)||!count(body.character_limit))return null;
 const reset=count(body.next_character_count_reset_unix)&&body.next_character_count_reset_unix>0?new Date(body.next_character_count_reset_unix*1000):null;
 const due=body.next_invoice?.amount_due_cents,currency=typeof body.currency==='string'?body.currency.toLowerCase():'';
 return {tier:body.tier.trim().slice(0,40),status:typeof body.status==='string'?body.status.slice(0,40):'',used:body.character_count,limit:body.character_limit,
  resetAt:reset&&Number.isFinite(reset.getTime())?reset.toISOString():null,
  invoice:count(due)&&/^[a-z]{3}$/.test(currency)?{amount:due/100,currency,months:months[String(body.billing_period)]||1}:null,
  checkedAt:now.toISOString()};
}
/** Asks ElevenLabs for the account. A refused key and an unreachable service are said in words. */
export async function elevenLabsAccount(key:string,base=ELEVENLABS_API,fetcher:Fetch=fetch):Promise<ElevenLabsAccount>{
 let response:Response;
 try{response=await fetcher(base.replace(/\/+$/,'')+'/v1/user/subscription',{headers:{'xi-api-key':key},signal:AbortSignal.timeout(15000)});}
 catch{throw Error('ElevenLabs could not be reached.');}
 if(response.status===401||response.status===403)throw Error('This ElevenLabs key may not read the account. A key with the user_read permission can.');
 if(!response.ok)throw Error('ElevenLabs did not answer the account request (HTTP '+response.status+').');
 const account=readElevenLabsAccount(await response.json().catch(()=>null));
 if(!account)throw Error('ElevenLabs answered in a shape this app does not know.');
 return account;
}
