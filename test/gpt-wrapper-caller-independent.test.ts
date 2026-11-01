// Independent refusal-description scenes and a decision-only snapshot.
import {expect,test} from 'bun:test';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const subject=process.env.TEAM_GPT_SUBJECT_ROOT??resolve(import.meta.dir,'..');
const load=(path:string)=>import(pathToFileURL(join(subject,'src',path)).href);
const {delegateGate,delegateNamedFor}=await load('delegate.ts');
const {validateTeamFile}=await load('file/validate.ts');
const {approvalOf}=await load('approve/approval.ts');
const commands=['up','down','add','remove','approve'];
const yaml=`format: 1
project: fixture
session: team-session
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
  - name: worker
    role: implementer
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
`;
const parsed=validateTeamFile(yaml);if(!parsed.ok)throw Error('independent team fixture is invalid');
const baseTeam=parsed.team;
function fixture(mode:string,command:string,flags:string[]=[],verified=true,swap=false) {
 const entries=[{pane:'external-session/fixture-pane-delegate',commands:mode==='other-command'?['swap']:[command]}];
 const team={...baseTeam,delegates:entries};
 const worker={name:'worker',agent:'codex',pane:'fixture-pane-worker',workspace:'fixture-workspace',status:'idle',cwd:null};
 const external={name:'external',agent:'codex',pane:'fixture-pane-delegate',workspace:'fixture-workspace',status:'idle',cwd:null};
 const agents=(session:string|undefined)=>session==='team-session'?[worker]:session==='external-session'?[external]:[];
 const callerSources=(session:string|undefined)=>({
  ancestors:()=>mode==='managed'?[{pid:400,name:'codex'},{pid:1,name:'init'}]:[{pid:mode==='delegate'||mode==='other-command'?900:mode==='unplaced'?777:400,name:'sh'},{pid:300,name:'herdr'},{pid:1,name:'init'}],
  agents:()=>agents(session),paneRootPid:(pane:string)=>pane==='fixture-pane-worker'?400:pane==='fixture-pane-delegate'?900:null,
  env:{},stdinIsTTY:false,
  managedEndpointSeat:()=>mode==='managed'?{session:'team-session',seat:'worker',pane:'fixture-pane-worker'}:null,
 });
 const io={env:{},stdinIsTTY:false,callerSources};
 const standing=verified?{kind:'verified',record:{approval:approvalOf(team,'/fixture/root',new Date('2026-11-01T00:00:00Z')),file:yaml},generation:1,signedAt:'2026-11-01T00:00:00Z'}:{kind:'none'};
 const sources={standing:()=>standing,state:()=>({format:1,sessions:{}}),agents:(session:string)=>agents(session),sessionRunning:()=>true};
 return {command,team,root:'/fixture/root',dir:'/fixture/root/.agents',home:'/fixture/home',flags,io,sources,swap};
}
for(const [ci,command] of commands.entries())for(const [mi,mode] of ['managed','terminal'].entries())test(`W${ci+1}${mi+1}: refused team caller keeps its seat name`,()=>{
 const input=fixture(mode,command),verdict=delegateGate(input);
 expect({kind:verdict.kind,id:verdict.id,named:verdict.text?.endsWith('this call is worker'),unplaced:verdict.text?.includes('unplaced')}).toEqual({kind:'refused',id:command+'.delegate',named:true,unplaced:false});
 expect(delegateNamedFor(input.team,input.command,input.io)).toBe(false);
});
test('W80: a truly unplaced caller remains unplaced',()=>{
 for(const command of commands){const verdict=delegateGate(fixture('unplaced',command));expect(verdict.kind).toBe('refused');expect(verdict.id).toBe(command+'.delegate');expect(verdict.text.includes('this call is unplaced (')).toBe(true);}
});
test('W81: a matched external delegate retains its admitted command',()=>{
 for(const command of commands){const input=fixture('delegate',command);expect(delegateGate(input)).toEqual({kind:'passed',pane:'external-session/fixture-pane-delegate'});expect(delegateNamedFor(input.team,input.command,input.io)).toBe(true);}
});
test('W90: record decisions independently of display text',()=>{
 const rows:unknown[]=[];
 for(const command of commands)for(const mode of ['managed','terminal','unplaced','delegate','other-command'])for(const flags of [[],['file'],['abandon']])for(const verified of [false,true])for(const swap of [false,true]){
  const input=fixture(mode,command,flags,verified,swap),answer=delegateGate(input);
  const decision=answer.kind==='passed'?{kind:answer.kind,pane:answer.pane}:{kind:answer.kind,id:answer.id};
  expect(answer.kind==='passed'||(answer.kind==='refused'&&typeof answer.id==='string')).toBe(true);
  rows.push({command,mode,flags,verified,swap,decision,named:delegateNamedFor(input.team,input.command,input.io)});
 }
 expect(rows.length).toBe(300);
 if(process.env.TEAM_GPT_MATRIX_PATH)writeFileSync(process.env.TEAM_GPT_MATRIX_PATH,JSON.stringify(rows));
});
