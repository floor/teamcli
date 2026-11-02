// A trust answer sees every slow reading before its final identity and screen capture.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import * as landing from '../src/file/landing.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { writeGrant } from '../src/permissions/grants.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './answer-trust-home-fixture.ts';

const NOW = new Date('2026-11-01T20:00:00.000Z');
const trustCapture = readFileSync(new URL('./fixtures/cursor/2026.10.14/trust.txt',import.meta.url),'utf8');
const idleCapture = readFileSync(new URL('./fixtures/cursor/2026.10.14/idle.txt',import.meta.url),'utf8');
const permissionCapture = readFileSync(new URL('./fixtures/cursor/2026.10.14/permission.txt',import.meta.url),'utf8');
const made: string[] = []; let activeSpy: { mockRestore(): void } | undefined;
afterEach(() => { activeSpy?.mockRestore(); activeSpy = undefined; for (const dir of made.splice(0)) releaseIndependentFixture(dir); });
function folder(path: string): void { const mask = process.umask(0); try { mkdirSync(path,{recursive:true,mode:0o700}); } finally { process.umask(mask); } }
test('the child owns its HOME before any product import or process read',assertIndependentHome);
type Stage = 'version' | 'cwd' | 'list' | 'canonical';
type Switch = 'permission' | 'process';
type Race = { stage: Stage; pass: number; change: Switch };
function world(race?: Race, spelling?: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(),'trust-independent-'))); made.push(base);
  const home=join(base,'home'),root=join(base,'checkout'),dir=join(root,'.agents'),file=join(dir,'team.yaml'),lobby=join(home,'.config/team/lobby');
  folder(dir);folder(lobby);folder(join(process.env.HOME!,'.config/team/lobby'));
  execFileSync('git',['init','-q','-b','main'],{cwd:root,env:gitEnv()});
  const yaml=`format: 1\nproject: trust-fixture\nsession: trust-scene\noperator: captain\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobby}\n  - ${join(process.env.HOME!,'.config/team/lobby')}\nseats:\n  - name: captain\n    role: orchestrator\n    leads: true\n    cli: cursor\n    vendor: xai\n    model: Grok\n    version: "4.7"\n    launch: cursor-agent\n`;
  writeFileSync(file,yaml);
  const grant=writeGrant(home,{name:'fixture-trust',kind:'team',grantee:teamIdOf(root),capabilities:['dialogs.trust'],roots:[root],scope:[root]},{now:NOW});expect(grant.ok).toBe(true);
  const loaded=readTeamConfig(root,{file,home});if(!loaded.ok)throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project,root,home),{approval:approvalOf(loaded.team,root,NOW),file:yaml},loaded.team.seats,home,NOW);
  const initial={state:'waiting-owner' as const,classification:'trust' as const};
  updateState(dir,state=>{const session=state.sessions['trust-scene']??=emptySession();session.seats.captain={stage:'launched',pane:'fixture-pane',workspace:'fixture-workspace',launched:{shell:8401,cli:[8402]},waiting:initial};});
  const shown=spelling==='slash'?lobby+'/':spelling==='dot'?lobby+'/./':spelling==='double'?lobby.replace('/.config/','//.config/'):lobby;
  const events:{pass:number;name:string}[]=[],keys:string[]=[],inputs:string[]=[];
  let clock=NOW.getTime(),pass=0,canonical=0,replaced=false,screen=trustCapture.replace('<workspace>',shown),changed=false;
  const record=(name:string)=>{if(keys.length===0)events.push({pass,name});};
  function change(stage:Stage):void {if(race&&!changed&&pass===race.pass&&stage===race.stage){changed=true;if(race.change==='process')replaced=true;else screen=permissionCapture;}}
  const host:AnswerHost={home,now:()=>new Date(clock),sleep:async ms=>{clock+=ms;},standing:r=>approvalStanding(r,home),
    version:()=>{if(keys.length===0){pass++;canonical=0;}record('version');change('version');return '2026.10.14-0f9edde';},
    foregroundCwd:()=>{record('cwd');change('cwd');return lobby;},
    list:path=>{record('list');change('list');return landing.listFolder(path);},
    agents:()=>[{name:'captain',pane:'fixture-pane',workspace:'fixture-workspace'}],
    processInfo:()=>{record('process');return {shell:8401,foreground:[8401,replaced?8403:8402]};},
    pane:()=>{record('pane');return screen;},
    sendKey:(session,pane,key)=>{record('key');expect(session).toBe('trust-scene');expect(pane).toBe('fixture-pane');keys.push(key);if(screen!==permissionCapture)screen=idleCapture;return true;},
    rename:()=>{inputs.push('rename');return true;},foreground:()=>['cursor-agent'],status:()=> 'idle',
    type:()=>{inputs.push('type');throw new Error('typing is forbidden');},enter:()=>{inputs.push('enter');throw new Error('Enter is forbidden');},
  };
  const original=landing.canonicalLanding;
  activeSpy=spyOn(landing,'canonicalLanding').mockImplementation(path=>{
    if(pass>0&&keys.length===0){record('canonical');canonical++;if(canonical===2)change('canonical');}
    return original(path);
  });
  return {base,home,root,dir,lobby,host,events,keys,inputs,initial,changed:()=>changed};
}
type World=ReturnType<typeof world>;
async function answer(w:World){const io=testIo(w.root,{kind:'owner'}),prior=process.env.TEAM_CONFIG_SOURCE;process.env.TEAM_CONFIG_SOURCE='file';try {const code=await runAnswer(['captain','trust','--json'],io,w.host);return{code,io,document:io.out?JSON.parse(io.out):null};}finally {if(prior===undefined)delete process.env.TEAM_CONFIG_SOURCE;else process.env.TEAM_CONFIG_SOURCE=prior;}}
function waiting(w:World){return readState(w.dir).sessions['trust-scene']?.seats.captain?.waiting;}

test('a stable trust answer resolves every folder before each final process read and capture',async()=>{
  const w=world(),result=await answer(w);expect(result.code,result.io.out+result.io.err).toBe(0);expect(w.keys).toEqual(['a']);expect(w.inputs).toEqual([]);expect(waiting(w)).toBeUndefined();
  expect(w.events.filter(e=>e.name==='canonical').length).toBeGreaterThan(0);
  for(const n of [1,2,3]){const events=w.events.filter(e=>e.pass===n&&e.name!=='key').map(e=>e.name);expect(events.slice(-2)).toEqual(['process','pane']);expect(events.lastIndexOf('canonical')).toBeLessThan(events.lastIndexOf('process'));}
  const key=w.events.findIndex(e=>e.name==='key');expect(w.events[key-1]?.name).toBe('pane');
});
for(const stage of ['version','cwd','list','canonical'] as const)for(const pass of [1,2,3])for(const change of ['permission','process'] as const)test(`${change} changes during ${stage} lookup ${pass}: no key and waiting-owner preserved`,async()=>{
  const w=world({stage,pass,change}),result=await answer(w);expect(w.changed()).toBe(true);expect(result.code,result.io.out+result.io.err).toBe(1);expect(w.keys).toEqual([]);expect(w.inputs).toEqual([]);expect(waiting(w)).toEqual(w.initial);
});
for(const spelling of ['slash','dot','double'])test(`a ${spelling} spelling of the same lobby still refuses without a key`,async()=>{
  const w=world(undefined,spelling),result=await answer(w);expect(result.code,result.io.out+result.io.err).toBe(1);expect(w.keys).toEqual([]);expect(w.inputs).toEqual([]);expect(waiting(w)).toEqual(w.initial);
});
