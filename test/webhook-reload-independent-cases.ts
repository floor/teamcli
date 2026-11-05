// Real bus and real loopback receivers; all roots, registry keys and secrets are synthetic.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { approvalOf } from '../src/approve/approval.ts';
import { startBus, type BusHandle } from '../src/bus/server.ts';
import * as webhook from '../src/bus/webhook.ts';
import { DEFAULT_RECONCILE_INTERVAL_SECONDS } from '../src/bus/kinds.ts';
import { canonicalTeam, readTeamConfig } from '../src/file/team-config.ts';
import { writeTeamText } from '../src/file/team-text.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readStoredTeamConfig, sha256, teamConfigRecordPath } from '../src/registry/team-config-store.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { assertIndependentHome, releaseIndependentFixture } from './webhook-reload-home-fixture.ts';
const NOW=new Date('2026-11-02T09:00:00.000Z'),SECRET='SYNTHETIC_RELOAD_SECRET_DO_NOT_LOG',owned:string[]=[],buses:BusHandle[]=[],servers:ReturnType<typeof Bun.serve>[]=[],releases:(()=>void)[]=[],restores:{mockRestore():void}[]=[],reports:string[][]=[];
afterEach(async()=>{
 for(const release of releases.splice(0))release();for(const bus of buses.splice(0))await bus.close();for(const server of servers.splice(0))server.stop(true);for(const s of restores.splice(0))s.mockRestore();
 try{for(const rows of reports.splice(0))expect(rows.join('\n').includes(SECRET)).toBe(false);for(const base of owned){const walk=(p:string)=>{for(const e of readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&!e.name.endsWith('.secret')&&(e.name==='events.jsonl'||e.name.endsWith('.log')))expect(readFileSync(f,'utf8').includes(SECRET)).toBe(false);}};walk(base);}}finally{for(const base of owned.splice(0))releaseIndependentFixture(base);}
});
test('bus and receivers run under an isolated HOME from startup',assertIndependentHome);
type Hit={path:string;method:string;auth:string|null;custom:string|null;body:string};
function receiver(hold=false){const hits:Hit[]=[];let release!:()=>void;const gate=hold?new Promise<void>(r=>{release=r;releases.push(r);}):Promise.resolve();const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(r){hits.push({path:new URL(r.url).pathname,method:r.method,auth:r.headers.get('authorization'),custom:r.headers.get('x-fixture-key'),body:await r.text()});await gate;return new Response(null,{status:204});}});servers.push(server);return{hits,url:`http://127.0.0.1:${server.port}/routine`,release};}
function base(){const path=realpathSync(mkdtempSync(join(tmpdir(),'hkr-')));owned.push(path);return path;}
type Hook={urlFile:string;secretFile:string;header?:string;body?:'event'|'inbox'};
function hook(dir:string,name:string,url:string,custom=false):Hook{const h:Hook={urlFile:join(dir,name+'.url'),secretFile:join(dir,name+'.secret'),...(custom?{header:'X-Fixture-Key',body:'inbox' as const}:{})};writeFileSync(h.urlFile,url+'\n',{mode:0o600});writeFileSync(h.secretFile,SECRET+'\n',{mode:0o600});return h;}
function text(root:string,home:string,h:Hook|null){return`format: 1\nproject: reload-fixture\nsession: reload-scene\noperator: captain\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${join(home,'.config/team/lobby')}\n  - ${join(process.env.HOME!,'.config/team/lobby')}\nseats:\n  - name: captain\n    role: orchestrator\n    leads: true\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: fixture\n  - name: routine\n    role: worker\n    cli: codex\n    vendor: test\n    model: Test\n    version: "1"\n    launch: fixture\n${h?'    webhook: '+JSON.stringify({url_file:h.urlFile,secret_file:h.secretFile,...(h.header?{header:h.header}:{}),...(h.body?{body:h.body}:{})})+'\n':''}`;}
type World={base:string;home:string;root:string;file:string;record:string};
function world(initial:((dir:string)=>Hook)|null=null,shared?:{base:string;home:string;name:string}):World{
 const dir=shared?.base??base(),home=shared?.home??join(dir,'h'),root=join(dir,shared?.name??'r'),file=join(root,'.agents/team.yaml');for(const p of [join(root,'.agents'),join(home,'.config/team/lobby'),join(process.env.HOME!,'.config/team/lobby')])mkdirSync(p,{recursive:true,mode:0o700});
 const w={base:dir,home,root,file,record:teamConfigRecordPath(home,teamIdOf(root))},h=initial?.(dir)??null;set(w,h,true);return w;
}
function set(w:World,h:Hook|null,create=false){const value=text(w.root,w.home,h),wrote=writeTeamText(w.file,value,{home:w.home,source:'registry',create,command:'synthetic independent registry write',now:()=>NOW});expect(wrote).toEqual({ok:true,target:'registry'});const parsed=validateTeamFile(value,{home:w.home,root:w.root});if(!parsed.ok)throw new Error(JSON.stringify(parsed.errors));writeApproval(storePath(parsed.team.project,w.root,w.home),{approval:approvalOf(parsed.team,w.root,NOW),file:value},parsed.team.seats,w.home,NOW);}
async function start(w:World,interval=0){const said:string[]=[];reports.push(said);const parsed=readTeamConfig(w.root,{home:w.home,source:'registry'});if(!parsed.ok)throw new Error(JSON.stringify(parsed.errors));const r=await startBus({root:w.root,home:w.home,team:parsed.team,reconcileIntervalMs:interval,stderr:s=>said.push(s),now:()=>NOW});expect(r.kind).toBe('serving');if(r.kind!=='serving')throw new Error('real bus '+r.kind);buses.push(r.handle);await r.handle.reconcileNow();return{bus:r.handle,said};}
function drop(w:World){const id=randomUUID(),dir=join(w.root,'.agents/send-drops/reload-scene/routine');mkdirSync(dir,{recursive:true,mode:0o700});const signed=signRecord({kind:'message',id,to:'routine',to_id:null,root:w.root,session:'reload-scene',at:NOW.toISOString(),body:'from captain\n\nsynthetic reload message\n',from:'captain',from_id:null,rule:'synthetic independent fixture',thread:id},w.home);writeFileSync(join(dir,id),JSON.stringify(signed),{mode:0o600});return{id,signed,path:join(dir,id)};}
async function until(what:()=>boolean,label:string,ms=1500){const end=Date.now()+ms;while(!what()){if(Date.now()>end)throw new Error('timed out: '+label);await Bun.sleep(10);}}
function ids(hits:Hit[]){return hits.map(h=>{const p=JSON.parse(h.body);return p.id??p.event?.payload?.record_id;});}
test('adding a row applies on the next reconcile without restarting the bus',async()=>{
 const w=world(),{bus}=await start(w),r=receiver();set(w,hook(w.base,'added',r.url));const m=drop(w);await bus.reconcileNow();await until(()=>r.hits.length===1,'new row receives arrival');expect(ids(r.hits)).toEqual([m.id]);expect(r.hits[0]!.auth===`Bearer ${SECRET}`).toBe(true);expect(r.hits[0]!.method).toBe('POST');expect(existsSync(m.path)).toBe(true);
});
test('a replacement captures a complete new header/body row while the old request finishes on its original row',async()=>{
 const old=receiver(true),w=world(d=>hook(d,'old',old.url)),{bus}=await start(w),one=drop(w);await bus.reconcileNow();await until(()=>old.hits.length===1,'held first arrival');const next=receiver();set(w,hook(w.base,'next',next.url,true));const two=drop(w);await bus.reconcileNow();old.release();await until(()=>next.hits.length===1,'replacement row receives arrival');expect(ids(old.hits)).toEqual([one.id]);expect(ids(next.hits)).toEqual([two.id]);expect(old.hits[0]!.auth===`Bearer ${SECRET}`).toBe(true);expect(old.hits[0]!.custom).toBeNull();expect(next.hits[0]!.auth).toBeNull();expect(next.hits[0]!.custom===SECRET).toBe(true);expect(JSON.parse(next.hits[0]!.body)).toEqual({id:two.id,from:'captain',kind:'message',created_at:NOW.toISOString(),body:two.signed.payload.body,signature:two.signed.signature});
});
test('removing a webhook row stops later POSTs but keeps durable arrivals',async()=>{
 const r=receiver(),w=world(d=>hook(d,'active',r.url)),{bus}=await start(w),one=drop(w);await bus.reconcileNow();await until(()=>r.hits.length===1,'initial arrival');set(w,null);const two=drop(w),events=await bus.reconcileNow();expect(events.some(e=>e.payload.kind==='message.arrived'&&e.payload.record_id===two.id)).toBe(true);await Bun.sleep(150);expect(ids(r.hits)).toEqual([one.id]);
});
test('the timer applies a row in one configured reconcile interval and the default stays 120 seconds',async()=>{
 expect(DEFAULT_RECONCILE_INTERVAL_SECONDS).toBe(120);const w=world(),{bus}=await start(w,40),r=receiver();set(w,hook(w.base,'timer',r.url));const m=drop(w);await until(()=>r.hits.length===1,'timer-driven reload');expect(ids(r.hits)).toEqual([m.id]);await bus.close();buses.splice(buses.indexOf(bus),1);
});
test('a stable canonical digest does not rebuild rows, even when display whitespace changes',async()=>{
 const original=webhook.makeWebhookDelivery;let reloads=0;restores.push(spyOn(webhook,'makeWebhookDelivery').mockImplementation(input=>{const d=original(input) as ReturnType<typeof original>&{reload?:(team:Parameters<typeof original>[0]['team'])=>void};const reload=d.reload;if(reload)d.reload=team=>{reloads++;reload(team);};return d;}));
 const r=receiver(),w=world(d=>hook(d,'stable',r.url)),{bus}=await start(w),before=readStoredTeamConfig(w.home,teamIdOf(w.root))!;const formatted=before.text+'\n# synthetic display-only comment\n';expect(writeTeamText(w.file,formatted,{home:w.home,source:'registry'}).ok).toBe(true);expect(readStoredTeamConfig(w.home,teamIdOf(w.root))!.record_sha256).toBe(before.record_sha256);await bus.reconcileNow();await bus.reconcileNow();expect(reloads).toBe(0);const m=drop(w);await bus.reconcileNow();await until(()=>r.hits.length===1,'unchanged route');expect(ids(r.hits)).toEqual([m.id]);
});
for(const fault of ['bad-json','invalid-team','unreadable','missing'])test(`${fault} registry record is reported once and existing rows keep working`,async()=>{
 const r=receiver(),w=world(d=>hook(d,'good',r.url)),{bus,said}=await start(w),good=readFileSync(w.record),record=JSON.parse(good.toString());
 if(fault==='bad-json')writeFileSync(w.record,'{"format":');
 if(fault==='invalid-team'){record.text='format: 1\nproject: broken\nseats: []\n';record.text_sha256=sha256(record.text);record.record_sha256='f'.repeat(64);writeFileSync(w.record,JSON.stringify(record));}
 if(fault==='unreadable'){renameSync(w.record,w.record+'.retained');writeFileSync(w.record,good,{mode:0o000});}
 if(fault==='missing')renameSync(w.record,w.record+'.retained');
 await bus.reconcileNow();await bus.reconcileNow();const m=drop(w);await bus.reconcileNow();await until(()=>r.hits.length===1,'retained route');expect(ids(r.hits)).toEqual([m.id]);const problems=said.filter(s=>s.includes('webhook rows were not reloaded'));expect(problems).toHaveLength(1);expect(said.join('\n').includes(SECRET)).toBe(false);
});
test('one root reloads its own rows while a second running root is unaffected',async()=>{
 const d=base(),home=join(d,'h'),a=receiver(),b=receiver(),next=receiver(),one=world(p=>hook(p,'one',a.url),{base:d,home,name:'one'}),two=world(p=>hook(p,'two',b.url),{base:d,home,name:'two'}),first=await start(one),second=await start(two);set(one,hook(d,'changed',next.url));const m=drop(one),n=drop(two);await Promise.all([first.bus.reconcileNow(),second.bus.reconcileNow()]);await until(()=>next.hits.length===1&&b.hits.length===1,'isolated root deliveries');expect(ids(next.hits)).toEqual([m.id]);expect(ids(b.hits)).toEqual([n.id]);expect(a.hits).toHaveLength(0);
});
test('a hash-consistent forged registry text cannot redirect POSTs beyond the signed team record',async()=>{
 const trusted=receiver(),forged=receiver(),w=world(d=>hook(d,'trusted',trusted.url)),{bus}=await start(w),before=approvalStanding(w.root,w.home);expect(before.kind).toBe('verified');const stored=readStoredTeamConfig(w.home,teamIdOf(w.root))!,replacement=text(w.root,w.home,hook(w.base,'forged',forged.url)),parsed=validateTeamFile(replacement,{home:w.home,root:w.root});if(!parsed.ok)throw new Error('forged fixture text must be syntactically valid');
 writeFileSync(w.record,JSON.stringify({...stored,text:replacement,text_sha256:sha256(replacement),record_sha256:sha256(canonicalTeam(parsed.team))}));const after=approvalStanding(w.root,w.home);expect(after.kind).toBe('verified');if(before.kind==='verified'&&after.kind==='verified')expect(after.record).toEqual(before.record);
 const m=drop(w);await bus.reconcileNow();await until(()=>trusted.hits.length+forged.hits.length===1,'a delivery decision');expect(forged.hits).toHaveLength(0);expect(ids(trusted.hits)).toEqual([m.id]);
});
