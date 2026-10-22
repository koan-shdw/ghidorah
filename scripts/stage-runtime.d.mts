export function stageRuntime(appRoot:string,fork:string,folder?:string):Promise<{upstream:string;fork:string;files:Record<string,string>}>;
