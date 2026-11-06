import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mayAnalyseProject, signAnalyserSetting } from '../src/analyse/gate.ts';
import { readProjectFacts } from '../src/analyse/read.ts';
import { recordText } from '../src/config/team-record.ts';
import { upsertTeam, teamIdOf } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import type { Caller } from '../src/caller.ts';
import type { YamlValue } from '../src/yaml.ts';

const made: string[] = [];
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }); });
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


import { registerAgent } from '../src/registry/agents.ts';
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

test('unique team with no state cannot borrow its seat agent from a foreign session',()=>{
 const w=world();upsertTeam(w.home,teamIdOf(w.repo),{project:'team-a',session:'team-a',root:w.repo});
 agent(w,'team-b','pane-b');
 expect(mayAnalyseProject(processIo(w,'pane-b'),'.',{home:w.home}).ok).toBe(false);
});

test('unique team with no state can use its agent in the authorised session',()=>{
 const w=world();upsertTeam(w.home,teamIdOf(w.repo),{project:'team-a',session:'team-a',root:w.repo});
 agent(w,'team-a','pane-a');
 expect(mayAnalyseProject(processIo(w,'pane-a'),'.',{home:w.home}).ok).toBe(true);
});

test('a recorded pane remains authoritative over a foreign-session agent fallback',()=>{
 const w=world();w.record();agent(w,'team-b','pane-b');
 expect(mayAnalyseProject(processIo(w,'pane-b'),'.',{home:w.home}).ok).toBe(false);
});

test('an agent whose team key matches but whose session differs cannot stand alone',()=>{
 const w=world();agent(w,'team-b','pane-b');
 expect(mayAnalyseProject(processIo(w,'pane-b'),'.',{home:w.home}).ok).toBe(false);
});

test('a parent symlink cannot turn a signed lexical root into an outside read',async()=>{
 const w=world();w.record();const outside=join(w.repo,'..','outside');
 mkdirSync(join(outside,'private'),{recursive:true});
 writeFileSync(join(outside,'private','README.md'),'analyser: PRIVATE_SCOPE_SENTINEL\n');
 symlinkSync(outside,join(w.repo,'escape'));
 let out='';let err='';const io={...w.io,stdout:(s:string)=>{out+=s;},stderr:(s:string)=>{err+=s;}};
 const code=await runAnalyse([join(w.repo,'escape','private'),'--json'],io,{home:w.home});
 expect(out).not.toContain('PRIVATE_SCOPE_SENTINEL');
 expect(code).toBe(1);
});
