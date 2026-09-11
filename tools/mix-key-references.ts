import fs from 'node:fs/promises';
import path from 'node:path';
import { read } from '../mix/electron/manifest.ts';
import { importKeyReference } from '../mix/electron/keyExperiments.ts';
import type { KeyReference } from '../mix/src/keyExperiments.ts';
const [root,inventory,flag]=process.argv.slice(2);
if(!root||!inventory||(flag&&flag!=='--write'))throw new Error('Usage: node tools/mix-key-references.ts LIBRARY INVENTORY.json [--write] (default: preview only)');
const document=JSON.parse(await fs.readFile(inventory,'utf8')) as {version:number;entries:(Omit<KeyReference,'sourceHash'>&{trackId:string;title:string;artist:string})[]};
if(document.version!==1||!Array.isArray(document.entries))throw new Error('Unsupported reference inventory');
const tracks=(await read(root)).tracks;
let saved=0,preserved=0,missing=0;
for(const entry of document.entries){
  const track=tracks.find(t=>t.id===entry.trackId);
  if(!track){missing++;console.log(`Missing library track: ${entry.title}`);continue;}
  const {trackId,title,artist,...reference}=entry;
  if(flag==='--write'){
    const outcome=await importKeyReference(path.resolve(root),trackId,reference);
    if(outcome==='saved')saved++;else preserved++;
  }
  console.log(`${track.title}: ${reference.verification} · ${reference.labels.join(' / ')||'unset'}`);
}
console.log(`${flag==='--write'?'Imported':'Preview'}: ${saved} saved, ${preserved} person-verified references preserved, ${missing} missing tracks. No inference or canonical metadata writes.`);
