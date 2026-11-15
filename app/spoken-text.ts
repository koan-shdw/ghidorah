// What a reply sounds like read aloud (Koan 2026-11-15): the words without the markup. Code blocks are skipped, links
// are read by their text, a bare address by its site. The text is cut into short pieces so the first sound comes
// quickly: the first sentence alone, then sentences together up to about 220 characters.
const LIMIT=6000,PIECE=220,LONGEST=400;

/** A reply as plain sentences, one per line where the reply breaks lines. */
export function spokenText(markdown:string){
 let text=markdown.replace(/\r\n?/g,'\n')
  .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|(?![\s\S]))/gm,'\n')   // fenced code, closed or not
  .replace(/<!--[\s\S]*?-->/g,' ')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1')                                             // images by their description
  .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')                                              // links by their text
  .replace(/<\/?[A-Za-z][^>\n]*>/g,' ')
  .replace(/\bhttps?:\/\/(?:www\.)?([^\s/)>\]]+)[^\s)>\]]*/g,'$1')                     // a bare address by its site
  .replace(/`([^`\n]+)`/g,'$1');
 const lines:string[]=[];
 for(let line of text.split('\n')){
  if(/^\s*(?:[-*_]\s*){3,}$/.test(line)||/^\s*:::/.test(line)||/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line))continue; // rules, directives, table lines
  if(/^\s*\|.*\|\s*$/.test(line))line=line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim()).filter(Boolean).join(', ');
  line=line.replace(/^\s*(?:>\s*)+/,'').replace(/^\s*#{1,6}\s+/,'').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/,'')
   .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,'$2').replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g,'$1$2').replace(/~~(?=\S)([\s\S]*?\S)~~/g,'$1')
   .replace(/[*_~#|\\]+/g,' ').replace(/\s+/g,' ').trim();
  if(!/[\p{L}\p{N}]/u.test(line))continue;
  lines.push(/[.!?…:;,]["')\]]?$/.test(line)?line:line+'.');
 }
 text=lines.join('\n');
 return text.length>LIMIT?text.slice(0,LIMIT-100).replace(/\s+\S*$/,'')+'. The rest is in the chat.':text;
}
/** The pieces the voice is asked to say, in order. */
export function spokenPieces(markdown:string){
 const sentences:string[]=[];
 for(const line of spokenText(markdown).split('\n'))for(let sentence of line.split(/(?<=[.!?…]["')\]]?)\s+(?=\S)/)){
  sentence=sentence.trim();
  // A sentence with no stop in it is cut at a comma or a space, so no piece runs on.
  while(sentence.length>LONGEST){const head=sentence.slice(0,LONGEST),cut=Math.max(head.lastIndexOf(', ')+1,0)||head.lastIndexOf(' ')||LONGEST;sentences.push(sentence.slice(0,cut).trim());sentence=sentence.slice(cut).trim();}
  if(/[\p{L}\p{N}]/u.test(sentence))sentences.push(sentence);
 }
 const pieces:string[]=[];
 for(const sentence of sentences){
  const last=pieces.length-1;
  if(last>=1&&pieces[last].length+1+sentence.length<=PIECE)pieces[last]+=' '+sentence;else pieces.push(sentence);
 }
 return pieces;
}
