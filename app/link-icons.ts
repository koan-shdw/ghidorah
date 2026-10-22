// Only the public hostname is sent to Google's favicon service, never the path,
// query, fragment or chat text. The renderer keeps its existing image policy.
const cache=new Map<string,Promise<string|null>>();
export function linkIconUrl(href:unknown):string|null{
 if(typeof href!=='string'||href.length>8192)return null;
 try{
  const url=new URL(href),host=url.hostname;
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!host.includes('.')||!/^[a-z0-9.-]+$/i.test(host)||/^[\d.]+$/.test(host)||/\.(?:localhost|local|internal|test|invalid)$/i.test(host))return null;
  return 'https://www.google.com/s2/favicons?sz=32&domain='+encodeURIComponent(host);
 }catch{return null;}
}
export function linkIcon(href:unknown):Promise<string|null>{
 const url=linkIconUrl(href);if(!url)return Promise.resolve(null);
 const known=cache.get(url);if(known)return known;
 const pending=(async()=>{
  try{
   const response=await fetch(url,{signal:AbortSignal.timeout(5000),credentials:'omit',referrerPolicy:'no-referrer'});
   const mime=response.headers.get('content-type')?.split(';')[0].trim();
   if(!response.ok||!response.body||!['image/png','image/x-icon','image/vnd.microsoft.icon','image/jpeg','image/gif','image/webp'].includes(mime||'')){await response.body?.cancel();return null;}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)return null;chunks.push(value);}}finally{await reader.cancel();}
   return size?'data:'+mime+';base64,'+Buffer.concat(chunks).toString('base64'):null;
  }catch{return null;}
 })();
 // ponytail: 256 domains per app session; browser/disk caching can wait until needed.
 if(cache.size>=256)cache.delete(cache.keys().next().value!);
 cache.set(url,pending);return pending;
}
