import {useLayoutEffect,useRef,type RefObject,type DependencyList} from 'react';

// A transcript follows new output while the reader is at its bottom. The decision reads the live scroll position
// against the height the transcript had before this update. A scroll event arrives a frame after the scroll, so a
// flag kept by that event could pull the view back down just after the reader scrolled up, and a click there could
// land on whatever moved under the pointer (found by chat-content in 0b).
export function atBottom(previousHeight:number,scrollTop:number,clientHeight:number){return previousHeight-scrollTop-clientHeight<100;}

export function useFollowOutput(scroller:RefObject<HTMLDivElement|null>,deps:DependencyList){
 const height=useRef(0),jump=useRef(true);
 // Follow before paint so streaming cannot show a frame at the old scroll position.
 useLayoutEffect(()=>{
  const element=scroller.current;if(!element)return;
  if(jump.current||atBottom(height.current,element.scrollTop,element.clientHeight))element.scrollTo({top:element.scrollHeight});
  jump.current=false;height.current=element.scrollHeight;
 },deps);
 return {
  // A row opened or closed changes the height without an update; the scroll it causes records the new one.
  onScroll:()=>{jump.current=false;if(scroller.current)height.current=scroller.current.scrollHeight;},
  // Opening another chat starts at its bottom.
  toBottom:()=>{jump.current=true;},
 };
}
