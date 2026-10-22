import type {MarkedExtension,RendererObject} from 'marked';
export function outputPreview(name:string,id:string){
 if(/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name))return `![${name.replace(/[\[\]\\]/g,'\\$&')}](tris-output:${id})`;
 if(/\.html?$/i.test(name))return `::preview{file="tris-output:${id}"}`;
 return undefined;
}
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const placeholder=(href:string,title:string)=>`<span data-preview-href="${escape(href)}" data-preview-title="${escape(title)}"></span>`;
export const previewImages:RendererObject={image({href,text,title}){return placeholder(href,title||text||'Image');}};
export const previewDirective:MarkedExtension={extensions:[{
 name:'preview',level:'block',start(src){return src.search(/^::preview\{/m);},
 tokenizer(src){const match=/^::preview\{file="([^"\r\n]+)"\}[ \t]*(?:\n|$)/.exec(src);if(match)return {type:'preview',raw:match[0],href:match[1]};},
 renderer(token){return placeholder(token.href,'Preview');}
}]};
