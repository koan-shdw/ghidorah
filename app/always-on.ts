// Settings, Always on: start with Windows and stay awake. No Electron here; main applies the result.
export type StayAwake='always'|'remote'|'off';
export interface AlwaysOn {startWithWindows:boolean;stayAwake:StayAwake;desktopNotifications:boolean;questionSound:boolean;}
export const stayAwakeChoices:Record<StayAwake,string>={always:'Always',remote:'Only while remote is on',off:'Off'};

// Off and "only while remote is on" are the defaults (PLAN 1, his picks).
export function readAlwaysOn(row:any):AlwaysOn {
 return {startWithWindows:row?.startWithWindows===true,stayAwake:Object.hasOwn(stayAwakeChoices,row?.stayAwake)?row.stayAwake:'remote',desktopNotifications:row?.desktopNotifications!==false,questionSound:row?.questionSound!==false};
}

// The sign-in entry. It points at whatever build is running, so main re-registers it at every start while it is on.
// A test profile writes its own entry name and never the real one.
export function loginItem({packaged,execPath,appFolder,testData}:{packaged:boolean;execPath:string;appFolder:string;testData?:string}){
 return {path:execPath,args:[...(packaged?[]:[appFolder]),'--hidden'],name:testData?'Ghidorah Test '+testData.split(/[\\/]/).filter(Boolean).at(-1):packaged?'Ghidorah':'Ghidorah Dev'};
}

export function keepAwake(setting:StayAwake,remoteOn:boolean){return setting==='always'||setting==='remote'&&remoteOn;}
