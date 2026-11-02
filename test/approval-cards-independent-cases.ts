// Approval presentation must preserve the signed request and keep the record in details.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerActionCard } from '../src/client/approval-card.ts';
import { admitOwnerAction, boundWords, ownerActionHash, approveOwnerAction, createOwnerActionRequest, readOwnerActionRecord, type OwnerAction } from '../src/client/owner-action.ts';
import { actionRequestsFolder, teamCreateHash, approveTeamCreate, createTeamCreateRequest } from '../src/client/team-create.ts';
import { runApprovals } from '../src/commands/approvals.ts';
import { runSetup } from '../src/commands/setup.ts';
import { charterGate } from '../src/charter/check.ts';
import { runDevelopmentMode } from '../src/commands/development-mode.ts';
import { readDevelopmentMode } from '../src/development_mode.ts';
import { ownerPageRequest } from '../src/security/owner-page.ts';
import { seatOwner } from './helpers/owner-seat.ts';
import { gitEnv, testIo } from './helpers.ts';
import { assertIndependentHome, releaseIndependentFixture } from './approval-cards-home-fixture.ts';

const NOW=new Date('2026-11-02T09:00:00.000Z'), WORDS=['set','seats.worker','{"launch":"fixture-agent --option=value"}'], owned:string[]=[];
afterEach(()=>{for(const path of owned.splice(0))releaseIndependentFixture(path);});
test('cards and signatures start in a separate synthetic HOME',assertIndependentHome);
function world(){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'approval-cards-independent-')));owned.push(base);const home=join(base,'home'),root=join(base,'code','cards-example');mkdirSync(home,{recursive:true});mkdirSync(root,{recursive:true});
 const g=(...args:string[])=>execFileSync('git',args,{cwd:root,env:gitEnv(),encoding:'utf8'}).trim();g('init','-q','-b','main');writeFileSync(join(root,'README'),'synthetic cards fixture\n');g('add','README');g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-q','-m','test: create synthetic fixture\n\nAgent: GPT Sol 6.1 · tester');
 const store=seatOwner(home);store.prompts.length=0;return{base,home,root,store,g,head:g('rev-parse','HEAD')};
}
type World=ReturnType<typeof world>;
function snapshot(root:string):Record<string,string>{const found:Record<string,string>={};const walk=(path:string,prefix='')=>{for(const e of readdirSync(path,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())walk(join(path,e.name),rel+'/');else found[rel]=createHash('sha256').update(readFileSync(join(path,e.name))).digest('hex');}};walk(root);return found;}
function request(w:World,action:OwnerAction='team-config',words=WORDS){const made=createOwnerActionRequest(w.home,{actions:[action],root:w.root,team:'cards-example',head:w.head,args:{[action]:words},requestedBy:'seat:tester'},NOW);if(!made.ok)throw new Error(made.why);return made;}
type Page=ReturnType<typeof ownerPageRequest>&{scope?:string};
function pageOf(input:{request_id:string;kind?:string;text?:string;summary?:unknown;params_sha256?:unknown}):Page{return ownerPageRequest(input);}
function lines(page:Page){return[page.title,page.description,...(page.scope===undefined?[]:[page.scope])];}
function plain(page:Page,hidden:string[]){const shown=lines(page);expect(shown.length).toBeLessThanOrEqual(3);expect(page.title).not.toStartWith('TeamCLI: ');expect(page.description).toEndWith('OK?');for(const line of shown){expect(line).not.toMatch(/[\r\n]/);expect(line.length).toBeGreaterThan(0);for(const value of hidden)expect(line).not.toContain(value);}}
const kinds=['team-create','team-import','team-migrate','team-add','team-up','team-send','team-down','team-bus','team-revoke-approval','team-forget','team-config','team-general-grant'] as const;
const changes:Partial<Record<OwnerAction,string>>={'team-create':'creates the team file','team-import':'changes the team file','team-migrate':'changes the team file','team-config':'changes the team file','team-revoke-approval':'removes an approval rule','team-general-grant':'grants operations to another tool'};
for(const action of kinds)test(`${action} page, signing reason and details preserve one exact request`,async()=>{
 const w=world(),made=request(w,action),r=made.record,path=join(actionRequestsFolder(w.home),r.request_id+'.json'),bytes=readFileSync(path);
 const page=pageOf({request_id:r.request_id,kind:'owner-action-confirmation',text:made.text,summary:r.params,params_sha256:r.params_sha256});
 plain(page,[r.request_id,w.root,w.head,r.params_sha256,WORDS.join(' ')]);expect(page.description).toEndWith('?');expect(page.scope).toBe('Team cards-example · '+(changes[action]??'no permission change'));expect(page.description).toContain('tester wants to ');expect(page.onceOnly).toBe(action==='team-migrate');
 for(const part of [r.request_id,w.root,w.head,r.params_sha256,WORDS.join(' ')])expect(page.details).toContain(part);
 const before=snapshot(w.home),text=testIo(w.root,{kind:'owner-no-tty'}),json=testIo(w.root,{kind:'owner-no-tty'});
 expect(await runApprovals(['details',r.request_id],text,{home:w.home,ownerSeatStore:w.store,now:()=>NOW})).toBe(0);expect(await runApprovals(['details',r.request_id,'--json'],json,{home:w.home,ownerSeatStore:w.store,now:()=>NOW})).toBe(0);
 for(const part of [r.request_id,w.root,w.head,r.params_sha256,WORDS.join(' ')])expect(text.out).toContain(part);expect(JSON.parse(json.out).request).toEqual(r);expect(snapshot(w.home)).toEqual(before);
 expect(approveOwnerAction(w.home,r.request_id,'oui',w.store,NOW)).toMatchObject({ok:true});expect(w.store.prompts).toEqual([lines(page).join(' — ')]);expect(readFileSync(path)).toEqual(bytes);
 const ask={action,root:w.root,team:'cards-example',head:w.head,words:WORDS,claim:true};expect(admitOwnerAction(w.home,r.request_id,ask,w.store,NOW).ok).toBe(true);expect(admitOwnerAction(w.home,r.request_id,ask,w.store,NOW).ok).toBe(false);
 const audited=testIo(w.root,{kind:'owner-no-tty'});expect(await runApprovals(['details',r.request_id,'--json'],audited,{home:w.home,ownerSeatStore:w.store,now:()=>NOW})).toBe(0);expect(JSON.parse(audited.out).audit).toContain(r.request_id+'.'+action);
});
test('a bundled card names the asker once and preserves each action and claim',()=>{
 const w=world(),made=createOwnerActionRequest(w.home,{actions:['team-create','team-up'],root:w.root,team:'cards-example',head:w.head,args:{'team-create':['init','--file','fixture.yaml'],'team-up':['up','--then-up']},requestedBy:'seat:tester'},NOW);if(!made.ok)throw new Error(made.why);const r=made.record,page=pageOf({request_id:r.request_id,kind:'owner-action-confirmation',text:made.text,summary:r.params,params_sha256:r.params_sha256});plain(page,[r.request_id,w.root,w.head,r.params_sha256,'fixture.yaml','--then-up']);expect(lines(page).join(' ').split('tester').length-1).toBe(1);expect(page.scope).toBe('Team cards-example · creates the team file');expect(page.title).toBe('Create a team, then start the team');expect(page.details).toContain('init --file fixture.yaml');expect(page.details).toContain('up --then-up');expect(approveOwnerAction(w.home,r.request_id,'oui',w.store,NOW).ok).toBe(true);expect(w.store.prompts).toEqual([lines(page).join(' — ')]);
 for(const action of ['team-create','team-up'] as const){const ask={action,root:w.root,team:'cards-example',head:w.head,words:r.params.words![action]!,claim:true};expect(admitOwnerAction(w.home,r.request_id,ask,w.store,NOW).ok).toBe(true);expect(admitOwnerAction(w.home,r.request_id,ask,w.store,NOW).ok).toBe(false);}
});
test('a legacy grant without a short prompt folds its record behind a generic question',()=>{
 const id='gr_'+'5e'.repeat(12),detail='RECORD_ONLY --flag=value /synthetic/repo';const page=pageOf({request_id:id,kind:'grant-confirmation',text:detail});plain(page,[id,detail,'RECORD_ONLY']);expect(lines(page)).toEqual(['Issue a grant','Approve this request. OK?']);expect(page.details).toContain(id);expect(page.details).toContain(detail);
});
for(const [answer,scope] of [['always','Team cards-example · always allows this, until revoked'],['non','Team cards-example · refused, nothing changes']] as const)test(`${answer} signing reason names its answer without altering request bytes`,()=>{
 const w=world(),m=request(w),r=m.record,bytes=readFileSync(join(actionRequestsFolder(w.home),r.request_id+'.json'));expect(approveOwnerAction(w.home,r.request_id,answer,w.store,NOW).ok).toBe(true);const prompt=w.store.prompts.at(-1)!;expect(prompt.split(' — ').at(-1)).toBe(scope);for(const secret of [r.request_id,w.root,w.head,r.params_sha256,WORDS.join(' ')])expect(prompt).not.toContain(secret);expect(readFileSync(join(actionRequestsFolder(w.home),r.request_id+'.json'))).toEqual(bytes);
 expect(admitOwnerAction(w.home,r.request_id,{action:'team-config',root:w.root,team:'cards-example',head:w.head,words:WORDS,claim:false},w.store,NOW).ok).toBe(answer==='always');
});
for(const answer of ['oui','always','non'])test(`team creation ${answer} uses a short card while preserving details`,()=>{
 const w=world(),m=createTeamCreateRequest(w.home,w.root,w.head,NOW);if(!m.ok)throw new Error(m.why);const r=m.record,page=pageOf({request_id:r.request_id,kind:'team-create-confirmation',text:m.text,summary:r.params,params_sha256:r.params_sha256});plain(page,[r.request_id,w.root,w.head,r.params_sha256]);expect(lines(page)).toEqual(['Create a team','Create a team. OK?','Team cards-example · creates the team file']);for(const part of [r.request_id,w.root,w.head,r.params_sha256])expect(page.details).toContain(part);expect(approveTeamCreate(w.home,r.request_id,answer,w.store,NOW).ok).toBe(true);const expected=answer==='oui'?'Team cards-example · creates the team file':answer==='always'?'Team cards-example · always allows this, until revoked':'Team cards-example · refused, nothing changes';expect(w.store.prompts).toEqual([[page.title,page.description,expected].join(' — ')]);
});
for(const variant of ['regular','master','team','unlimited'])test(`${variant} grant keeps only the supplied catalog prompt on its card`,()=>{
 const id='gr_'+ '2b'.repeat(12),prompt='Allow Fixture Bot on team sample: send to captain. Expires tomorrow.',detail='RECORD_ONLY fixture-agent --flag=value /synthetic/repo '+ 'a'.repeat(64);
 const page=pageOf({request_id:id,kind:'grant-confirmation',text:detail,summary:{text:detail,prompt,expires:variant==='unlimited'?null:'2027-01-01',...(variant==='master'?{master:true}:{}),...(variant==='team'?{up:{team:'sample'}}:{})}});
 plain(page,[id,detail,'RECORD_ONLY','/synthetic/repo']);expect(page.description).toBe(prompt+' OK?');expect(page.details).toContain(detail);expect(page.details).toContain(id);expect(page.onceOnly).toBe(variant!=='regular');
});
for(const summary of [undefined,{kind:'owner-action',actions:['unknown-action']},{kind:'owner-action',actions:[]}])test(`legacy or unknown request renders generic card with full folded record ${JSON.stringify(summary)}`,()=>{
 const id='oa_'+ '3c'.repeat(12),detail='RECORD_ONLY /synthetic/repo --launch {"x":1}';const page=pageOf({request_id:id,kind:'owner-action-confirmation',text:detail,summary});plain(page,[id,detail,'RECORD_ONLY']);expect(lines(page)).toEqual(['Approve a request','Approve this request. OK?']);expect(page.details).toContain(id);expect(page.details).toContain(detail);
});
async function dev(w:World,args:string[],now=NOW){const io=testIo(w.root,{kind:'owner-no-tty'});const options={home:w.home,now,ownerSeatStore:w.store,present:false};const code=await runDevelopmentMode(args,io,options);return{code,io};}
async function devRequest(w:World,mode='local-fast'){const out=await dev(w,['set',mode,'--request','--json']);expect(out.code,out.io.err).toBe(0);const id=JSON.parse(out.io.out).request_id as string;expect(id).toMatch(/^oa_[0-9a-f]{24}$/);const r=readOwnerActionRecord(w.home,id);if(typeof r==='string')throw new Error(r);return r;}
const modeText={ 'local-fast':['Turn on fast local development','Stop asking Touch ID for routine team changes on this Mac. OK?'], 'pr-per-change':['Use a pull request for every change','Ask for a pull request for every team change on this Mac. OK?'], off:['Turn off fast local development','Ask Touch ID again for routine team changes on this Mac. OK?'] } as const;
for(const mode of ['local-fast','pr-per-change','off'] as const)test(`development mode ${mode} waits for its answer then changes once`,async()=>{
 const w=world(),r=await devRequest(w,mode);expect(readDevelopmentMode(w.home).kind).toBe('absent');expect(r.params.words?.['development-mode' as OwnerAction]).toEqual(['set',mode]);expect(w.store.prompts).toEqual([]);
 const page=pageOf({request_id:r.request_id,kind:'owner-action-confirmation',text:'hidden',summary:r.params,params_sha256:r.params_sha256});expect(lines(page)).toEqual([modeText[mode][0],modeText[mode][1],'This Mac · all teams']);
 expect(approveOwnerAction(w.home,r.request_id,'oui',w.store,NOW).ok).toBe(true);expect(w.store.prompts).toEqual([lines(page).join(' — ')]);const apply=await dev(w,['set',mode,'--approval',r.request_id,'--json']);expect(apply.code,apply.io.err+apply.io.out).toBe(0);const state=readDevelopmentMode(w.home);expect(state.kind).toBe('set');if(state.kind==='set')expect(state.record.mode).toBe(mode);const before=snapshot(w.home);expect((await dev(w,['set',mode,'--approval',r.request_id])).code).toBe(1);expect(snapshot(w.home)).toEqual(before);
});
for(const mismatch of ['words','root','team','head','request-id','unsigned','deny','expired'])test(`development mode refuses ${mismatch} without a mode record`,async()=>{
 const w=world(),r=await devRequest(w);if(mismatch!=='unsigned')expect(approveOwnerAction(w.home,r.request_id,mismatch==='deny'?'non':'oui',w.store,NOW).ok).toBe(true);
 let mode='local-fast',id=r.request_id,now=NOW;
 if(mismatch==='words')mode='off';if(mismatch==='root'){const root=join(w.base,'foreign','cards-example');mkdirSync(root,{recursive:true});execFileSync('git',['clone','-q',w.root,root],{env:gitEnv()});w.root=root;}
 if(mismatch==='team'){mkdirSync(join(w.root,'.agents'),{recursive:true});writeFileSync(join(w.root,'.agents/team.yaml'),'format: 1\nproject: different-team\nsession: sample\noperator: captain\nworkspace:\n  mode: shared\nseats:\n  - name: captain\n    role: orchestrator\n    leads: true\n    cli: codex\n    vendor: openai\n    model: GPT Sol\n    version: "6.1"\n    launch: codex -m gpt-6.1-sol\n');}
 if(mismatch==='head')w.g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-q','--allow-empty','-m','test: advance synthetic fixture\n\nAgent: GPT Sol 6.1 · tester');
 if(mismatch==='request-id'){const other=await devRequest(w,'off');writeFileSync(join(actionRequestsFolder(w.home),other.request_id+'.seat-answer.json'),readFileSync(join(actionRequestsFolder(w.home),id+'.seat-answer.json')));id=other.request_id;mode='off';}
 if(mismatch==='expired')now=new Date(NOW.getTime()+16*60*1000);const before=snapshot(w.home);const out=await dev(w,['set',mode,'--approval',id],now);expect(out.code,out.io.out+out.io.err).toBe(1);expect(readDevelopmentMode(w.home).kind).toBe('absent');expect(snapshot(w.home)).toEqual(before);
});
for(const flag of ['--show','--dry-run'])for(const door of ['--request','--approval'])test(`${flag} and ${door} refuse before request or setting writes`,async()=>{
 const w=world(),before=snapshot(w.home),args=['set','local-fast',flag,door,...(door==='--approval'?['oa_'+'4d'.repeat(12)]:[])];expect((await dev(w,args)).code).toBe(2);expect(snapshot(w.home)).toEqual(before);expect(w.store.prompts).toEqual([]);
});
test('a verified folder charter cannot switch machine development mode',async()=>{
 const w=world(),io=testIo(w.root,{kind:'owner-no-tty'});expect(await runSetup(['--signer','touch-id','--roots',w.root],io,{home:w.home,store:w.store,now:()=>NOW})).toBe(0);expect(charterGate(w.home,{operation:'config',cwd:w.root},w.store).kind).toBe('admit');w.store.prompts.length=0;
 expect((await dev(w,['set','off'])).code).toBe(1);expect(readDevelopmentMode(w.home).kind).toBe('absent');const r=await devRequest(w,'off');expect(r.params.words?.['development-mode' as OwnerAction]).toEqual(['set','off']);expect(readDevelopmentMode(w.home).kind).toBe('absent');expect(w.store.prompts).toEqual([]);
});
test('request and approval cannot combine and cannot replace a missing signature',async()=>{
 const w=world(),r=await devRequest(w),before=snapshot(w.home);expect((await dev(w,['set','local-fast','--request','--approval',r.request_id])).code).toBe(1);expect((await dev(w,['set','local-fast'])).code).toBe(1);expect(snapshot(w.home)).toEqual(before);
});

