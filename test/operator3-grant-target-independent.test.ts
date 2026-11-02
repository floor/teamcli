import {afterAll,afterEach,expect,spyOn,test} from 'bun:test';
import {createHash,generateKeyPairSync,randomBytes,sign as cryptoSign,type KeyObject} from 'node:crypto';
import * as child from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {runGrant} from '../src/commands/grant.ts';
import {runApprovals} from '../src/commands/approvals.ts';
import {runInit} from '../src/commands/init.ts';
import {registerOwnerSeat,type OwnerSeatKeyStore} from '../src/client/owner-seat.ts';
import {approveOwnerAction,createOwnerActionRequest} from '../src/client/owner-action.ts';
import {actionApprovalsFolder,actionRequestsFolder,approveTeamCreate,createTeamCreateRequest,setApprovalMode} from '../src/client/team-create.ts';
import {GRANT_REQUEST_DOMAIN,GRANT_RULE_DOMAIN,grantApprovalsFolder,grantRequestsFolder,pendingGrantHash,type PendingGrantParams} from '../src/client/emission.ts';
import {keyOf,signDomain,type Json} from '../src/store/keys.ts';
import {writePolicySet} from '../src/policy/sources.ts';
import {teamIdOf,upsertTeam} from '../src/registry/teams.ts';
import type {Caller} from '../src/caller.ts';
import type {Io} from '../src/io.ts';

