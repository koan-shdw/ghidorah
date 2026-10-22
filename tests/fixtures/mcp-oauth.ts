import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';

// A local authorization server, with real discovery, registration and PKCE.
// The test opener emulates consent and visits the application's loopback callback.
export async function oauthFixture(){
 const issued=new Map<string,URLSearchParams>();
 const observed={exchanges:0,headers:[] as (string|undefined)[],callbacks:[] as string[]};
 let origin='';
 const server=createServer(async(req,res)=>{
  const reply=(status:number,value?:any,headers:Record<string,string>={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(value===undefined?'':JSON.stringify(value));};
  const url=new URL(req.url!,origin);
  if(req.method==='GET'){
   if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return reply(200,{resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:['tools']});
   if(url.pathname.startsWith('/.well-known/oauth-authorization-server'))return reply(200,{issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
   if(url.pathname==='/authorize'){
    if(url.searchParams.get('code_challenge_method')!=='S256')return reply(400);
    const code=randomUUID();issued.set(code,url.searchParams);
    const callback=new URL(url.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({code,state:url.searchParams.get('state')!,iss:origin}).toString();
    observed.callbacks.push(callback.href);return reply(200,{callback:callback.href});
   }
   return reply(405);
  }
  if(req.method==='DELETE')return reply(200);
  if(req.method!=='POST')return reply(405);
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();
  if(url.pathname==='/register'){const body=JSON.parse(raw);return reply(201,{client_id:'local-client',redirect_uris:body.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});}
  if(url.pathname==='/token'){
   const body=new URLSearchParams(raw),grant=issued.get(body.get('code')||'');
   if(!grant||body.get('grant_type')!=='authorization_code'||grant.get('redirect_uri')!==body.get('redirect_uri')||createHash('sha256').update(body.get('code_verifier')||'').digest('base64url')!==grant.get('code_challenge'))return reply(400,{error:'invalid_grant'});
   issued.delete(body.get('code')!);observed.exchanges++;return reply(200,{access_token:'synthetic-node-mcp-access',refresh_token:'synthetic-node-mcp-refresh',expires_in:3600,token_type:'Bearer',scope:'tools'});
  }
  observed.headers.push(req.headers.authorization);
  if(req.headers.authorization!=='Bearer synthetic-node-mcp-access')return reply(401,undefined,{'WWW-Authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`});
  const body=JSON.parse(raw);if(!('id' in body))return reply(202);
  const result=body.method==='initialize'?{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-oauth',version:'1'}}:body.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{marker:{type:'string'}}}}]}:{content:[{type:'text',text:body.params.arguments.marker+' synthetic-node-mcp-access'}]};
  reply(200,{jsonrpc:'2.0',id:body.id,result});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as any).port;
 return {origin,observed,close:()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})};
}
