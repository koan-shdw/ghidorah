// GLiNER2.5-Decide (3a-4) and Not Diamond (3a-5) each answer one question: which model answers this message.
// Koan's own picks are kept as they are; with two or more, they run together.
import type {JevDecision,JevSettings,JevState} from './jev';

export function ownPicks(state:JevState):JevDecision|null {
 const picks=[...new Set(state.selected)].filter(id=>state.models.some(model=>model.id===id&&model.available));
 if(!picks.length)return null;
 return {model:picks[0],...(picks.length>1?{models:picks}:{}),order:[],confidence:NaN,message:picks.length>1?'Your picks answer together.':'Your pick answers.',answers:null,usage:null,elapsedMs:0};
}

// One label per available model: its name and abilities, so the classifier reads what each model does.
export function glinerLabels(state:JevState){
 const available=state.models.filter(model=>model.available);
 return available.map(model=>{const text=model.label+' ('+model.capabilities.join(', ')+')';return {id:model.id,label:available.filter(other=>other.label===model.label).length>1?text+' · '+model.id:text};});
}

export function parseGliner(result:any,labels:{id:string;label:string}[],settings:JevSettings,elapsedMs=0,name='GLiNER'):JevDecision {
 const match=labels.find(row=>row.label===result?.label),confidence=result?.confidence;
 if(!match||typeof confidence!=='number'||!Number.isFinite(confidence)||confidence<0||confidence>1)throw Error(name+' returned an invalid decision.');
 if(confidence<settings.confidence)return {model:null,order:[],confidence,message:name+' is unsure. Choose a model for this message.',answers:result,usage:null,elapsedMs};
 return {model:match.id,order:[match.id],confidence,message:name+' selected this model.',answers:result,usage:null,elapsedMs};
}
