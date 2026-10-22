const object=(value:any):any=>{try{if(typeof value==='string')return JSON.parse(value);}catch{}return value;};
export function toolResultFailed(value:any){
 const raw=object(value),result=raw?.content?.length===1&&raw.content[0].type==='text'?object(raw.content[0].text):raw;
 return raw?.isError===true||result?.is_error===true||result?.success===false||!!result?.error||typeof result?.exit_code==='number'&&result.exit_code!==0||typeof result==='string'&&/^(?:Error:|BLOCKED:)/i.test(result.trim());
}
