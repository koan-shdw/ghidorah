import React,{useId,useRef,useState} from 'react';
import {readQuestions,questionResult} from './questions';

export function Question({item,call,review}:{item:any;call:(method:string,args:any)=>Promise<any>;review?:React.ReactNode}){
 const questions=readQuestions(item.params),id=useId(),sending=useRef(false);
 const [selected,setSelected]=useState<Record<string,string[]>>(()=>Object.fromEntries(questions.map(q=>[q.qid,q.multi?[]:q.choices.slice(0,1)])));
 const [custom,setCustom]=useState<Record<string,string>>({}),[own,setOwn]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const answers=Object.fromEntries(questions.map(q=>{
  const values=[...(selected[q.qid]||[]),...((own[q.qid]||!q.choices.length)&&custom[q.qid]?.trim()?[custom[q.qid].trim()]:[])];
  return [q.qid,q.multi?(values.length?JSON.stringify(values):''):values[0]||''];
 }));
 const ready=questions.length>0&&questions.every(q=>answers[q.qid]&&(!(own[q.qid]||!q.choices.length)||custom[q.qid]?.trim()));
 const submit=async(event:React.FormEvent)=>{
  event.preventDefault();if(!ready||sending.current)return;
  sending.current=true;setBusy(true);setError('');
  try{questionResult(item.params,answers);await call('answer',{id:item.id,answers});}
  catch(error){setError(String(error).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}
  finally{sending.current=false;setBusy(false);}
 };
 return <div className="approval question-card"><form aria-label="Questions waiting for your answer" onSubmit={event=>void submit(event)} onKeyDown={event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();event.currentTarget.requestSubmit();}}}>
  <header><strong>Your answer is needed</strong><span>{questions.length>1?`${questions.length} questions`:'Choose an option or write your own'}</span></header>
  {questions.map((q,index)=><fieldset key={q.qid} disabled={busy}>
   <legend>{q.header&&<small>{q.header}</small>}{questions.length>1&&<span className="question-number">{index+1}. </span>}{q.question}</legend>
   {q.multi&&<p className="hint">Select all that apply.</p>}
   <div className="question-choices">{q.choices.map((choice:string,choiceIndex:number)=>{
    const checked=(selected[q.qid]||[]).includes(choice),recommended=/\s*\(Recommended\)\s*$/i.test(choice);
    return <label className={'question-choice'+(checked?' selected':'')} key={choiceIndex}>
     <input type={q.multi?'checkbox':'radio'} name={id+q.qid} checked={checked} onChange={()=>{setSelected(previous=>({...previous,[q.qid]:q.multi?(checked?(previous[q.qid]||[]).filter(value=>value!==choice):[...(previous[q.qid]||[]),choice]):[choice]}));if(!q.multi)setOwn(previous=>({...previous,[q.qid]:false}));}}/>
     <span><span className="question-choice-title">{choice.replace(/\s*\(Recommended\)\s*$/i,'')}{recommended&&<small>Recommended</small>}</span>{typeof q.descriptions[choiceIndex]==='string'&&q.descriptions[choiceIndex]&&<span className="question-description">{q.descriptions[choiceIndex]}</span>}</span>
    </label>;
   })}
   {!!q.choices.length&&<label className={'question-choice'+(own[q.qid]?' selected':'')}><input type={q.multi?'checkbox':'radio'} name={id+q.qid} checked={!!own[q.qid]} onChange={()=>{setOwn(previous=>({...previous,[q.qid]:q.multi?!previous[q.qid]:true}));if(!q.multi)setSelected(previous=>({...previous,[q.qid]:[]}));}}/><span>Something else</span></label>}
   </div>
   {(own[q.qid]||!q.choices.length)&&<textarea aria-label={'Your answer: '+q.question} placeholder="Write your answer…" value={custom[q.qid]||''} onChange={event=>setCustom({...custom,[q.qid]:event.target.value})} rows={2}/>}
  </fieldset>)}
  {error&&<p className="error" role="alert">{error}</p>}
  <footer><span className="hint">Ctrl + Enter to send</span><button type="submit" className="primary" disabled={!ready||busy}>{busy?'Sending…':'Send answer'}</button></footer>
 </form>{review}</div>;
}
