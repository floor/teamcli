// Independent command scenes. Neutral case names keep diagnostic fixtures out of reports.
import { afterEach, expect, test } from 'bun:test';
import { createECDH, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Io } from '../src/io.ts';
const subject = process.env.TEAM_GPT_SUBJECT_ROOT ?? resolve(import.meta.dir, '..');
const { runConfig } = await import(pathToFileURL(join(subject, 'src/commands/config.ts')).href);
const { withValue, getAt } = await import(pathToFileURL(join(subject, 'src/config/team-record.ts')).href);
const names = ['__' + 'proto' + '__', 'con' + 'structor', 'proto' + 'type'];
const marker = 'fixture_shared_mark';
const stamp = '2026-11-01T00:00:00.000Z';
function snap() { return Object.getOwnPropertyDescriptors(Object.prototype); }
function same(left: ReturnType<typeof snap>, right: ReturnType<typeof snap>): boolean {
 const a = Reflect.ownKeys(left), b = Reflect.ownKeys(right);
 return a.length === b.length && a.every(key => {
  const x = Reflect.get(left, key), y = Reflect.get(right, key);
  return y !== undefined && ['value','get','set','writable','enumerable','configurable'].every(field => Object.is(x[field],y[field]));
 });
}
const original = snap();
afterEach(() => {
 for (const key of Reflect.ownKeys(Object.prototype)) if (!Reflect.has(original,key)) Reflect.deleteProperty(Object.prototype,key);
 Object.defineProperties(Object.prototype, original);
});
function disk(root: string): string {
 const entries: string[] = [];
 function visit(dir: string) { for (const item of readdirSync(dir).sort()) {
  const at = join(dir,item); if (statSync(at).isDirectory()) { entries.push(at); visit(at); }
  else entries.push(at + ':' + createHash('sha256').update(readFileSync(at)).digest('hex'));
 }} visit(root); return JSON.stringify(entries);
}
function fixture() {
 const base=mkdtempSync(join(tmpdir(),'gpt-config-boundary-')), root=join(base,'root'), home=join(base,'home');
 mkdirSync(join(root,'.agents'),{recursive:true}); mkdirSync(join(home,'.config','team'),{recursive:true});
 const text=`format: 1
project: fixture
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${names.slice(1).map(name=>`  - name: ${name}
    role: implementer
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
`).join('')}budgets:
  accounts:
    constructor: { kind: subscription, reserve: 20%, sources: [status_line] }
    prototype: { kind: subscription, reserve: 20%, sources: [status_line] }
`;
 writeFileSync(join(root,'.agents','team.yaml'),text);
 const publicKey=createECDH('prime256v1').generateKeys('hex');
 writeFileSync(join(home,'.config','team','owner-seat.json'),JSON.stringify({format:2,team:'fixture',entity:'fixture',seat:'owner',role:'owner',human:true,lifecycle:'running',signers:[{name:'fixture',type:'mac-keystore',public_key:publicKey,label:'fixture',added:stamp}],provenance:{registered_by:'owner',note:'fixture',registered_at:stamp}}));
 let presented=0;
 const store={name:'fixture-store',available:()=>{presented++;return false;},create:()=>({ok:false,why:'fixture'}),publicKey:()=>({ok:false,why:'fixture'}),sign:()=>({ok:false,why:'fixture'}),pinSet:()=>({ok:false,why:'fixture'}),pinGet:()=>({ok:false,why:'fixture'})};
 async function run(argv:string[]) {
  let out='',err=''; const io:Io={cwd:root,env:{TEAM_CONFIG_SOURCE:'file'},stdinIsTTY:true,caller:{kind:'owner'},stdout:v=>{out+=v},stderr:v=>{err+=v}};
  const code=await runConfig(argv,io,{home,env:{TEAM_CONFIG_SOURCE:'file'},ownerSeatStore:store,present:true,now:()=>new Date(stamp)});
  return {code,out,err};
 }
 return {base,run,presented:()=>presented};
}
for (const [vi,verb] of ['get','set','unset'].entries()) for (const [ni,name] of names.entries()) {
 test(`C${vi+1}${ni+1}: invalid map selection stops before effects`,async()=>{
  for (const prefix of [[],['watch'],['fresh','nested']]) {
   const f=fixture(), before=disk(f.base), proto=snap();
   const path=[...prefix,name].join('.');
   const argv=verb==='set'?[verb,path,'41','--request','--json']:verb==='unset'?[verb,path,'--request','--json']:[verb,path,'--json'];
   const result=await f.run(argv);
   const summary={exit:result.code,usage:JSON.parse(result.out).error?.id==='config.usage',presented:f.presented(),diskSame:disk(f.base)===before,sharedSame:same(proto,snap())};
   expect(summary).toEqual({exit:2,usage:true,presented:0,diskSame:true,sharedSame:true});
  }
 });
}
test('C40: direct editor leaves shared descriptors unchanged',()=>{
 for (const name of names) {
  const before=snap();let unchanged=false,refused=false;
  try { const result=withValue({},[name,marker],7); unchanged=same(before,snap());refused=result.ok===false; }
  finally { for (const key of Reflect.ownKeys(Object.prototype)) if(!Reflect.has(before,key))Reflect.deleteProperty(Object.prototype,key);Object.defineProperties(Object.prototype,before); }
  expect({refused,unchanged}).toEqual({refused:true,unchanged:true});
 }
});
test('C41: owned fields and list selectors remain addressable',async()=>{
 const f=fixture();
 for(const name of names.slice(1)) {
  const path=['seats',name,'nickname'].join('.');
  const written=await f.run(['set',path,'Fixture']); expect(written.code, names.reduce((text,name)=>text.split(name).join('[fixture-name]'),written.err)).toBe(0);
  const read=await f.run(['get',path,'--json']);expect(read.code).toBe(0);expect(JSON.parse(read.out).value).toBe('Fixture');
  expect((await f.run(['unset',path])).code).toBe(0);
 }
 for(const name of names.slice(1)) {
  const path=['budgets','accounts',name,'reserve'].join('.');
  expect((await f.run(['set',path,'17%'])).code).toBe(0);
  const read=await f.run(['get',path,'--json']);expect(read.code).toBe(0);expect(JSON.parse(read.out).value).toBe('17%');
 }
 for(const name of names) {
  const listed=withValue({seats:[{name,own:1}]},['seats',name,'own'],2); expect(listed.ok).toBe(true); expect(getAt(listed.root,['seats',name,'own'])).toEqual({found:true,value:2});
  const map=JSON.parse(JSON.stringify({[name]:{own:1}}));
  const changed=withValue(map,[name,'own'],2);expect(changed.ok).toBe(true);
  expect(getAt(changed.root,[name,'own'])).toEqual({found:true,value:2});
 }
});
