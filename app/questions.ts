export function readQuestions(params:any){
 const rows:any[]=Array.isArray(params?.questions)?params.questions:[{...params,qid:'single'}];
 return rows.map((q:any,index:number)=>({
  qid:String(q.qid??q.id??index),question:String(q.question||''),header:String(q.header||''),
  choices:(Array.isArray(q.choices)?q.choices:[]).filter((value:unknown):value is string=>typeof value==='string'),
  descriptions:Array.isArray(q.descriptions)?q.descriptions:[],multi:q.multi_select===true,
 }));
}

export function questionResult(params:any,answers:unknown){
 if(!answers||typeof answers!=='object'||Array.isArray(answers))throw Error('Answer each question before sending.');
 const result:Record<string,string>={};
 for(const q of readQuestions(params)){
  const answer=(answers as Record<string,unknown>)[q.qid];
  if(typeof answer!=='string'||!answer.trim())throw Error('Answer each question before sending.');
  result[q.qid]=answer.trim();
 }
 if(!Object.keys(result).length)throw Error('This request contains no questions.');
 return Array.isArray(params.questions)?{answers:result}:{answer:result.single};
}

// Hermes accepts JSON selections; Claude's answer map uses text. Remote free text stays intact.
export function nativeQuestionAnswer(answer:string){
 try{const values=JSON.parse(answer);if(Array.isArray(values)&&values.every(value=>typeof value==='string'))return values.join(', ');}catch{}
 return answer||'';
}
