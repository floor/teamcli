import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mayAnalyseProject, signAnalyserSetting } from '../src/analyse/gate.ts';
import { readProjectFacts } from '../src/analyse/read.ts';
import { recordText } from '../src/config/team-record.ts';
import { upsertTeam, teamIdOf } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import type { Caller } from '../src/caller.ts';
import type { YamlValue } from '../src/yaml.ts';

const made: string[] = [];
afterEach(() => { for (const p of made.splice(0)) execFileSync('trash', [p]); });
function world() {
  const base = mkdtempSync(join(tmpdir(), 'analysis-review-')); made.push(base);
  const home = join(base, 'home'); const repo = join(base, 'repo');
  mkdirSync(join(home, '.config', 'team'), { recursive: true }); mkdirSync(repo);
  const caller: Caller = { kind: 'seat', name: 'seat-a', session: 'team-a', pane: 'pane-a' };
  const io = { cwd: repo, env: { HOME: home }, stdinIsTTY: false, caller };
  const configure = (value: YamlValue) => writeFileSync(join(home, '.config', 'team', 'entities.yaml'), recordText({ 'entity-a': { analyser: signAnalyserSetting(home, 'entity', 'entity-a', value) as unknown as YamlValue } }));
  configure({ principal: 'seat-a@team-a', roots: [repo] });
  const record = () => {
    upsertTeam(home, teamIdOf(repo), { project: 'team-a', session: 'team-a', root: repo });
    updateState(join(repo, '.agents'), state => { state.sessions['team-a'] = { seats: { 'seat-a': { stage: 'ready', pane: 'pane-a' } }, worktrees: {} }; });
  };
  return { home, repo, io, configure, record };
}


import { registerAgent, updateAgent } from '../src/registry/agents.ts';
import { symlinkSync } from 'node:fs';
import { runAnalyse } from '../src/commands/analyse.ts';

function agent(w: ReturnType<typeof world>, session: string, pane: string) {
 return registerAgent(w.home,{
  name:'seat-a',signing:{model:'Model A',version:'1',role:'builder'},lab:'vendor-a',cli:'claude-code',launcher:null,launch:'cli-a',
  reach:{team:teamIdOf(w.repo),seat:'seat-a',session,pane,address:null},mcp:[],skills:[],lifecycle:'running',by:'owner',
 });
}
function processIo(w: ReturnType<typeof world>, pane: string) {
 return {cwd:w.repo,env:{HOME:w.home},stdinIsTTY:false,callerSources:()=>({
  ancestors:()=>[{pid:101,name:'claude'},{pid:100,name:'herdr'}],
  agents:()=>[{name:'seat-a',pane,agent:'claude',workspace:'space-a',status:'idle' as const,cwd:null}],
  paneRootPid:()=>101,env:{},stdinIsTTY:false,
 })};
}


function outputIo(w: ReturnType<typeof world>) {
 let out='';let err='';
 return {...w.io,stdout:(s:string)=>{out+=s;},stderr:(s:string)=>{err+=s;},get out(){return out;},get err(){return err;}};
}

test('a target root that is itself a symlink is refused',async()=>{
 const w=world();w.record();const outside=join(w.repo,'..','outside');mkdirSync(outside);
 writeFileSync(join(outside,'README.md'),'analyser: PRIVATE_LEAF_SENTINEL\n');
 symlinkSync(outside,join(w.repo,'leaf'));const io=outputIo(w);
 expect(await runAnalyse([join(w.repo,'leaf'),'--json'],io,{home:w.home})).toBe(1);
 expect(io.out).not.toContain('PRIVATE_LEAF_SENTINEL');
});

test('a deeper ancestor alias cannot leave the canonical signed root',async()=>{
 const w=world();w.record();const outside=join(w.repo,'..','outside');
 mkdirSync(join(outside,'one','two'),{recursive:true});writeFileSync(join(outside,'one','two','README.md'),'analyser: PRIVATE_DEEP_SENTINEL\n');
 mkdirSync(join(w.repo,'src','nested'),{recursive:true});symlinkSync(outside,join(w.repo,'src','nested','alias'));
 const io=outputIo(w);expect(await runAnalyse([join(w.repo,'src','nested','alias','one','two'),'--json'],io,{home:w.home})).toBe(1);
 expect(io.out).not.toContain('PRIVATE_DEEP_SENTINEL');
});

test('an ordinary read remains available inside the authorised canonical root',async()=>{
 const w=world();w.record();mkdirSync(join(w.repo,'actual','sub'),{recursive:true});
 writeFileSync(join(w.repo,'actual','sub','README.md'),'# Safe public fixture\n');
 const io=outputIo(w);expect(await runAnalyse([join(w.repo,'actual','sub'),'--json'],io,{home:w.home})).toBe(0);
});

test('canonical aliases do not let a broader principal bypass a narrower read root',async()=>{
 const w=world();w.record();const narrow=join(w.repo,'private');mkdirSync(join(narrow,'sub'),{recursive:true});
 writeFileSync(join(narrow,'sub','README.md'),'analyser: PRIVATE_NARROW_SENTINEL\n');
 symlinkSync(narrow,join(w.repo,'alias'));
 const signed=(id:string,principal:string,root:string)=>({analyser:signAnalyserSetting(w.home,'entity',id,{principal,roots:[root]}) as unknown as YamlValue});
 writeFileSync(join(w.home,'.config','team','entities.yaml'),recordText({
  'entity-b':signed('entity-b','seat-b@team-b',narrow),
  'entity-a':signed('entity-a','seat-a@team-a',w.repo),
 }));
 const direct=outputIo(w);expect(await runAnalyse([join(narrow,'sub'),'--json'],direct,{home:w.home})).toBe(1);
 expect(direct.out).not.toContain('PRIVATE_NARROW_SENTINEL');
 const alias=outputIo(w);const code=await runAnalyse([join(w.repo,'alias','sub'),'--json'],alias,{home:w.home});
 expect(code).toBe(1);expect(alias.out).not.toContain('PRIVATE_NARROW_SENTINEL');
});

test('the global fallback requires a running placement in the authorised session',()=>{
 const w=world();expect(mayAnalyseProject(processIo(w,'pane-a'),'.',{home:w.home}).ok).toBe(false);
 const running=agent(w,'team-a','pane-a');
 expect(mayAnalyseProject(processIo(w,'pane-a'),'.',{home:w.home}).ok).toBe(true);
 updateAgent(w.home,running.id,{lifecycle:'stopped'});
 expect(mayAnalyseProject(processIo(w,'pane-a'),'.',{home:w.home}).ok).toBe(false);
});
