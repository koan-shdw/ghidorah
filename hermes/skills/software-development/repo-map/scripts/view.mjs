import {areaOf, rankFiles, contextText, isTest} from './query.mjs';

export function mountGraph(host, map) {
  const root=host.shadowRoot||host.attachShadow({mode:'open'});root.replaceChildren();
  const style=document.createElement('style');style.textContent=`
:host{display:block;color:var(--text,#dce7f5);font:12px/1.5 system-ui;min-width:0}
*{box-sizing:border-box}button,input,select{font:inherit;color:inherit;background:var(--surface,#111b2b);border:1px solid var(--line,#2b3b51);border-radius:7px;padding:6px 9px}button{cursor:pointer}button[aria-pressed=true]{border-color:#69ddcf;color:#69ddcf}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #69ddcf}input[type=search]{flex:1;min-width:160px}header{display:flex;gap:7px;flex-wrap:wrap;align-items:center;padding:12px;border-bottom:1px solid var(--line,#2b3b51)}label{display:flex;gap:5px;align-items:center}.shell{border:1px solid var(--line,#2b3b51);border-radius:12px;overflow:hidden;background:var(--surface,#0c1320)}.meta{padding:9px 12px;color:var(--muted,#90a1b8);font-size:11px}.stage{position:relative;height:390px;background:radial-gradient(ellipse at center,#1b3b4828,transparent 70%)}.floor{position:absolute;bottom:0;left:0;width:100%;height:24%;pointer-events:none;stroke:var(--muted,#90a1b8);stroke-width:1;opacity:.3;fill:none}canvas{position:relative;width:100%;height:100%;display:block}.crumb{position:absolute;top:10px;left:12px;color:var(--muted,#90a1b8);pointer-events:none}.bottom{display:grid;grid-template-columns:minmax(150px,1fr) minmax(180px,1.6fr);border-top:1px solid var(--line,#2b3b51)}.list,.detail{padding:12px;max-height:290px;overflow:auto;min-width:0}.list{border-right:1px solid var(--line,#2b3b51)}.list button{display:block;text-align:left;width:100%;margin-bottom:5px;overflow-wrap:anywhere;background:transparent}.detail pre{font:11px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.warning{color:#efc776}details{padding:8px 12px}summary{cursor:pointer}p{margin:4px 0}@media(max-width:500px){.bottom{grid-template-columns:1fr}.list{max-height:150px;border-right:0}.stage{height:300px}}`;
  style.textContent+=`.knowledge{padding:12px;border-bottom:1px solid var(--line,#2b3b51)}.knowledge h3{margin:0 0 8px;font-size:12px}.claims{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;max-height:200px;overflow:auto}.claim{border-left:2px solid #6ad5c5;padding-left:10px}.claim small{color:var(--muted,#90a1b8)}.claim button{padding:2px 5px;margin:4px 4px 0 0;font:10px ui-monospace,monospace}.claim.warning{border-color:#efc776}.zoom input{width:80px;padding:0}.zoom output{min-width:34px}.list button[aria-pressed=true]{background:#6ad5c510}`;
  root.append(style);
  const el=(tag,text,parent)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(parent)parent.append(node);return node;};
  const shell=el('section',undefined,root);shell.className='shell';shell.setAttribute('aria-label','Repository graph');
  const header=el('header',undefined,shell), search=el('input',undefined,header);search.type='search';search.placeholder='Find an idea, file or symbol…';search.setAttribute('aria-label','Find map idea');
  const mode2=el('button','2D',header),mode3=el('button','3D',header),spinLabel=el('label',undefined,header),spinControl=el('input',undefined,spinLabel);spinControl.type='checkbox';spinLabel.append(document.createTextNode('Rotate'));
  const back=el('button','All areas',header);back.setAttribute('aria-label','Show all map areas');
  const zoomLabel=el('label','Zoom',header);zoomLabel.className='zoom';const zoomControl=el('input',undefined,zoomLabel);zoomControl.type='range';zoomControl.min='60';zoomControl.max='160';zoomControl.step='10';zoomControl.value='100';zoomControl.setAttribute('aria-label','Map zoom');const zoomValue=el('output','100%',zoomLabel);
  const meta=el('div',undefined,shell);meta.className='meta';meta.textContent=`${map.files.length} files · ${map.files.reduce((n,f)=>n+f.symbols.length,0)} symbols · ${map.edges.length} local imports · ${map.stats.reused} reused / ${map.stats.parsed} parsed`;
  const status=el('div',undefined,shell);status.className='meta'+(map.partial?' warning':'');status.textContent=`${map.partial?'Partial map':'Source snapshot'} · ${new Date(map.generatedAt).toLocaleString()} · ${map.unresolved.length} external/unresolved imports. Not runtime wiring or test coverage.`;
  if(map.claims?.length){
    const knowledge=el('section',undefined,shell);knowledge.className='knowledge';knowledge.setAttribute('aria-label','Repository knowledge');el('h3','How this repository works',knowledge);
    const claims=el('div',undefined,knowledge);claims.className='claims';
    for(const claim of map.claims){
      const card=el('div',undefined,claims);card.className='claim'+(claim.status==='current'?'':' warning');el('small',`${claim.kind} · ${claim.status==='current'?'source unchanged':claim.status+' evidence'}`,card);el('p',claim.text,card);
      for(const evidence of claim.evidence){const button=el('button',`${evidence.path}:${evidence.line}`,card);button.disabled=!map.files.some(f=>f.path===evidence.path);button.onclick=()=>{area=areaOf(evidence.path);query='';search.value='';rebuild();select(evidence.path,evidence.line);pre.focus();};}
    }
  }
  const stage=el('div',undefined,shell);stage.className='stage';
  // The floor belongs to the stage, never to the graph's rotating coordinate system.
  const floor=document.createElementNS('http://www.w3.org/2000/svg','svg');floor.setAttribute('class','floor');floor.setAttribute('viewBox','0 0 1000 180');floor.setAttribute('preserveAspectRatio','none');floor.setAttribute('aria-hidden','true');stage.append(floor);
  const grid=document.createElementNS('http://www.w3.org/2000/svg','path'),lines=[];
  for(let x=0;x<=1000;x+=100)lines.push(`M ${400+x*.2} 0 L ${x} 180`);
  for(const y of [0,12,30,60,105,180])lines.push(`M ${400*(1-y/180)} ${y} L ${600+400*y/180} ${y}`);
  grid.setAttribute('d',lines.join(' '));floor.append(grid);
  const canvas=el('canvas',undefined,stage);canvas.setAttribute('aria-label','Connected repository rings');const crumb=el('div','Areas · click a ring to explore files',stage);crumb.className='crumb';
  const bottom=el('div',undefined,shell);bottom.className='bottom';const list=el('div',undefined,bottom);list.className='list';list.setAttribute('aria-label','Map items');const detail=el('div',undefined,bottom);detail.className='detail';const pre=el('pre','Choose an area, then a file for symbols and reverse imports.',detail);pre.tabIndex=-1;
  const limitations=el('details',undefined,shell);el('summary','Scope, evidence and limitations',limitations);el('p',map.scope,limitations);el('p','Idea matching is lexical relevance plus one import hop, not a guarantee of what a change affects. JS/TS and Python use ASTs; other languages have inventory only.',limitations);
  if(map.notesError)el('p',map.notesError,limitations);
  for(const issue of map.issues.slice(0,30))el('p',issue.path+': '+issue.reason,limitations);
  if(map.issues.length>30)el('p',`${map.issues.length-30} more issues in .repo-map/index.json`,limitations);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let mode='2d',spin=false,area='',query='',rotation=0,zoom=1,nodes=[],edges=[],hits=new Set(),selected='',points=[],frame=0,previousTime=0,disposed=false;
  const ctx=canvas.getContext('2d');
  function select(id,line=0){
    if(!area){area=id;selected='';pre.textContent='Choose a file for symbols and reverse imports.';rebuild();return;}
    selected=id;pre.textContent=contextText(map,{file:id,line,budget:12000});for(const button of list.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.path===id));draw();
  }
  function rebuild(){
    const ranked=rankFiles(map,query),matching=new Set(ranked.map(r=>r.file.path));
    const grouped=new Map();
    for(const file of map.files){const id=areaOf(file.path);if(!grouped.has(id))grouped.set(id,{id,files:[],weight:0});const g=grouped.get(id);g.files.push(file);g.weight+=file.symbols.length+1;}
    const chosen=area?rankFiles(map).filter(r=>areaOf(r.file.path)===area).map(r=>r.file):[];
    nodes=area?chosen.slice(0,120).map(f=>({id:f.path,label:f.path.split('/').at(-1),weight:f.symbols.length+1,test:isTest(f.path)})):[...grouped.values()].map(g=>({id:g.id,label:g.id,weight:g.weight,test:g.files.every(f=>isTest(f.path))}));
    hits=new Set(nodes.filter(n=>area?matching.has(n.id):grouped.get(n.id).files.some(f=>matching.has(f.path))).map(n=>n.id));
    const ids=new Set(nodes.map(n=>n.id)),pairs=new Map();
    for(const e of map.edges){const from=area?e.from:areaOf(e.from),to=area?e.to:areaOf(e.to);if(from===to||!ids.has(from)||!ids.has(to))continue;const key=JSON.stringify([from,to]);pairs.set(key,{from,to,count:(pairs.get(key)?.count||0)+1});}
    edges=[...pairs.values()];
    nodes.forEach((n,i)=>{const angle=i*2.399963229728653,y=nodes.length===1?0:1-2*i/(nodes.length-1),r=Math.sqrt(1-y*y);n.x=Math.cos(angle)*r;n.y=y;n.z=Math.sin(angle)*r;n.r=17+Math.min(20,Math.sqrt(n.weight)*1.5);});
    crumb.textContent=area?`${area} · ${chosen.length} files${chosen.length>120?' · top 120 shown; filter using the list':''}`:'Areas · click a ring to explore files';
    list.replaceChildren();
    const items=area?ranked.filter(r=>areaOf(r.file.path)===area).map(r=>({id:r.file.path,label:r.file.path,reason:r.reason})):nodes.filter(n=>!query||hits.has(n.id)).map(n=>({id:n.id,label:n.id,reason:grouped.get(n.id).files.length+' files'}));
    for(const item of items.slice(0,80)){const button=el('button',item.label+' · '+item.reason,list);button.dataset.path=item.id;if(area)button.setAttribute('aria-pressed',String(selected===item.id));button.onclick=()=>select(item.id);}
    if(!items.length)el('p','No matches. Try a file or symbol name.',list);
    if(items.length>80)el('p',`${items.length-80} more results; narrow your query.`,list);
    back.disabled=!area;draw();
  }
  function draw(){
    if(disposed)return;
    const rect=stage.getBoundingClientRect(),w=rect.width,h=rect.height,dpr=Math.min(devicePixelRatio||1,2);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const scale=Math.max(25,Math.min(w/2-55,h/2-45))*zoom,cos=Math.cos(rotation),sin=Math.sin(rotation);
    points=nodes.map((n,i)=>{const angle=2*Math.PI*i/Math.max(1,nodes.length)-Math.PI/2,flat=mode==='2d',x=flat?(nodes.length===1?0:Math.cos(angle)):n.x*cos-n.z*sin,z=flat?0:n.x*sin+n.z*cos,y=flat?(nodes.length===1?0:Math.sin(angle)):n.y,p=1/(1+z*.28);return {n,x:w/2+x*scale*p,y:h/2+y*scale*p,z,r:n.r*p};}).sort((a,b)=>b.z-a.z);
    const byId=new Map(points.map(p=>[p.n.id,p]));
    for(const edge of edges){const a=byId.get(edge.from),b=byId.get(edge.to),dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;if(d<a.r+b.r+8)continue;const hot=!query||hits.has(a.n.id)&&hits.has(b.n.id);ctx.strokeStyle=hot?'#5baea977':'#8294aa18';ctx.lineWidth=Math.min(3,1+Math.log2(edge.count+1)*.4);const x1=a.x+dx/d*(a.r+2),y1=a.y+dy/d*(a.r+2),x2=b.x-dx/d*(b.r+5),y2=b.y-dy/d*(b.r+5);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.beginPath();ctx.moveTo(x2-dx/d*7-dy/d*3,y2-dy/d*7+dx/d*3);ctx.lineTo(x2,y2);ctx.lineTo(x2-dx/d*7+dy/d*3,y2-dy/d*7-dx/d*3);ctx.stroke();}
    for(const p of points){const hot=query&&hits.has(p.n.id)||selected===p.n.id;ctx.globalAlpha=query&&!hits.has(p.n.id)?.16:1;ctx.strokeStyle=p.n.test?'#eac276':'#6ad5c5';ctx.lineWidth=hot?2.5:1.4;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=hot?16:0;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,2*Math.PI);ctx.stroke();ctx.shadowBlur=0;ctx.font='11px system-ui';ctx.textAlign='center';ctx.fillStyle=getComputedStyle(host).color;ctx.fillText(p.n.label.length>22?p.n.label.slice(0,21)+'…':p.n.label,p.x,p.y+p.r+15);ctx.globalAlpha=1;}
  }
  function animate(time){frame=0;if(disposed||!spin||mode!=='3d'||document.hidden)return;if(previousTime)rotation+=(time-previousTime)*.00018;previousTime=time;draw();frame=requestAnimationFrame(animate);}
  function schedule(){cancelAnimationFrame(frame);previousTime=0;if(spin&&mode==='3d'&&!document.hidden)frame=requestAnimationFrame(animate);else draw();}
  function setMode(value){mode=value;mode2.setAttribute('aria-pressed',String(mode==='2d'));mode3.setAttribute('aria-pressed',String(mode==='3d'));spinControl.disabled=mode==='2d';schedule();}
  mode2.onclick=()=>setMode('2d');mode3.onclick=()=>setMode('3d');spinControl.onchange=()=>{spin=spinControl.checked;schedule();};
  zoomControl.oninput=()=>{zoom=Number(zoomControl.value)/100;zoomValue.textContent=zoomControl.value+'%';draw();};
  search.oninput=()=>{query=search.value;rebuild();};back.onclick=()=>{area='';selected='';pre.textContent='Choose an area, then a file for symbols and reverse imports.';rebuild();};
  canvas.onclick=event=>{const rect=canvas.getBoundingClientRect();const hit=[...points].reverse().find(p=>Math.hypot(event.clientX-rect.left-p.x,event.clientY-rect.top-p.y)<=p.r+8);if(hit)select(hit.n.id);};
  const observer=new ResizeObserver(draw);observer.observe(stage);document.addEventListener('visibilitychange',schedule);
  // Honour reduced motion; rotation always remains an explicit user choice.
  if(reduced)spinControl.title='Reduced motion is enabled; rotation is off by default.';
  setMode('2d');rebuild();
  return ()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener('visibilitychange',schedule);root.replaceChildren();};
}
