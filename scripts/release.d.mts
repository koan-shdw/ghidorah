export interface Release {version:string;date:string;notes:string[]}
export function withNotes(history:Release[],version:string,notes:string[],date:string):Release[];
export function historyText(history:Release[]):string;
