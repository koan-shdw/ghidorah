// Moves the tool outputs saved whole by earlier versions into the results table and compacts the file (OUTPUTS
// 2026-11-09). The app does the same a few rows at a time after its window opens; this runs it to the end at once.
//   node --import tsx scripts/split-results.ts <path to chat.sqlite> [--keep-days 14]
// --keep-days also ages out the whole outputs older than that many days before compacting (what the app does daily).
// The app must be closed, and a backup made first. Needs free space on the drive for the compacted copy.
import fs from 'node:fs';
import {Store} from '../app/store';

const file=process.argv[2],keepAt=process.argv.indexOf('--keep-days'),keepDays=keepAt>0?Number(process.argv[keepAt+1]):0;
if(!file||!fs.existsSync(file)){console.error('Usage: node --import tsx scripts/split-results.ts <chat.sqlite>');process.exit(2);}
const mb=(bytes:number)=>(bytes/1e6).toFixed(0)+' MB';
const seconds=(since:number)=>((Date.now()-since)/1000).toFixed(0)+' s';
const store=new Store(file),started=Date.now();
const count=(sql:string)=>Number((store.db.prepare(sql).get() as any)?.n||0);
console.log(`before: ${mb(fs.statSync(file).size)}; tool+action rows ${mb(count("SELECT sum(length(data)) AS n FROM records WHERE kind IN ('tool','work-action')"))}`);
let rounds=0;
while(!store.splitResults(200))if(++rounds%25===0)console.log(`  ${rounds*200} rows looked at, ${seconds(started)}`);
console.log(`split done in ${seconds(started)}: tool+action rows ${mb(count("SELECT sum(length(data)) AS n FROM records WHERE kind IN ('tool','work-action')"))}, results ${count('SELECT count(*) AS n FROM results')} rows ${mb(count('SELECT sum(length(data)) AS n FROM results'))}`);
if(keepDays>0){const aging=Date.now();while(!store.ageResults(keepDays,200));console.log(`aged out outputs older than ${keepDays} days in ${seconds(aging)}: results ${count('SELECT count(*) AS n FROM results')} rows ${mb(count('SELECT sum(length(data)) AS n FROM results'))}`);}
store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const compacting=Date.now();console.log('compacting…');store.db.exec('VACUUM');console.log(`compacted in ${seconds(compacting)}`);
store.db.close();
console.log(`after: ${mb(fs.statSync(file).size)}`);