// The sole external command allowed is git operating in this file's own synthetic folders.
// No credential-store helper, notification, terminal host or agent CLI can be reached.
const external:string[]=[];
const realExec=child.execFileSync;
const execGuard=spyOn(child,'execFileSync').mockImplementation(((command:any,args:any,options:any)=>{
 const where=options?.cwd??(Array.isArray(args)&&args.includes('-C')?args[args.indexOf('-C')+1]:undefined);
 if(command==='git'&&typeof where==='string'&&where.startsWith('/private/tmp/o3gr-'))return realExec(command,args,options);
 external.push(String(command));throw Error('independent fixture blocked an external command');
}) as typeof child.execFileSync);
const spawnGuard=spyOn(child,'spawn').mockImplementation((()=>{external.push('spawn');throw Error('no external launch');}) as typeof child.spawn);
afterEach(()=>{expect(external.splice(0)).toEqual([]);});
afterAll(()=>{execGuard.mockRestore();spawnGuard.mockRestore();});
const owner:Caller={kind:'owner'};
const seat:Caller={kind:'seat',name:'independent-caller',pane:'synthetic-pane'};
const now=new Date();
function fixture(){
 const base=mkdtempSync('/private/tmp/o3gr-'),home=join(base,'home'),scope=join(base,'covered');mkdirSync(scope,{recursive:true});
 const keys=new Map<string,{privateKey:KeyObject;publicKey:string}>();const pins=new Map<string,string>();
 const store:OwnerSeatKeyStore={name:'independent-in-memory',available:()=>true,
  create:label=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=pair.publicKey.export({format:'jwk'});const publicKey='04'+Buffer.from(jwk.x!,'base64url').toString('hex')+Buffer.from(jwk.y!,'base64url').toString('hex');keys.set(label,{privateKey:pair.privateKey,publicKey});return{ok:true,publicKey};},
  publicKey:label=>keys.has(label)?{ok:true,publicKey:keys.get(label)!.publicKey}:{ok:false,why:'absent synthetic key'},
  sign:(label,message)=>keys.has(label)?{ok:true,signature:cryptoSign('sha256',message,keys.get(label)!.privateKey).toString('hex')}:{ok:false,why:'absent synthetic key'},
  pinSet:(label,value)=>{if(pins.has(label))return{ok:false,why:'already pinned'};pins.set(label,value);return{ok:true};},
  pinGet:label=>pins.has(label)?{ok:true,value:pins.get(label)!}:{ok:false,why:'no pin'},
 };
 expect(registerOwnerSeat(home,{team:'independent-entity',signer:'fixture-signer'},store,now).ok).toBe(true);
 expect(writePolicySet(home,{level:'entity',target:'independent-entity',name:'owner-signers',value:['fixture-signer']},{now}).ok).toBe(true);
 keyOf(home);
 return{base,home,scope,store};
}
type World=ReturnType<typeof fixture>;
function io(w:World,cwd:string,caller:Caller){let out='',err='';const value:Io={cwd,env:{HOME:w.home,TEAM_CONFIG_SOURCE:'registry'},caller,stdinIsTTY:false,stdout:t=>{out+=t;},stderr:t=>{err+=t;}};return{value,out:()=>out,err:()=>err};}
function signedRevokeConsent(w:World){
 const root=join(w.scope,'consent-origin');mkdirSync(root);
 const request=createOwnerActionRequest(w.home,{actions:['team-revoke-approval'],root,team:'independent-target',head:null,args:{'team-revoke-approval':[]},requestedBy:'independent-agent'},now,()=>{});
 if(!request.ok)throw Error(request.why);
 const approved=approveOwnerAction(w.home,request.record.request_id,'always',w.store,now,{signer:'fixture-signer'});expect(approved.ok).toBe(true);
 return join(actionApprovalsFolder(w.home),request.record.request_id+'.json');
}
function teamRule(w:World,root:string){
 mkdirSync(root,{recursive:true});const requested=createTeamCreateRequest(w.home,root,null,now);if(!requested.ok)throw Error(requested.why);
 expect(approveTeamCreate(w.home,requested.record.request_id,'always',w.store,now,{signer:'fixture-signer'}).ok).toBe(true);
 return requested.record.request_id;
}
function records(w:World,root:string){
 mkdirSync(root,{recursive:true});const team='independent-target';upsertTeam(w.home,teamIdOf(root),{project:team,session:team,entity:'independent-entity',root,roster:[],lifecycle:'running'});
 const pending='gr_'+randomBytes(12).toString('hex');
 const params:PendingGrantParams={client_id:'independent-client',entity:'independent-entity',public_key:'04'+'ab'.repeat(64),key_id:'key-1',key_dir:join(w.base,'synthetic-keys'),team,seat:null,expires:null,inbox:false,allow_grant:false,grant_scope:null};
 const body={request_id:pending,params,params_sha256:pendingGrantHash(params),created:now.toISOString(),expires_at:new Date(now.getTime()+900000).toISOString(),adapter:'owner-answer',seal:''};
 mkdirSync(grantRequestsFolder(w.home),{recursive:true});writeFileSync(join(grantRequestsFolder(w.home),pending+'.json'),JSON.stringify({grant_request:body,signature:signDomain(GRANT_REQUEST_DOMAIN,{name:pending,grant_request:body as unknown as Json},keyOf(w.home))}));
 const grantRule='ar_'+randomBytes(12).toString('hex'),rule={rule_id:grantRule,created:now.toISOString(),approved_by:'fixture',client_id:'independent-client',entity:'independent-entity',teams:[team],seats:['lead'],ops:['send'],max_duration_seconds:604800};
 mkdirSync(grantApprovalsFolder(w.home),{recursive:true});writeFileSync(join(grantApprovalsFolder(w.home),grantRule+'.json'),JSON.stringify({approval_rule:rule,signature:signDomain(GRANT_RULE_DOMAIN,{name:grantRule,approval_rule:rule},keyOf(w.home))}));
 const approvalsRule=teamRule(w,join(root,'approval-target')),initRule=teamRule(w,join(root,'init-target'));
 expect(setApprovalMode(w.home,'team-create','none',root,w.store,now,{signer:'fixture-signer'}).ok).toBe(true);
 return{pending,grantRule,approvalsRule,initRule,root};
}
function snapshot(home:string){const rows:Record<string,string>={};function walk(dir:string){for(const name of readdirSync(dir).sort()){const path=join(dir,name),st=statSync(path);if(st.isDirectory())walk(path);else rows[relative(home,path)]=createHash('sha256').update(readFileSync(path)).digest('hex');}}walk(home);return rows;}
const forms=['deny','grant-revoke','approvals-revoke','init-revoke','init-mode'] as const;
async function invoke(form:typeof forms[number],w:World,target:ReturnType<typeof records>,cwd:string,caller:Caller){
 const channel=io(w,cwd,caller),sources={home:w.home,now:()=>now,ownerSeatStore:w.store};let code:number;
 if(form==='deny')code=await runGrant(['--deny',target.pending],channel.value,{home:w.home,now,ownerSeatStore:w.store,present:false});
 else if(form==='grant-revoke')code=await runGrant(['--revoke-approval',target.grantRule],channel.value,{home:w.home,now,ownerSeatStore:w.store,present:false});
 else if(form==='approvals-revoke')code=await runApprovals(['revoke',target.approvalsRule],channel.value,sources);
 else code=await runInit(form==='init-revoke'?['--revoke-approval',target.initRule]:['--approval-mode','per-action','--scope',target.root],channel.value,w.home,undefined,{loggedIn:()=>true,now:()=>now,ownerSeatStore:w.store});
 return{code,err:channel.err(),out:channel.out()};
}
for(const form of forms){
 test(`${form}: an unapproved seat changes no record bytes`,async()=>{const w=fixture(),target=records(w,join(w.scope,'target')),before=snapshot(w.home);const result=await invoke(form,w,target,w.scope,seat);expect(result.code,result.err).toBe(1);expect(snapshot(w.home)).toEqual(before);});
 test(`${form}: consent follows the target even when the caller is outside its scope`,async()=>{const w=fixture();signedRevokeConsent(w);const target=records(w,join(w.scope,'target'));const elsewhere=join(w.base,'unrelated-caller');mkdirSync(elsewhere);const result=await invoke(form,w,target,elsewhere,seat);expect(result.code,result.err).toBe(0);});
 test(`${form}: a caller inside scope cannot change an outside target`,async()=>{const w=fixture();signedRevokeConsent(w);const target=records(w,join(w.base,'outside-target'));const caller=join(w.scope,'caller');mkdirSync(caller);child.execFileSync('git',['init','-q'],{cwd:caller});const before=snapshot(w.home);const result=await invoke(form,w,target,caller,seat);expect(result.code,result.err).toBe(1);expect(snapshot(w.home)).toEqual(before);});
 test(`${form}: tampered standing consent grants no authority`,async()=>{const w=fixture();const rule=signedRevokeConsent(w);writeFileSync(rule,readFileSync(rule,'utf8').replace('fixture-signer','forged-signer'));const target=records(w,join(w.scope,'target')),before=snapshot(w.home);const result=await invoke(form,w,target,w.scope,seat);expect(result.code,result.err).toBe(1);expect(snapshot(w.home)).toEqual(before);});
 test(`${form}: the owner still acts without standing consent`,async()=>{const w=fixture(),target=records(w,join(w.scope,'target'));const result=await invoke(form,w,target,w.scope,owner);expect(result.code,result.err).toBe(0);});
}
