// The kit: Ghidorah's shared parts. Screens build from these instead of styling their own buttons, dialogs, menus and
// switches; kit.css draws them from the tokens. Each part keeps the class names tests and older styles hook onto.
import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react';

const paths={
 attach:'M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M6 14l8-8',microphone:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8',voice:'M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4',send:'M12 19V5m-6 6 6-6 6 6',stop:'M6 6h12v12H6z',usage:'M12 3v9h9M9 3.5a9 9 0 1 0 11.5 11.5M15 3.5a9 9 0 0 1 5.5 5.5',
 preview:'M3 4h18v16H3V4zm0 5h18M8 9v11',files:'M5 3h9l5 5v13H5V3zm9 0v6h5M8 13h8m-8 4h6',changes:'M5 7h14M12 3v8M5 17h14',
 chats:'M4 3h16a1 1 0 0 1 1 1v13H9l-6 4V4a1 1 0 0 1 1-1zm3 5h10M7 12h7',plugins:'M8 3h3a3 3 0 1 1 6 0h4v6a3 3 0 1 0 0 6v6h-6a3 3 0 1 0-6 0H3v-6a3 3 0 1 0 0-6V3h5',skills:'M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3V4zm9 2v15',models:'M12 2l9 5v10l-9 5-9-5V7l9-5zm-9 5l9 5 9-5m-9 5v10',activity:'M6 9a6 6 0 0 1 12 0v6l3 3H3l3-3V9zm4 12h4',
 rename:'M16 3l5 5-12 12-6 1 1-6L16 3zm-2 2l5 5',pin:'M15 3l6 6-4 1-4 5v4l-2 2-3-7-5-3 2-2h4l5-4 1-2zM8 16l-5 5',
 eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm7 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
 folder:'M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18',
 fork:'M6 7v10m0-10a2 2 0 1 0 0-4 2 2 0 1 0 0 4zm0 14a2 2 0 1 0 0-4 2 2 0 1 0 0 4zm12-14a2 2 0 1 0 0-4 2 2 0 1 0 0 4zM6 14h7a5 5 0 0 0 5-5V7',
 terminal:'M3 5h18v14H3V5zm4 4l3 3-3 3m6 0h4',archive:'M3 3h18v5H3V3zm1 5v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8m-11 4h6',
 trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',up:'M5 14l7-7 7 7',down:'M5 10l7 7 7-7',right:'M9 5l7 7-7 7',check:'M5 12l4 4L19 6',
 panel:'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm5 0v16',plus:'M12 4v16M4 12h16',more:'M4 12h.01M12 12h.01M20 12h.01',search:'M10 3a7 7 0 1 0 0 14 7 7 0 1 0 0-14zm5 12l6 6',filter:'M3 5h18M6 12h12M9 19h6',
 settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3zm0 9a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
 close:'M6 6l12 12M18 6 6 18',caret:'M8 10l4 4 4-4',slash:'M15 4 9 20',plan:'M3 6l2 2 3-3M3 13l2 2 3-3M11 7h10M11 14h10M11 20h10',tasks:'M4 5h5v5H4zM4 15l2 2 3-3M13 7h8M13 16h8',
 popout:'M14 4h6v6M10 14 20 4M18 14v6H4V6h6',image:'M4 4h16v16H4V4zm0 12 5-5 4 4 3-3 4 4M9 8.5h.01',code:'M9 8l-4 4 4 4m6-8 4 4-4 4',
 doc:'M6 3h8l4 4v14H6V3zm8 0v4h4M9 12h6m-6 4h6',file:'M6 3h8l4 4v14H6V3zm8 0v4h4',
 art:'M4 20c2.5 0 4.5-1.2 4.5-4 0-1.7 1.1-2.8 2.8-2.8L20 4.5 18.5 3l-8.7 8.7C8 11.7 7 12.8 7 14.5 7 17 5.5 18.5 4 20z',
 restart:'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
};
export type IconName=keyof typeof paths;
export function Icon({name}:{name:IconName}){return <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;}
/** The icon set's first name, kept for the screens that still use it. */
export const SidebarIcon=Icon;
/** A file's kind, for its icon in file lists. */
export function fileIcon(name:string,folder=false):IconName{
 if(folder)return 'folder';
 const ext=/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()||'';
 if(/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(ext))return 'image';
 if(/^(js|mjs|cjs|ts|tsx|jsx|py|ps1|sh|css|html|json|ya?ml|toml|rs|go|cs|java|c|cpp|h)$/.test(ext))return 'code';
 if(/^(md|txt|pdf|docx?|rtf|log)$/.test(ext))return 'doc';
 return 'file';
}

