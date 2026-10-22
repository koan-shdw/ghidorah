// Read an inert clipboard fragment; keep link labels and destinations as Markdown.
export function linkedClipboardText(root:Node,plain:string):string{
 let links=0;
 const escape=(text:string)=>text.replace(/([\\`*_\[\]<>~])/g,'\\$1');
 function read(node:Node):string{
  if(node.nodeType===3)return escape(node.nodeValue||'');
  if(node.nodeType!==1&&node.nodeType!==11&&node.nodeType!==9)return '';
  const element=node as Element,tag=element.nodeName.toLowerCase();
  if(['script','style','iframe','object','template','noscript','svg'].includes(tag))return '';
  if(tag==='br')return '\n';
  const text=Array.from(node.childNodes).map(read).join('');
  if(tag==='a'){
   const href=element.getAttribute('data-chat-href')||element.getAttribute('href')||'';
   try{
    const url=new URL(href);
    if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&text.trim()){
     links++;return '['+text+'](<'+url.href.replace(/</g,'%3C').replace(/>/g,'%3E')+'>)';
    }
   }catch{}
  }
  if(['b','strong'].includes(tag))return text?'**'+text+'**':'';
  if(['i','em'].includes(tag))return text?'*'+text+'*':'';
  if(tag==='li')return '- '+text.trim()+'\n';
  if(['p','div','section','article','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','tr'].includes(tag))return '\n'+text+'\n';
  if(['td','th'].includes(tag))return text+'\t';
  return text;
 }
 const text=read(root).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
 return links?(plain.match(/^\s*/)?.[0]||'')+text+(plain.match(/\s*$/)?.[0]||''):plain;
}
