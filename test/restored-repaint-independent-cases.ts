// A restored conversation keeps its pane; its sidebar comes from the declared record first.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { newMemory, pass, type Memory } from '../src/watch/pass.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './restored-repaint-home-fixture.ts';

const NOW = new Date('2026-11-01T20:00:00.000Z');
const SESSION='paint-scene', SEAT='captain', PANE='fixture-pane', ORIGINAL_SPACE='recorded-space', LIVE_SPACE='current-space', CONVERSATION='fixture-conversation';
const ORIGINAL={shell:2101,cli:[2102]}, RESTORED={shell:4101,foreground:[4102]};
const capture=readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt',import.meta.url),'utf8');
const CURRENT=capture.replaceAll('gpt-5.6-terra','gpt-6.1-sol').replaceAll('GPT-5.6-Terra','GPT-6.1-Sol');
const STALE=capture.replaceAll('gpt-5.6-terra','gpt-6-astra').replaceAll('GPT-5.6-Terra','GPT-6-Astra').replaceAll('medium','xhigh');
const owned:string[]=[];
afterEach(()=>{for(const path of owned.splice(0))releaseIndependentFixture(path);});
function folder(path:string){const mask=process.umask(0);try{mkdirSync(path,{recursive:true,mode:0o700});}finally{process.umask(mask);}}
test('all reads and fake host writes run under the child HOME',assertIndependentHome);
function world(effort?:string){
  const base=realpathSync(mkdtempSync(join(tmpdir(),'repaint-independent-')));owned.push(base);const root=join(base,'checkout'),home=join(base,'home'),dir=join(root,'.agents'),file=join(dir,'team.yaml'),lobby=join(home,'.config/team/lobby');
  folder(dir);folder(lobby);folder(join(process.env.HOME!,'.config/team/lobby'));
  execFileSync('git',['init','-q','-b','main'],{cwd:root,env:gitEnv()});writeFileSync(join(root,'README'),'synthetic repaint fixture\n');execFileSync('git',['add','README'],{cwd:root,env:gitEnv()});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-q','-m','test: create synthetic fixture\n\nAgent: GPT Sol 6.1 · tester'],{cwd:root,env:gitEnv()});
  const yaml=`format: 1\nproject: repaint-fixture\nsession: ${SESSION}\noperator: ${SEAT}\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobby}\n  - ${join(process.env.HOME!,'.config/team/lobby')}\nseats:\n  - name: ${SEAT}\n    role: orchestrator\n    leads: true\n    label: Planner\n    cli: codex\n    vendor: openai\n    model: GPT Sol\n    version: "6.1"\n    launch: codex -m gpt-6.1-sol\n${effort?'    effort: '+effort+'\n':''}`;
  writeFileSync(file,yaml);const loaded=readTeamConfig(root,{file,home});if(!loaded.ok)throw new Error(JSON.stringify(loaded.errors));
  const store=storePath(loaded.team.project,root,home);writeApproval(store,{approval:approvalOf(loaded.team,root,NOW),file:yaml},loaded.team.seats,home,NOW);
  updateState(dir,state=>{const session=state.sessions[SESSION]??=emptySession();session.seats[SEAT]={stage:'ready',pane:PANE,workspace:ORIGINAL_SPACE,launched:ORIGINAL};session.watch={pane:'inert-watch-pane',workspace:'inert-watch-space',heartbeat:NOW.toISOString()};});
  registerAgent(home,{name:SEAT,signing:{model:'GPT Sol',version:'6.1',role:'orchestrator'},lab:'openai',cli:'codex',launcher:null,launch:'codex -m gpt-6.1-sol',reach:{team:teamIdOf(root),seat:SEAT,session:SESSION,pane:PANE,address:null,agent_session:CONVERSATION},seat_handle:'seat_123456789abc',mcp:[],skills:[],lifecycle:'running',by:'team up'});
  return {base,root,home,dir,file,yaml,team:loaded.team,record:join(store,'approval.json')};
}
type World=ReturnType<typeof world>;
function sources(w:World,space:string,restored=true,conversation=CONVERSATION){
  const writes:unknown[][]=[],forbidden:string[]=[];let clock=NOW.getTime();
  const reject=(what:string)=>(..._args:unknown[]):never=>{forbidden.push(what);throw new Error('unexpected fake host action: '+what);};
  const agents=()=>[{name:SEAT,agent:'codex',pane:PANE,workspace:space,status:'idle',cwd:w.root,session:conversation}];
  const now=()=>new Date(clock),sleep=async(ms:number)=>{clock+=ms;};
  const launch:Launch={sessionState:()=> 'running',startServer:reject('server'),sessionUp:()=>true,createWorkspace:reject('create'),paneRun:reject('launch'),renameAgent:reject('rename-agent'),closeWorkspace:reject('close'),typeText:reject('type'),pressEnter:reject('enter'),sendKey:reject('key'),kill:reject('signal'),agentPanes:()=>[PANE],agents,paneText:()=>CURRENT,foreground:()=>['codex'],processInfo:()=>restored?RESTORED:{shell:ORIGINAL.shell,foreground:ORIGINAL.cli},agentStatus:()=> 'idle',now,sleep,
    renameWorkspace:(session,workspace,title)=>{writes.push(['title',session,workspace,title]);return true;},reportDisplayAgent:(session,pane,text)=>{writes.push(['display',session,pane,text]);return true;}};
  const machine=()=>({loadPerCore:0.1,memoryFree:80,diskFree:1024**4,swapTotal:1024**3,swapFree:1024**3,swapUsed:0,pressure:'normal' as const});
  const source:UpSources={home:w.home,sessionRunning:()=>true,sessionState:()=> 'running',agents,workspaces:()=>[{id:space,label:'old host title'}],alive:()=>false,now,sleep,machine,launch,doctor:{home:w.home,version:()=> 'codex-cli 0.161.0',onPath:()=>true,loggedIn:()=>true,herdrVersion:()=> '0.7.1',sessionRunning:()=>true,now}};
  return{source,writes,forbidden};
}
async function run(w:World,source:UpSources,dry=false){const io=testIo(w.root,{kind:'owner'}),prior=process.env.TEAM_CONFIG_SOURCE;process.env.TEAM_CONFIG_SOURCE='file';try{return{code:await runUp(dry?['--dry-run']:[],io,source),io};}finally{if(prior===undefined)delete process.env.TEAM_CONFIG_SOURCE;else process.env.TEAM_CONFIG_SOURCE=prior;}}
for(const space of [ORIGINAL_SPACE,LIVE_SPACE])for(const dry of [true,false])test(`restored up ${dry?'plan':'run'} repaints both lines in ${space}`,async()=>{
  const w=world(),f=sources(w,space),record=readFileSync(w.record),result=await run(w,f.source,dry);expect(result.code,result.io.out+result.io.err).toBe(0);
  if(dry){expect(result.io.out).toContain(`workspace rename ${space} Planner`);expect(result.io.out).toContain(`pane report-metadata ${PANE}`);expect(f.writes).toEqual([]);}
  else{expect(f.writes).toEqual([['title',SESSION,space,'Planner'],['display',SESSION,PANE,'GPT Sol 6.1 default']]);const after=readState(w.dir).sessions[SESSION]!.seats[SEAT]!;expect(after.launched).toEqual({shell:RESTORED.shell,cli:RESTORED.foreground});expect(after.workspace).toBe(space);expect(after.agent_session).toBe(CONVERSATION);}
  expect(result.io.out+result.io.err).toContain('restored');expect(f.forbidden).toEqual([]);expect(readFileSync(w.record)).toEqual(record);expect(readFileSync(w.file,'utf8')).toBe(w.yaml);
});
test('an ordinary ready seat keeps its existing repaint with no launch or typing',async()=>{
  const w=world(),f=sources(w,ORIGINAL_SPACE,false),result=await run(w,f.source);expect(result.code,result.io.out+result.io.err).toBe(0);expect(f.writes).toEqual([['title',SESSION,ORIGINAL_SPACE,'Planner'],['display',SESSION,PANE,'GPT Sol 6.1 default']]);expect(f.forbidden).toEqual([]);
});
test('a different conversation is left without repainting or input',async()=>{
  const why=`its pane holds another conversation (different-conversation; the record's launch ran ${CONVERSATION})`;
  const w=world(),f=sources(w,ORIGINAL_SPACE,true,'different-conversation'),result=await run(w,f.source);expect(result.code).toBe(1);expect(result.io.out).toContain(`${SEAT}: left out: ${why}\n`);expect(result.io.err).toContain(why);expect(f.writes).toEqual([]);expect(f.forbidden).toEqual([]);
});
function watchScene(w:World,registry:boolean,restored=true){
  const state=emptySession();state.seats[SEAT]={stage:'ready',pane:PANE,workspace:LIVE_SPACE,launched:ORIGINAL,...(registry?{}:{agent_session:CONVERSATION})};
  const memory=newMemory(),live={running:true,agents:[{name:SEAT,agent:'codex',pane:PANE,workspace:LIVE_SPACE,status:'idle',cwd:w.root,session:CONVERSATION}],workspaces:[{id:LIVE_SPACE,label:'stale host title'}],screens:{[PANE]:STALE}};
  const cycle=()=>pass({team:w.team,state,live,machine:{loadPerCore:0.1,memoryFree:80,diskFree:1024**4,swapTotal:1024**3,swapFree:1024**3,swapUsed:0},now:NOW.getTime(),watch:w.team.watch,memory,processes:{[PANE]:restored?RESTORED:{shell:ORIGINAL.shell,foreground:ORIGINAL.cli}},...(registry?{continuityIds:new Map([[SEAT,CONVERSATION]])}:{})});
  return{cycle,memory};
}
function remember(memory:Memory,label:{title?:string;displayAgent?:string}){const slot=memory.seatLabels[SEAT]??={};if(label.title!==undefined)slot.title=label.title;if(label.displayAgent!==undefined)slot.line=label.displayAgent;}
for(const registry of [false,true])for(const effort of [undefined,'high'])test(`watch restores ${registry?'registry':'state'} continuity with ${effort??'default'} effort before following the pane`,()=>{
  const w=world(effort),s=watchScene(w,registry),first=s.cycle(),label=first.labels.find(row=>row.name===SEAT);expect(label).toEqual({name:SEAT,pane:PANE,workspace:LIVE_SPACE,title:'Planner',displayAgent:`GPT Sol 6.1 ${effort??'default'}`});expect(first.work).toEqual([]);expect(first.ring).toBeNull();
  remember(s.memory,label!);const second=s.cycle(),updated=second.labels.find(row=>row.name===SEAT);expect(updated?.displayAgent).toBe('GPT Astra 6 xhigh');remember(s.memory,updated!);expect(s.cycle().labels).toEqual([]);
});
test('a non-restored watch seat immediately follows the current screen as before',()=>{
  const w=world(),s=watchScene(w,false,false),result=s.cycle();expect(result.labels.find(row=>row.name===SEAT)?.displayAgent).toBe('GPT Astra 6 xhigh');expect(result.work).toEqual([]);expect(result.ring).toBeNull();
});