const join=(...names:(string|false|undefined|null)[])=>names.filter(Boolean).join(' ');

type ButtonProps=React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'plain'|'outline'|'primary'|'danger';icon?:IconName;iconOnly?:boolean};
/** A button. Icon-only buttons need an aria-label; their title shows on hover. */
export const Button=React.forwardRef<HTMLButtonElement,ButtonProps>(function Button({variant='plain',icon,iconOnly=false,className,children,type='button',...rest},ref){
 return <button ref={ref} type={type} {...rest} className={join('kit-button','kit-'+variant,variant==='primary'&&'primary',variant==='danger'&&'danger',iconOnly&&'kit-icon-only',className)}>{icon&&<Icon name={icon}/>}{!iconOnly&&children}</button>;
});

type SwitchProps={checked:boolean;onChange:(checked:boolean)=>void;label?:React.ReactNode;disabled?:boolean;className?:string;title?:string;ariaLabel?:string;children?:React.ReactNode;
 /** 'switch' (a setting) or 'pressed' (a toggle button in a toolbar); both look the same. */semantics?:'switch'|'pressed'}&Omit<React.ButtonHTMLAttributes<HTMLButtonElement>,'onChange'|'role'>;
/** An on/off switch: one look for every setting or toggle that is on or off. */
export function Switch({checked,onChange,label,disabled,className,title,ariaLabel,children,semantics='switch',...rest}:SwitchProps){
 const state=semantics==='switch'?{role:'switch','aria-checked':checked}:{'aria-pressed':checked};
 return <button type="button" aria-label={ariaLabel} {...state} title={title} disabled={disabled} {...rest} className={join('kit-switch',className)} onClick={()=>onChange(!checked)}><span className="kit-switch-track" aria-hidden="true"/>{label!==undefined&&<span className="kit-switch-label">{label}</span>}{children}</button>;
}

export type Tone='muted'|'ok'|'live'|'warning'|'danger'|'info'|'unread'|'accent';
/** A small status mark: health, goal state, app lights, chat state. */
export function StatusDot({tone='muted',label,className}:{tone?:Tone;label?:string;className?:string}){return <span className={join('kit-dot','kit-tone-'+tone,className)} role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}/>;}
/** A short label in a rounded outline: a branch, a status, a count. */
export function Chip({tone,children,className,title}:{tone?:Tone;children?:React.ReactNode;className?:string;title?:string}){return <span className={join('kit-chip',tone&&'kit-tone-'+tone,className)} title={title}>{children}</span>;}
/** Work in progress, when there is no number to show. */
export function Spinner({label='Working',className}:{label?:string;className?:string}){return <span className={join('kit-spinner',className)} role="status" aria-label={label}/>;}

/** A titled group of related content. */
export function Card({title,children,className,as='section'}:{title?:React.ReactNode;children?:React.ReactNode;className?:string;as?:'section'|'div'|'article'}){
 const Tag=as;return <Tag className={join('kit-card',className)}>{title&&<h3>{title}</h3>}{children}</Tag>;
}
/** One setting: its name and description on the left, its control on the right. */
export function SettingRow({name,description,children,className}:{name:React.ReactNode;description?:React.ReactNode;children?:React.ReactNode;className?:string}){
 return <div className={join('kit-row',className)}><div className="kit-row-text"><span className="kit-row-name">{name}</span>{description&&<small>{description}</small>}</div><div className="kit-row-control">{children}</div></div>;
}
/** A message in the flow of a screen: an error, a warning, a notice. */
export function Notice({tone='info',children,className,role,onDismiss}:{tone?:'info'|'warning'|'danger';children?:React.ReactNode;className?:string;role?:'alert'|'status';onDismiss?:()=>void}){
 return <div className={join('kit-notice','kit-tone-'+tone,className)} role={role}><div className="kit-notice-text">{children}</div>{onDismiss&&<Button iconOnly icon="close" aria-label="Dismiss" onClick={onDismiss}/>}</div>;
}
/** Views of one area, one shown at a time. */
export function Tabs<T extends string>({items,value,onChange,label,className}:{items:{id:T;label:string;icon?:IconName}[];value:T;onChange:(id:T)=>void;label:string;className?:string}){
 return <nav className={join('kit-tabs',className)} aria-label={label}>{items.map(item=><button key={item.id} type="button" aria-pressed={value===item.id} onClick={()=>onChange(item.id)}>{item.icon&&<Icon name={item.icon}/>}<span>{item.label}</span></button>)}</nav>;
}

