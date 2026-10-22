// Retain possible secret prefixes between chunks, before logs or IPC see them.
export const redactPastedKeys=(text:string)=>text.replace(/\bsk-[a-zA-Z0-9_-]{20,}/g,'[API key removed — save it in Settings]');
export class SecretScrubber {
  private values = new Set<string>();
  register(value: string) { if (value) this.values.add(value); }
  text(text: string) {
    for (const value of [...this.values].sort((a,b)=>b.length-a.length)) text=text.split(value).join('[redacted]');
    return text;
  }
  value<T>(value:T):T {
    if(typeof value==='string')return this.text(value) as T;
    if(Array.isArray(value))return value.map(item=>this.value(item)) as T;
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[this.text(key),this.value(item)])) as T;
    return value;
  }
  stream() {
    let tail='';
    return (chunk:string, final=false) => {
      const input=tail+chunk;
      let keep=0;
      if (!final) for (const secret of this.values) {
        for (let n=1;n<secret.length && n<=input.length;n++) if(input.endsWith(secret.slice(0,n))) keep=Math.max(keep,n);
      }
      const split=input.length-keep;
      // A complete secret crossing the tentative cut must stay together.
      let cut=split;
      for(const secret of this.values) {let pos=input.indexOf(secret); while(pos>=0) {if(pos<cut && pos+secret.length>cut)cut=pos;pos=input.indexOf(secret,pos+1);}}
      tail=input.slice(cut);
      return this.text(input.slice(0,cut));
    };
  }
}
