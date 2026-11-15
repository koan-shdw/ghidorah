// Waves while you dictate (2026-11-16): bars in the message box's bottom row, the last few seconds of your voice moving
// left, or a live line across the box between your words and the buttons. Settings › Voice › Listening picks one; bars
// are the default. They replace the stop button's glow. The drawing is the waves mock-up's, fed the microphone's level.
import React,{useEffect,useRef} from 'react';
import type {WaveStyle} from './listening';

function bar(c:CanvasRenderingContext2D,x:number,y:number,w:number,h:number){
 const r=Math.min(w/2,h/2);c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.fill();
}
/** Bars: one every 5 px, newest on the right, fading to the left. */
export function drawBars(c:CanvasRenderingContext2D,w:number,h:number,rows:number[]){
 const step=5,count=Math.floor(w/step);
 for(let i=0;i<count;i++){const value=rows[rows.length-1-i];if(value===undefined)break;const height=Math.max(2,Math.min(1,value*1.15)*h);c.globalAlpha=1-.75*(i/count);bar(c,w-(i+1)*step+1,(h-height)/2,3,height);}
 c.globalAlpha=1;
}
/** Line: a moving wave whose height follows the level, newest on the right. */
export function drawLine(c:CanvasRenderingContext2D,w:number,h:number,fine:number[],now:number){
 const mid=h/2;c.lineWidth=1.6;c.lineJoin='round';c.beginPath();
 for(let x=0;x<=w;x+=2){const index=fine.length-1-Math.floor((w-x)/2),value=index>=0?fine[index]:0,y=mid+Math.sin(x*.21-now*.011)*Math.min(1,value*1.1)*(h/2-2);if(x===0)c.moveTo(x,y);else c.lineTo(x,y);}
 c.globalAlpha=.85;c.stroke();c.globalAlpha=1;
}

/** Shown while dictation records. `level` is the microphone's loudness, 0 to 1, from each block of sound. */
export function DictationWaves({style,level}:{style:WaveStyle;level:number}){
 const canvas=useRef<HTMLCanvasElement>(null),target=useRef(level);target.current=level;
 useEffect(()=>{
  let frame=0,frames=0,smooth=0,lastRow=0,lastFine=0,ink='';const rows:number[]=[],fine:number[]=[];
  const draw=(now:number)=>{
   frame=requestAnimationFrame(draw);
   smooth+=(target.current-smooth)*.35;
   if(now-lastFine>=16){lastFine=now;fine.push(smooth);if(fine.length>900)fine.shift();}
   if(now-lastRow>=50){lastRow=now;rows.push(smooth);if(rows.length>400)rows.shift();}
   const element=canvas.current;if(!element)return;
   const ratio=devicePixelRatio||1,w=element.clientWidth,h=element.clientHeight;if(!w||!h)return;
   if(element.width!==Math.round(w*ratio)||element.height!==Math.round(h*ratio)){element.width=Math.round(w*ratio);element.height=Math.round(h*ratio);}
   const c=element.getContext('2d');if(!c)return;
   // The colour is the canvas's own text colour, read twice a second, so it follows a theme change.
   if(frames++%30===0)ink=getComputedStyle(element).color;c.setTransform(ratio,0,0,ratio,0,0);c.clearRect(0,0,w,h);c.fillStyle=c.strokeStyle=ink;
   if(style==='bars')drawBars(c,w,h,rows);else drawLine(c,w,h,fine,now);
  };
  frame=requestAnimationFrame(draw);
  return ()=>cancelAnimationFrame(frame);
 },[style]);
 return <canvas ref={canvas} className={'dictation-waves '+style} data-waves={style} aria-hidden="true"/>;
}
