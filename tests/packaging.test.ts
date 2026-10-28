import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The installed app copies backend files by name; a feature whose requirement list is left out cannot install.
test('every app feature\'s requirement list and pin file ships in the installer',()=>{
 const filter:string[]=JSON.parse(fs.readFileSync('package.json','utf8')).build.extraResources.find((row:any)=>row.from==='backend').filter;
 const features=[...fs.readFileSync('backend/plugin_setup.py','utf8').matchAll(/'([\w-]+-requirements\.txt)'/g)].map(match=>match[1]);
 assert.ok(features.length>=3);
 for(const file of [...features,'feature-wheels.json','whisper-models.json'])assert.ok(filter.includes(file),file+' is missing from package.json build.extraResources');
});
