import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const execute=promisify(execFile);
// Poppler is already bundled for attachments. Render one bounded page on demand;
// the isolated document has no filesystem or app bridge.
export class PreviewPdf {
 private controller=new AbortController();
 private pending:Promise<Buffer>|null=null;
 private cached:{page:number;image:Buffer}|null=null;
 private pages=0;
 constructor(private binary:string,private file:()=>string){}
 private async run(tool:string,args:string[]){return (await execute(path.join(this.binary,tool+'.exe'),args,{windowsHide:true,encoding:'buffer',timeout:25000,maxBuffer:24*1024*1024,signal:this.controller.signal})).stdout;}
 async response(request:Request){
  const url=new URL(request.url),headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  try{
   if(!this.pages){const info=(await this.run('pdfinfo',[this.file()])).toString();const match=/^Pages:\s+(\d+)/m.exec(info);if(!match||/^Encrypted:\s+yes/m.test(info))throw Error('Use an unlocked PDF.');this.pages=Number(match[1]);if(!Number.isSafeInteger(this.pages)||this.pages<1)throw Error('Invalid PDF page count.');}
   const raw=url.searchParams.get('page'),page=raw===null?1:Number(raw);
   if(!Number.isSafeInteger(page)||page<1||page>this.pages)return new Response('Invalid page',{status:400});
   if(url.searchParams.has('image')){
    if(this.cached?.page!==page){
     // Serialize requests within this view and cache only the latest page.
     while(this.pending)await this.pending;
     if(this.cached?.page!==page){const rendering=this.run('pdftoppm',['-png','-scale-to','1800','-singlefile','-f',String(page),'-l',String(page),this.file()]);this.pending=rendering;try{this.cached={page,image:await rendering};}finally{this.pending=null;}}
    }
    return new Response(new Uint8Array(this.cached!.image),{headers:{...headers,'Content-Type':'image/png'}});
   }
   const nonce=randomUUID();
   return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>PDF preview</title><style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;background:#252524;color:#edece6;font:13px system-ui}nav{position:sticky;top:0;display:flex;align-items:center;justify-content:center;gap:10px;padding:10px;background:#20201f;border-bottom:1px solid #454542}a,button,input{color:inherit;background:#333330;border:1px solid #55554f;border-radius:6px;padding:5px 9px;text-decoration:none}a[aria-disabled=true]{pointer-events:none;opacity:.4}input{width:64px}form{display:flex;align-items:center;gap:6px}main{padding:18px;text-align:center}img{max-width:100%;height:auto;background:white;box-shadow:0 2px 14px #0008}
    </style></head><body><nav><a aria-label="Previous PDF page" aria-disabled="${page===1}" href="?page=${page-1}">←</a><form><label>Page <input aria-label="PDF page" type="number" name="page" min="1" max="${this.pages}" value="${page}"></label><span>of ${this.pages}</span><button>Go</button></form><a aria-label="Next PDF page" aria-disabled="${page===this.pages}" href="?page=${page+1}">→</a></nav><main><img alt="PDF page ${page} of ${this.pages}" src="?page=${page}&amp;image=1"></main></body></html>`,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`}});
  }catch{return new Response('This PDF could not be rendered. Check that it is unlocked and valid, then reload.',{status:422,headers:{...headers,'Content-Type':'text/plain'}});}
 }
 close(){this.controller.abort();this.cached=null;}
}
