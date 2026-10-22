export type Route={model:string;models?:string[];reason:'selected'|'previous'|'app-previous'|'jev'};
export async function route(input:{selected:string[];eligible:string[];previous:string|null;appPrevious?:string|null},jev?:()=>Promise<string>):Promise<Route>{
  if(input.selected.length){
    if(input.selected.some(model=>!input.eligible.includes(model)))throw Error('The selected model is unavailable. Choose an available model.');
    const models=[...new Set(input.selected)];
    return {model:models[0],...(models.length>1?{models}:{}),reason:'selected'};
  }
  if(jev){try{const model=await jev();if(input.eligible.includes(model))return {model,reason:'jev'};}catch{/* Unavailable Jev uses the approved manual/previous-model path. */}}
  if(input.previous&&input.eligible.includes(input.previous))return {model:input.previous,reason:'previous'};
  if(input.appPrevious&&input.eligible.includes(input.appPrevious))return {model:input.appPrevious,reason:'app-previous'};
  throw Error('Select a connected model in the model row for the first reply.');
}