/** A modal dialog. It stays where it opens (pane-scoped queries and events keep working) and its frame resets what it
 * would inherit there: wrapping, the window drag region, text size and alignment (Export once scrolled sideways from the
 * title bar's no-wrap). */
export function Dialog({title,label,id,className,size='md',busy=false,onClose,header,footer,children,closeLabel='Close',returnFocus}:{title?:React.ReactNode;label?:string;id?:string;className?:string;size?:'sm'|'md'|'lg';busy?:boolean;onClose:()=>void;header?:React.ReactNode;footer?:React.ReactNode;children?:React.ReactNode;closeLabel?:string;
 /** Where focus goes when it closes; the control focused when it opened by default. */returnFocus?:HTMLElement|null}){
 const ref=useRef<HTMLDialogElement>(null),generated=useId(),titleId=id||generated;
 useLayoutEffect(()=>{const element=ref.current;if(!element)return;const previous=returnFocus||document.activeElement as HTMLElement|null;if(!element.open)element.showModal();element.querySelector<HTMLElement>('[data-autofocus]')?.focus();return()=>{element.close();queueMicrotask(()=>{if(previous?.isConnected&&!document.querySelector('dialog[open]'))previous.focus({preventScroll:true});});};},[]);
 return <dialog ref={ref} className={join('kit-dialog','kit-dialog-'+size,className)} aria-labelledby={title&&!label?titleId:undefined} aria-label={label} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
  <header className="kit-dialog-head">{title&&<h2 id={titleId}>{title}</h2>}{header}<Button iconOnly icon="close" aria-label={closeLabel} title={closeLabel+' · Esc'} disabled={busy} onClick={onClose}/></header>
  <div className="kit-dialog-body">{children}</div>
  {footer&&<footer className="kit-dialog-foot">{footer}</footer>}
 </dialog>;
}

export type MenuItem={label:string;icon:IconName;key?:string;action?:()=>void;children?:MenuItem[];danger?:boolean;checked?:boolean;separator?:boolean;disabled?:boolean;title?:string};
/** A menu at a point: keyboard keys, letter shortcuts and one level of submenus. */
export function Menu({x,y,label,items,close,className}:{x:number;y:number;label:string;items:MenuItem[];close:()=>void;className?:string}){
 const root=useRef<HTMLDivElement>(null),main=useRef<HTMLDivElement>(null),sub=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const [active,setActive]=useState<number|null>(null),[anchor,setAnchor]=useState<DOMRect|null>(null);
 function cancel(){clearTimeout(timer.current);}
 function hide(){cancel();timer.current=setTimeout(()=>setActive(null),180);}
 function open(index:number,button:HTMLButtonElement){cancel();trigger.current=button;setAnchor(button.getBoundingClientRect());setActive(index);}
 useLayoutEffect(()=>{const el=main.current!;el.style.left=Math.max(8,Math.min(x,innerWidth-el.offsetWidth-8))+'px';el.style.top=Math.max(8,Math.min(y,innerHeight-el.offsetHeight-8))+'px';el.querySelector('button')?.focus();},[x,y]);
 useLayoutEffect(()=>{if(!sub.current||!anchor)return;const el=sub.current,box=main.current!.getBoundingClientRect();el.style.left=Math.max(8,box.right+el.offsetWidth+4<innerWidth?box.right+2:box.left-el.offsetWidth-2)+'px';el.style.top=Math.max(8,Math.min(anchor.top-6,innerHeight-el.offsetHeight-8))+'px';},[active,anchor]);
 useEffect(()=>{const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))close();};const resize=()=>close();document.addEventListener('pointerdown',outside);window.addEventListener('resize',resize);return()=>{cancel();document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',resize);};},[close]);
 function keys(e:React.KeyboardEvent,children:boolean){
  if(e.ctrlKey||e.altKey||e.metaKey)return;
  const el=children?sub.current!:main.current!,buttons=Array.from(el.querySelectorAll<HTMLButtonElement>('button')),list=children?items[active!].children!:items,index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}
  else if(e.key==='Escape'||e.key==='ArrowLeft'&&children){e.preventDefault();e.stopPropagation();if(children){setActive(null);trigger.current?.focus();}else close();}
  else if(e.key==='Tab'){e.preventDefault();close();}
  else if(e.key==='ArrowRight'&&!children&&list[index]?.children){e.preventDefault();open(index,buttons[index]);requestAnimationFrame(()=>sub.current?.querySelector('button')?.focus());}
  else {const found=list.findIndex(item=>item.key?.toLowerCase()===e.key.toLowerCase());if(found>=0){e.preventDefault();e.stopPropagation();buttons[found].click();}}
 }
 function rows(list:MenuItem[],children=false){return list.map((item,index)=><React.Fragment key={item.label}>{item.separator&&<hr role="separator"/>}<button role="menuitem" aria-label={item.label} aria-keyshortcuts={item.key} aria-haspopup={item.children?'menu':undefined} aria-expanded={item.children?active===index:undefined} disabled={item.disabled} title={item.title} className={item.danger?'danger':''} onPointerEnter={e=>{if(!children){if(item.children)open(index,e.currentTarget);else hide();}else cancel();}} onFocus={()=>{if(!children&&!item.children)setActive(null);}} onClick={e=>{if(item.children){open(index,e.currentTarget);requestAnimationFrame(()=>sub.current?.querySelector('button')?.focus());}else item.action?.();}}><Icon name={item.icon}/><span className="menu-item-label">{item.label}</span>{item.checked&&<Icon name="check"/>}{item.key&&<kbd aria-hidden="true">{item.key}</kbd>}{item.children&&<Icon name="right"/>}</button></React.Fragment>);}
 return <div ref={root} className="sidebar-menu-frame"><div ref={main} className={join('kit-menu sidebar-menu',className)} role="menu" aria-label={label} style={{left:x,top:y}} onKeyDown={e=>keys(e,false)} onPointerLeave={hide}>{rows(items)}</div>{active!==null&&items[active].children&&<div ref={sub} className="kit-menu sidebar-menu sidebar-submenu" role="menu" aria-label={items[active].label} onPointerEnter={cancel} onPointerLeave={hide} onKeyDown={e=>keys(e,true)}>{rows(items[active].children!,true)}</div>}</div>;
}
/** The menu's first name, kept for the screens that still use it. */
export const SidebarMenu=Menu;

