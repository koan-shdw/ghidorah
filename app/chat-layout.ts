export interface ChatLayout {chatId:string;splitId:string;direction:'row'|'column';size:number;}
export function readChatLayout(raw:string|null):ChatLayout {
 const fallback:ChatLayout={chatId:'',splitId:'',direction:'row',size:50};
 try{const value=JSON.parse(raw||'null');if(!value||typeof value!=='object')return fallback;return {chatId:typeof value.chatId==='string'?value.chatId:'',splitId:typeof value.splitId==='string'?value.splitId:'',direction:value.direction==='column'?'column':'row',size:typeof value.size==='number'&&Number.isFinite(value.size)?Math.max(25,Math.min(75,value.size)):50};}catch{return fallback;}
}