test('a request reason is a short clause and a pane label becomes only the asker name',()=>{
 const w=world(),input={actions:['team-up' as OwnerAction],root:w.root,team:'cards-example',head:w.head,args:{'team-up':['up']},requestedBy:'sample-session/captain',reason:'  finish\n the\t release  '};const m=createOwnerActionRequest(w.home,input,NOW);if(!m.ok)throw new Error(m.why);const p=m.record.params as typeof m.record.params&{reason?:string};expect(p.reason).toBe('finish the release');const card=ownerActionCard(p);expect(card).toEqual({title:'Start the team',question:'captain wants to start the team for finish the release. OK?',scope:'Team cards-example · no permission change'});expect(approveOwnerAction(w.home,m.record.request_id,'oui',w.store,NOW).ok).toBe(true);expect(w.store.prompts).toEqual([[card.title,card.question,card.scope].join(' — ')]);
});
test('a long reason is folded into one bounded clause without changing its recorded words',()=>{
 const w=world(),reason='finish the release with all the remaining independent tests and record every final result before the handoff';const input={actions:['team-up' as OwnerAction],root:w.root,team:'cards-example',head:w.head,args:{'team-up':['up']},requestedBy:'seat:captain',reason};const m=createOwnerActionRequest(w.home,input,NOW);if(!m.ok)throw new Error(m.why);const p=m.record.params as typeof m.record.params&{reason?:string},card=ownerActionCard(p);expect(p.reason).toBe(reason);expect(card.question).toStartWith('captain wants to start the team for ');expect(card.question).toEndWith('… OK?');expect(card.question.length).toBeLessThan(105);expect(card.question).not.toContain('\n');
});
for(const reason of ['finish the release','finish\n  the release'])test(`display reason changes no action hash or admission: ${JSON.stringify(reason)}`,()=>{
 const w=world(),m=request(w),r=m.record,path=join(actionRequestsFolder(w.home),r.request_id+'.json'),hash=ownerActionHash(r.params);expect(approveOwnerAction(w.home,r.request_id,'oui',w.store,NOW).ok).toBe(true);const altered={...r,params:{...r.params,reason}};expect(ownerActionHash(altered.params)).toBe(hash);writeFileSync(path,JSON.stringify(altered));expect(admitOwnerAction(w.home,r.request_id,{action:'team-config',root:w.root,team:'cards-example',head:w.head,words:WORDS,claim:true},w.store,NOW).ok).toBe(true);
});
for(const form of ['separate','equals'])test(`development-mode reason ${form} is recorded but not executable words`,async()=>{
 const w=world(),reason='finish the release',flags=form==='separate'?['--reason',reason]:['--reason='+reason],out=await dev(w,['set','off','--request',...flags,'--json']);expect(out.code,out.io.err).toBe(0);const id=JSON.parse(out.io.out).request_id,r=readOwnerActionRecord(w.home,id);if(typeof r==='string')throw new Error(r);expect((r.params as typeof r.params&{reason?:string}).reason).toBe(reason);expect(r.params.words?.['development-mode' as OwnerAction]).toEqual(['set','off']);expect(readDevelopmentMode(w.home).kind).toBe('absent');expect(approveOwnerAction(w.home,id,'oui',w.store,NOW).ok).toBe(true);expect((await dev(w,['set','off','--approval',id,'--reason','a different explanation'])).code).toBe(0);
});
for(const words of [['set','off','--reason','finish release','--json','--request'],['set','off','--reason=finish release','--approval=oa_fixture'],['set','off','--reason','--request']])test(`display reason is removed from bound words ${JSON.stringify(words)}`,()=>{
 expect(boundWords(words)).toEqual(['set','off']);
});
test('team-create display asker and reason do not alter the signed parameters',()=>{
 const p={kind:'team-create' as const,root:'/synthetic/repo',team:'example',head:'a'.repeat(40)},decorated={...p,requested_by:'sample/captain',reason:'finish the release'};expect(teamCreateHash(decorated)).toBe(teamCreateHash(p));
});
test('a caller reason must not put a raw machine path on the owner card',()=>{
 const w=world(),input={actions:['team-up' as OwnerAction],root:w.root,team:'cards-example',head:w.head,args:{'team-up':['up']},requestedBy:'seat:captain',reason:'release /synthetic/private/project'};const m=createOwnerActionRequest(w.home,input,NOW);if(!m.ok)throw new Error(m.why);const card=ownerActionCard(m.record.params);expect([card.title,card.question,card.scope].join('\n')).not.toContain('/synthetic/private/project');
});
