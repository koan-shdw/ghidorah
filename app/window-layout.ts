export interface WindowBounds {x:number;y:number;width:number;height:number;}
export function visibleWindowBounds(value:unknown,area:WindowBounds):WindowBounds {
 const saved=value&&typeof value==='object'?value as Partial<WindowBounds>:{};
 const number=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?Math.round(value):fallback;
 const width=Math.min(area.width,Math.max(450,number(saved.width,780))),height=Math.min(area.height,Math.max(400,number(saved.height,850)));
 return {width,height,x:Math.max(area.x,Math.min(area.x+area.width-width,number(saved.x,area.x+(area.width-width)/2))),y:Math.max(area.y,Math.min(area.y+area.height-height,number(saved.y,area.y+(area.height-height)/2)))};
}
