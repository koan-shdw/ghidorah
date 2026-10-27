// Discover, Settings > MCP connections: vendor-hosted MCP servers checked 2026-10-27 (official docs and a live OAuth
// metadata probe). oauth: open dynamic client registration, so Sign in works from this app. token: the vendor's own
// token in a header instead. Vendors that admit only approved apps (Figma, Vercel, Dropbox, Adobe, Slack, Asana,
// HubSpot, Box) are left out; Claude chats reach those through the claude.ai connectors switch.
export interface CatalogEntry {name:string;url:string;about:string;token?:{header:string;prefix:string;hint:string}}
export const mcpCatalog:CatalogEntry[]=[
 {name:'Airtable',url:'https://mcp.airtable.com/mcp',about:'Bases, tables and records.'},
 {name:'Atlassian',url:'https://mcp.atlassian.com/v2/mcp',about:'Jira and Confluence. Your organization admin may need to allow it.'},
 {name:'Cloudflare',url:'https://mcp.cloudflare.com/mcp',about:'Workers, DNS, R2 and the rest of your account.'},
 {name:'GitHub',url:'https://api.githubcopilot.com/mcp/',about:'Repositories, issues and pull requests.',token:{header:'Authorization',prefix:'Bearer ',hint:'A GitHub personal access token.'}},
 {name:'Intercom',url:'https://mcp.intercom.com/mcp',about:'Conversations and contacts (US workspaces).'},
 {name:'Intercom EU',url:'https://mcp.eu.intercom.com/mcp',about:'Conversations and contacts (EU workspaces).'},
 {name:'Klaviyo',url:'https://mcp.klaviyo.com/mcp',about:'Campaigns, flows, lists and metrics. Needs an Owner, Admin or Manager role.'},
 {name:'Linear',url:'https://mcp.linear.app/mcp',about:'Issues, projects and cycles.'},
 {name:'monday.com',url:'https://mcp.monday.com/mcp',about:'Boards and items.',token:{header:'Authorization',prefix:'',hint:'Your monday.com API token.'}},
 {name:'Notion',url:'https://mcp.notion.com/mcp',about:'Pages and databases.'},
 {name:'PayPal',url:'https://mcp.paypal.com/mcp',about:'Invoices, orders and disputes.'},
 {name:'Sentry',url:'https://mcp.sentry.dev/mcp',about:'Errors and performance issues.'},
 {name:'Stripe',url:'https://mcp.stripe.com',about:'Payments, customers and subscriptions.'},
 {name:'Supabase',url:'https://mcp.supabase.com/mcp',about:'Projects, databases and edge functions.'},
 {name:'Webflow',url:'https://mcp.webflow.com/mcp',about:'Sites, pages and CMS collections.'},
 {name:'Zapier',url:'https://mcp.zapier.com/api/v1/connect',about:'Actions across the apps you connect in Zapier.'},
];

// The public MCP Registry: remote servers only (local ones go through Paste configuration, which shows the command).
export interface RegistryEntry {id:string;name:string;about:string;url:string;type:'http'|'sse';headers:string[]}
export function registryEntries(body:any):RegistryEntry[]{
 const rows:RegistryEntry[]=[];
 for(const item of Array.isArray(body?.servers)?body.servers:[]){
  const server=item?.server,meta=item?._meta?.['io.modelcontextprotocol.registry/official'];
  if(!server||typeof server.name!=='string'||meta&&(meta.status&&meta.status!=='active'||meta.isLatest===false))continue;
  const remotes=(Array.isArray(server.remotes)?server.remotes:[]).filter((remote:any)=>typeof remote?.url==='string'&&/^https:\/\/[^{}\s]+$/.test(remote.url)&&!remote.variables);
  const remote=remotes.find((r:any)=>r.type==='streamable-http')||remotes.find((r:any)=>r.type==='sse');
  if(!remote||rows.some(row=>row.id===server.name))continue;
  rows.push({id:server.name,name:String(server.title||server.name).slice(0,80),about:String(server.description||'').slice(0,200),url:remote.url,type:remote.type==='sse'?'sse':'http',
   headers:(Array.isArray(remote.headers)?remote.headers:[]).filter((h:any)=>h?.isRequired&&typeof h.name==='string').map((h:any)=>h.name)});
 }
 return rows;
}
