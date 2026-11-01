// Independent synthetic record and canonicalization scenes; diagnostic names are neutral.
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const subject=process.env.TEAM_GPT_SUBJECT_ROOT??resolve(import.meta.dir,'..');
const owner=await import(pathToFileURL(join(subject,'src/client/owner-action.ts')).href);
const {actionRequestsFolder}=await import(pathToFileURL(join(subject,'src/client/team-create.ts')).href);
const canonical=await import(pathToFileURL(join(subject,'src/workflow/canonical.ts')).href);
const {readScript}=await import(pathToFileURL(join(subject,'src/workflow/dry/script.ts')).href);
const field='__'+'proto'+'__';
function params() {return {kind:'owner-action',actions:['team-config'],root:'/fixture/root',team:'fixture',head:null,args:{'team-config':'fixture-hash'},requested_by:'fixture',words:{'team-config':['set','watch.interval','7s']},requesters:['zeta','alpha']};}
function withOwned(value:unknown) {return JSON.parse(JSON.stringify({[field]:value}));}
for(const [index,where] of ['args','words'].entries())test(`R1${index+1}: owned argument data changes identity`,()=>{
 const first=params(),second=params();
 Reflect.set(first,where,withOwned(where==='words'?['first']:'first'));
 Reflect.set(second,where,withOwned(where==='words'?['second']:'second'));
 expect(owner.ownerActionHash(first)!==owner.ownerActionHash(second)).toBe(true);
});
for(const [index,actions] of [['fixture-action'],[],['team-config','fixture-action'],[7]].entries())test(`R2${index+1}: unsupported action record is refused at the reader`,()=>{
 const home=mkdtempSync(join(tmpdir(),'gpt-record-gate-'));const folder=actionRequestsFolder(home);mkdirSync(folder,{recursive:true});
 const id='oa_'+'a'.repeat(24), value={...params(),actions};
 writeFileSync(join(folder,id+'.json'),JSON.stringify({request_id:id,params:value,params_sha256:owner.ownerActionHash(value),created:'2026-11-01T00:00:00Z',expires_at:'2026-11-01T00:15:00Z'}));
 const read=owner.readOwnerActionRecord(home,id);
 expect(typeof read==='string' && read.includes('action this build does not know')).toBe(true);
});
for(const [index,wrap] of [(v:unknown)=>v,(v:unknown)=>({outer:v}),(v:unknown)=>[{outer:v}]].entries())test(`R3${index+1}: owned workflow data remains part of bytes and digest`,()=>{
 const first=wrap(withOwned({value:1})), second=wrap(withOwned({value:2}));
 const bytes=canonical.canonicalJson(first),other=canonical.canonicalJson(second);
 expect(bytes!==other && canonical.payloadDigest(bytes)!==canonical.payloadDigest(other)).toBe(true);
 expect(JSON.stringify(JSON.parse(bytes))===JSON.stringify(first)).toBe(true);
});
function script(section:number) {
 const settings=section===0?`  ${field}: "fixture"`:'  ordinary: "fixture"';
 const inputs=section===1?`  ${field}: "fixture"`:'  ordinary: "fixture"';
 const evidence=section===2?`  ${field}:
    ordinary: "fixture"`:section===3?`  item:
    ${field}: "fixture"`:section===4?`  item:
    nested:
      ${field}:
        value: 7`:section===5?`  item:
    nested:
      - ${field}:
          value: 7`:`  item:
    ordinary: "fixture"`;
 return `format: 1
target: fixture
artifact: {kind: none}
settings:
${settings}
inputs:
${inputs}
evidence:
${evidence}
signals: []
`;
}
const shared=[Object.prototype,Function.prototype,Array.prototype,Object,Function,Array];
function snapshotShared() {return shared.map(target=>({target,descriptors:Object.getOwnPropertyDescriptors(target)}));}
function sharedUnchanged(before:ReturnType<typeof snapshotShared>) {
 return before.every(({target,descriptors})=>{
  const after=Object.getOwnPropertyDescriptors(target),keys=Reflect.ownKeys(descriptors);
  return keys.length===Reflect.ownKeys(after).length&&keys.every(key=>{
   const left=Reflect.get(descriptors,key),right=Reflect.get(after,key);
   return right!==undefined&&['value','get','set','writable','enumerable','configurable'].every(part=>Object.is(left[part],right[part]));
  });
 });
}
function restoreShared(before:ReturnType<typeof snapshotShared>) {
 for(const {target,descriptors} of before) {
  for(const key of Reflect.ownKeys(target))if(!Object.prototype.hasOwnProperty.call(descriptors,key))Reflect.deleteProperty(target,key);
  Object.defineProperties(target,descriptors);
 }
}
for(let index=0;index<6;index++)test(`R4${index+1}: dry reader refuses an unsupported mapping field without effects`,()=>{
 const before=snapshotShared(),writes:string[]=[];
 const fileWrite=spyOn(fs,'writeFileSync').mockImplementation(()=>{writes.push('file');throw new Error('unexpected file write');});
 const bunWrite=spyOn(Bun,'write').mockImplementation(()=>{writes.push('bun');throw new Error('unexpected file write');});
 let result:ReturnType<typeof readScript>|undefined,unchanged=false;
 try {result=readScript(script(index));unchanged=sharedUnchanged(before);}
 finally {fileWrite.mockRestore();bunWrite.mockRestore();if(!sharedUnchanged(before))restoreShared(before);}
 expect(result).toEqual({ok:false,code:'workflow.script',why:`line ${[5,7,9,10,11,11][index]}: a map key may not be "${field}"`});
 expect(unchanged).toBe(true);
 expect(writes).toEqual([]);
});
test('R90: ordinary record hashes and workflow digests keep their pinned values',()=>{
 expect(owner.ownerActionHash(params())).toBe('99a13204e0a284b52e9ca694144b3ba165aced045cc81b9d89e12518219a8b29');
 const value={b:'fixture',a:[3,{y:null,x:true}]};
 const bytes=canonical.canonicalJson(value);
 expect(bytes).toBe('{"a":[3,{"x":true,"y":null}],"b":"fixture"}');
 expect(canonical.payloadDigest(bytes)).toBe('sha256:3e6ed9e12ad18c99563d35104e23495698710d83e90572d1aadc5c6e5da80e80');
 const result=readScript(script(6));expect(result.ok).toBe(true);if(!result.ok)return;
 expect(JSON.stringify(result.script.settings)).toBe('{"ordinary":"fixture"}');
 const home=mkdtempSync(join(tmpdir(),'gpt-ordinary-record-')), folder=actionRequestsFolder(home);mkdirSync(folder,{recursive:true});
 const id='oa_'+'b'.repeat(24), valueRecord=params();
 writeFileSync(join(folder,id+'.json'),JSON.stringify({request_id:id,params:valueRecord,params_sha256:owner.ownerActionHash(valueRecord),created:'2026-11-01T00:00:00Z',expires_at:'2026-11-01T00:15:00Z'}));
 expect(typeof owner.readOwnerActionRecord(home,id)).toBe('object');
});
