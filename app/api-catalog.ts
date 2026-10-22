export const apiSuppliers={
 alibaba:{name:'Alibaba Model Studio',account:'Alibaba Model Studio API',keys:'https://modelstudio.console.alibabacloud.com/'},
 nous:{name:'Nous · Portal',account:'Nous account',keys:'https://portal.nousresearch.com/'},
 'openrouter-api':{name:'OpenRouter',account:'OpenRouter',keys:'https://openrouter.ai/keys'},
 minimax:{name:'MiniMax · API',account:'MiniMax API',keys:'https://platform.minimax.io/'},
 'minimax-cn':{name:'MiniMax · China API',account:'MiniMax China API',keys:'https://platform.minimaxi.com/'},
 'minimax-oauth':{name:'MiniMax · Sign-in',account:'MiniMax account',keys:'https://platform.minimax.io/'},
 mistral:{name:'Mistral · API',account:'Mistral API',keys:'https://console.mistral.ai/'},
 'openai-api':{name:'OpenAI · API',account:'OpenAI API',keys:'https://platform.openai.com/api-keys'},
 gemini:{name:'Google · Gemini',account:'Google AI Studio',keys:'https://aistudio.google.com/apikey'},
 vertex:{name:'Google · Vertex AI',account:'Google Cloud',keys:'https://console.cloud.google.com/vertex-ai'},
 xai:{name:'xAI · Grok',account:'xAI API',keys:'https://console.x.ai/'},
 'xai-oauth':{name:'Grok · Subscription',account:'Grok subscription',keys:'https://grok.com/'},
 'kimi-coding':{name:'Moonshot · Kimi',account:'Kimi API',keys:'https://platform.kimi.ai/'},
 zai:{name:'Z.ai · GLM',account:'Z.ai API',keys:'https://z.ai/manage-apikey/apikey-list'},
} as const;
export type ApiProvider=keyof typeof apiSuppliers;
export const isApiProvider=(value:unknown):value is ApiProvider=>typeof value==='string'&&Object.hasOwn(apiSuppliers,value);
export interface ApiConnection {provider:ApiProvider;connected:boolean;status:string;models:{id:string;label:string;vision:boolean;manual?:boolean;created?:number|null;description?:string|null}[];baseUrl:string;source:'live'|'cached'|'manual'|'unverified';checkedAt:string|null;authFailed?:boolean;login?:{url:string;code:string}|null;projectId?:string;region?:string;workspaceId?:string;credentialType?:string;keyBudgetRemaining?:number|null;keyLimitReset?:string|null;}
export function apiModel(provider:string,model:string){if(!isApiProvider(provider)||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model))throw Error('Invalid supplier model.');return 'api:'+provider+':'+model;}
export function splitApiModel(model:string){const match=/^api:([^:]+):(.+)$/.exec(model);if(!match)return null;apiModel(match[1],match[2]);return {provider:match[1] as ApiProvider,model:match[2]};}
