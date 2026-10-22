// qrcode@1.5.4 ships no types; this is the one call the Remote page's pairing uses.
declare module 'qrcode'{export function toDataURL(text:string,options?:{margin?:number;width?:number}):Promise<string>;}