/** The house dropdown: a details menu of radio choices. */
export function ChoiceMenu({label,value,options,disabled,onChange}:{label:string,value:string,options:Record<string,string>,disabled?:boolean,onChange:(value:string)=>void}){
  disabled=disabled||!Object.keys(options).length;
  const menu=useRef<HTMLDetailsElement>(null),choices=useRef<HTMLDivElement>(null),groupName=useId();
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current&&!menu.current.contains(event.target as Node))menu.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&menu.current?.open){event.preventDefault();menu.current.open=false;menu.current.querySelector('summary')?.focus();event.stopPropagation();}};
    const position=()=>{
      const element=choices.current,anchor=menu.current;if(!element||!anchor?.open||!anchor.closest('.settings-dialog'))return;
      // The native top layer keeps options outside the page's scroll clip, while
      // retaining them inside the dialog's focus scope and radio group.
      if(!element.hasAttribute('popover'))element.setAttribute('popover','manual');
      const box=anchor.getBoundingClientRect(),width=Math.min(Math.max(box.width,180),innerWidth-24);
      element.style.width=width+'px';element.style.left=Math.max(12,Math.min(box.left,innerWidth-width-12))+'px';
      if(!element.matches(':popover-open'))element.showPopover();
      const below=innerHeight-box.bottom-16,above=box.top-16,up=below<Math.min(element.scrollHeight,240)&&above>below;
      const height=Math.max(48,Math.min(240,up?above:below));element.style.maxHeight=height+'px';
      element.style.top=(up?box.top-element.getBoundingClientRect().height-6:box.bottom+6)+'px';
    };
    const toggle=()=>{if(menu.current?.open){position();menu.current.querySelector<HTMLInputElement>('input:checked')?.focus({preventScroll:true});}else if(choices.current?.matches(':popover-open'))choices.current.hidePopover();};
    const anchor=menu.current;anchor?.addEventListener('toggle',toggle);
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape,true);window.addEventListener('resize',position);document.addEventListener('scroll',position,true);
    return ()=>{anchor?.removeEventListener('toggle',toggle);document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape,true);window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);};
  },[]);
  return <details className="choice-menu" ref={menu}>
    <summary aria-label={label} aria-disabled={disabled} onClick={event=>{if(disabled)event.preventDefault();}}>{options[value]||(Object.keys(options).length?'Choose…':'No options available')} <span aria-hidden="true">⌄</span></summary>
    <div ref={choices} className="choice-options" role="radiogroup" aria-label={label}>{Object.entries(options).map(([id,text])=><label key={id}><input type="radio" name={groupName} value={id} checked={value===id} readOnly onClick={()=>{onChange(id);if(menu.current)menu.current.open=false;menu.current?.querySelector('summary')?.focus();}}/><span>{text}</span><span className="choice-check" aria-hidden="true">{value===id?'✓':''}</span></label>)}</div>
  </details>;
}
