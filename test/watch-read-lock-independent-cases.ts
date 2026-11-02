// Same actual mailbox path on parent and builder: an independent command must not be locked out.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { loadReadings, saveReadings } from '../src/budgets/readings.ts';
import { standingSource } from '../src/commands/status.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import * as messages from '../src/commands/messages.ts';
import * as agents from '../src/registry/agents.ts';
import * as continuity from '../src/registry/resume.ts';
import * as settings from '../src/settings/declared.ts';
import * as entities from '../src/entities.ts';
import * as projects from '../src/registry/projects.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './watch-read-lock-home-fixture.ts';
const NOW=new Date('2026-11-02T09:00:00.000Z'),owned:string[]=[],restores:{mockRestore():void}[]=[];
afterEach(()=>{for(const s of restores.splice(0))s.mockRestore();for(const p of owned.splice(0))releaseIndependentFixture(p);});
test('lock probes run under a child HOME from startup',assertIndependentHome);
function world(){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'watch-lock-independent-')));owned.push(base);const root=join(base,'checkout'),home=join(base,'home'),dir=join(root,'.agents'),barrier=join(base,'barriers');for(const p of [dir,home,barrier])mkdirSync(p,{recursive:true,mode:0o700});for(const h of [home,process.env.HOME!,...['command','first','second'].map(n=>join(base,n+'-startup-home'))])mkdirSync(join(h,'.config/team/lobby'),{recursive:true,mode:0o700});
 execFileSync('git',['init','-q','-b','main'],{cwd:root,env:gitEnv()});writeFileSync(join(root,'README'),'synthetic watch fixture\n');execFileSync('git',['add','README'],{cwd:root,env:gitEnv()});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-q','-m','test: create synthetic fixture\n\nAgent: GPT Sol 6.1 · tester'],{cwd:root,env:gitEnv()});
 const yaml=`format: 1\nproject: watch-lock-fixture\nsession: lock-scene\noperator: captain\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${join(home,'.config/team/lobby')}\n  - ${join(process.env.HOME!,'.config/team/lobby')}\n  - ${join(base,'command-startup-home/.config/team/lobby')}\n  - ${join(base,'first-startup-home/.config/team/lobby')}\n  - ${join(base,'second-startup-home/.config/team/lobby')}\nbudgets:\n  marks: [50, 75, 90]\n  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [check], check: fixture-quota }\nseats:\n  - name: captain\n    role: orchestrator\n    leads: true\n    cli: codex\n    vendor: openai\n    model: GPT Sol\n    version: "6.1"\n    launch: codex -m gpt-6.1-sol\n`;
 writeFileSync(join(dir,'team.yaml'),yaml);const loaded=readTeamConfig(root,{file:join(dir,'team.yaml'),home});if(!loaded.ok)throw new Error(JSON.stringify(loaded.errors));writeApproval(storePath(loaded.team.project,root,home),{approval:approvalOf(loaded.team,root,NOW),file:yaml},loaded.team.seats,home,NOW);
 const w={base,root,home,dir,barrier},file=join(base,'world.json');writeFileSync(file,JSON.stringify(w));return{...w,file};
}
type World=ReturnType<typeof world>;
function sources(w:World):WatchSources{const reject=(..._args:unknown[]):never=>{throw new Error('host operation forbidden');};return{home:w.home,pid:process.pid,alive:()=>false,live:()=>({running:true,agents:[],workspaces:[],screens:{}}),machine:()=>({loadPerCore:0.1,memoryFree:80,diskFree:1024**4,swapTotal:1024**3,swapFree:1024**3,swapUsed:0}),standing:standingSource(w.home),readChecks:()=>[],screen:reject,status:reject,foreground:reject,processes:reject,typeText:reject,pressEnter:reject,sendKey:reject,sleep:async()=>{},notify:()=>{},now:()=>NOW,wait:async()=>false,hosted:{signal:new AbortController().signal,wait:async()=>false,cycled:()=>{},standby:reject}};}
async function run(w:World){const io=testIo(w.root,{kind:'owner-no-tty'}),code=await runWatch([],io,sources(w));expect(code,io.out+io.err).toBe(0);}
async function wait(w:World,name:string){const end=Date.now()+10000;while(!existsSync(join(w.barrier,name))){if(Date.now()>end)throw new Error('fixture barrier timeout: '+name);await Bun.sleep(5);}}
function syncWait(w:World,name:string){const end=Date.now()+10000;while(!existsSync(join(w.barrier,name))){if(Date.now()>end)throw new Error('fixture barrier timeout: '+name);Bun.sleepSync(5);}}
function child(w:World,mode:string){const home=join(w.base,mode+'-startup-home');mkdirSync(home,{recursive:true,mode:0o700});return Bun.spawn([process.execPath,join(import.meta.dir,'watch-read-lock-actor.ts'),mode,w.file],{cwd:w.root,env:{...process.env,HOME:home,TEAM_CONFIG_SOURCE:'file'},stdout:'pipe',stderr:'pipe'});}
async function done(p:ReturnType<typeof child>){const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect(out+err).toBe('');return exit;}
const originals={agent:agents.findAgent,continuity:continuity.continuityIdsOf,machine:settings.machineLiveness,entity:entities.entityLiveness,project:projects.ofTeam};
const readers:Record<string,(probe:()=>void)=>{mockRestore():void}>={
 signing:p=>spyOn(agents,'findAgent').mockImplementation((...a)=>{p();return originals.agent(...a);}),
 continuity:p=>spyOn(continuity,'continuityIdsOf').mockImplementation((...a)=>{p();return originals.continuity(...a);}),
 machine:p=>spyOn(settings,'machineLiveness').mockImplementation((...a)=>{p();return originals.machine(...a);}),
 entity:p=>spyOn(entities,'entityLiveness').mockImplementation((...a)=>{p();return originals.entity(...a);}),
 project:p=>spyOn(projects,'ofTeam').mockImplementation((...a)=>{p();return originals.project(...a);}),
};
for(const family of Object.keys(readers))test(`${family} records are read before the state fold lock`,async()=>{
 const w=world(),locks:boolean[]=[],writes:boolean[]=[];restores.push(readers[family]!(()=>{locks.push(existsSync(join(w.dir,'team.lock')));try{updateState(w.dir,()=>{}, {waitMs:0});writes.push(true);}catch{writes.push(false);}}));await run(w);expect(locks.length).toBeGreaterThan(0);expect(locks.every(held=>!held)).toBe(true);expect(writes.every(Boolean)).toBe(true);expect(existsSync(join(w.dir,'team.lock'))).toBe(false);
});
test('a separate command writes state while the real mailbox path is scanning',async()=>{
 const w=world(),actor=child(w,'command');await wait(w,'command-ready');writeFileSync(join(w.barrier,'pids'),JSON.stringify([process.pid,actor.pid]));writeFileSync(join(w.barrier,'go'),'true');let reads=0;
 restores.push(spyOn(messages,'listUnackedMessages').mockImplementation(()=>{reads++;writeFileSync(join(w.barrier,'scan-entered'),'true');syncWait(w,'command-done');return[];}));
 await run(w);const exit=await done(actor),r=JSON.parse(readFileSync(join(w.barrier,'command-result'),'utf8'));expect(reads).toBeGreaterThan(0);expect(r.forbidden).toEqual([]);expect(r.took).toBe(true);expect(exit).toBe(0);expect(readState(w.dir).pause?.reason).toBe('concurrent marker');expect(existsSync(join(w.dir,'team.lock'))).toBe(false);
});
test('two concurrent hosted watches fold in order and keep both readings and existing state',async()=>{
 const w=world();updateState(w.dir,s=>{s.pause={by:'fixture-command',at:NOW.toISOString(),reason:'retained marker',stops:[]};});saveReadings(w.dir,[{account:'openai',window:'session',left:95,used:5,changedAt:NOW.getTime(),seat:null,resetsAt:null,confirmed:true,source:'check'}],NOW.getTime());
 const first=child(w,'first'),second=child(w,'second');await Promise.all([wait(w,'first-ready'),wait(w,'second-ready')]);writeFileSync(join(w.barrier,'pids'),JSON.stringify([process.pid,first.pid,second.pid]));writeFileSync(join(w.barrier,'go'),'true');const exits=await Promise.all([done(first),done(second)]),a=JSON.parse(readFileSync(join(w.barrier,'first-result'),'utf8')),c=JSON.parse(readFileSync(join(w.barrier,'second-result'),'utf8'));
 expect([a.error,c.error]).toEqual([undefined,undefined]);expect(exits).toEqual([0,0]);expect([a.cycles,c.cycles]).toEqual([1,1]);expect(a.overlapped).toBe(false);expect(a.lockHeld).toBe(true);expect(a.forbidden).toEqual([]);expect(c.forbidden).toEqual([]);expect(c.observed[0]).toContainEqual(['openai','weekly',61]);expect(loadReadings(w.dir).map(x=>[x.account,x.window,x.left]).sort()).toEqual([['openai','daily',72],['openai','session',95],['openai','weekly',61]].sort());expect(readState(w.dir).pause?.reason).toBe('retained marker');expect(existsSync(join(w.dir,'team.lock'))).toBe(false);
});
