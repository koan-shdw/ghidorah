// A Hermes reply's final text: the final message, or what was streamed when it is empty (audit 5.3), with interim
// commentary that was never streamed kept in front.
export function finalText(final:string,streamed:string,interim?:string){
 const text=final.trim()?final:streamed;
 return interim&&!text.includes(interim)?interim+'\n\n'+text:text;
}
