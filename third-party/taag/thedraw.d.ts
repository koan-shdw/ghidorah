export interface Cell {charCode:number;colorAttr:number}
export interface Font {name:string;type:number;letterSpacing:number;glyphs:(Cell[][]|undefined)[]}
export const CGA_PALETTE:string[];
export function cp437ToChar(code:number):string;
export function decodeColor(attr:number):{fg:number;bg:number};
export function parseTDF(data:Uint8Array):Font[];
export const loadTDF:typeof parseTDF;
export function findFont(fonts:Font[],name:string):Font|undefined;
export function render(text:string,font:Font,options:{mode:'cells';spaceWidth?:number}):{cells:Cell[][]};
export function render(text:string,font:Font,options?:{mode?:'plain'|'ansi'|'console'|'html';[key:string]:unknown}):{text:string};
