// Independent reply/reader scenes using synthetic trees and registered fixture identities.
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Io } from '../src/io.ts';
const subject=process.env.TEAM_GPT_SUBJECT_ROOT??resolve(import.meta.dir,'..');
const load=(path:string)=>import(pathToFileURL(join(subject,'src',path)).href);
const {runReply}=await load('commands/reply.ts');
const {runMessages,plantRecord}=await load('commands/messages.ts');
const {readMessage}=await load('mcp/inbox.ts');
const agents=await load('registry/agents.ts'),teams=await load('registry/teams.ts');
const {updateState,emptySession}=await load('state.ts');
const records=await load('send/record.ts');
const {readHistory}=await load('send/history.ts');
const originalWrite=records.writeRecord;
const now=()=>new Date('2026-11-01T00:00:00Z');
const originalSource=process.env.TEAM_CONFIG_SOURCE;process.env.TEAM_CONFIG_SOURCE='file';
afterAll(()=>{if(originalSource===undefined)delete process.env.TEAM_CONFIG_SOURCE;else process.env.TEAM_CONFIG_SOURCE=originalSource;});
const mocks:Array<{mockRestore():void}>=[];afterEach(()=>{for(const mock of mocks.splice(0))mock.mockRestore();});
const opening='11111111-1111-4111-8111-111111111111', replyId='22222222-2222-4222-8222-222222222222';
function teamText(project:string,session:string,speaker=true) {return `format: 1
project: ${project}
entity: fixture
session: ${session}
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
  - name: responder
    role: implementer
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
${speaker?`  - name: speaker
    role: implementer
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
`:''}`;}
function ioAt(root:string,seat='responder',session='receiver-live') {
 let out='',err='';const io:Io={cwd:root,env:{TEAM_CONFIG_SOURCE:'file'},stdinIsTTY:false,caller:{kind:'seat',name:seat,pane:'fixture-pane-'+seat,session},stdout:text=>{out+=text},stderr:text=>{err+=text}};
 return {io,get out(){return out},get err(){return err}};
}
function fixture(mode='ordinary') {
 const base=realpathSync(mkdtempSync(join(tmpdir(),'gpt-reply-reader-'))),home=join(base,'home'),receiver=join(base,'receiver'),origin=join(base,'origin');
 mkdirSync(home);for(const root of [origin,receiver])mkdirSync(join(root,'.agents'),{recursive:true});
 writeFileSync(join(receiver,'.agents','team.yaml'),teamText('receiver','receiver-live'));
 if(mode!=='missing-file')writeFileSync(join(origin,'.agents','team.yaml'),teamText('origin','origin-live',mode!=='missing-seat'));
 const receiverTeam=teams.teamIdOf(receiver),originTeam=teams.teamIdOf(origin);
 function register(root:string,session:string,seat:string) {return agents.registerAgent(home,{name:seat,signing:{model:'Fixture',version:'1',role:seat==='lead'?'coordinator':'implementer'},lab:'fixture',cli:'codex',launcher:null,launch:'codex',reach:{team:teams.teamIdOf(root),seat,session,pane:'fixture-pane-'+seat,address:null},mcp:[],skills:[],lifecycle:'running',by:'fixture'});}
 const originAgent=register(origin,mode==='stale-session'?'origin-old':'origin-live','speaker');
 const responder=register(receiver,'receiver-live','responder'),localSpeaker=register(receiver,'receiver-live','speaker');
 teams.upsertTeam(home,receiverTeam,{project:'receiver',root:receiver,session:'receiver-live',entity:'fixture',roster:[{agent:responder.id,seat:'responder',role:'implementer'},{agent:localSpeaker.id,seat:'speaker',role:'implementer'}]});
 if(mode!=='missing-team')teams.upsertTeam(home,originTeam,{project:'origin',root:origin,session:mode==='stale-session'?'origin-old':'origin-live',entity:'fixture',roster:[{agent:originAgent.id,seat:'speaker',role:'implementer'}]});
 for(const [root,session] of [[receiver,'receiver-live'],[origin,'origin-live']] as const)updateState(join(root,'.agents'),(state:{sessions:Record<string,ReturnType<typeof emptySession>>})=>{const s=state.sessions[session]??=emptySession();for(const name of ['responder','speaker'])s.seats[name]={stage:'ready',pane:'fixture-pane-'+name,cli:'codex'};});
 if(mode==='retired')agents.updateAgent(home,originAgent.id,{lifecycle:'retired'});
 const same=mode==='same-team'||mode==='legacy-same';
 const fromId=mode==='unknown-agent'?'agt_000000000000':mode==='legacy-same'?null:same?localSpeaker.id:originAgent.id;
 plantRecord(home,receiver,'receiver-live','responder',opening,'fixture question',{from:'speaker',from_id:fromId,to_id:responder.id,at:now().toISOString(),thread:opening});
 const targetRoot=same?receiver:origin,targetSession=same?'receiver-live':'origin-live';
 const folder=join(targetRoot,'.agents','send-drops',targetSession,'speaker');
 async function reply() {const io=ioAt(receiver);const code=await runReply([opening,'fixture answer','--json'],io.io,{home,now,newId:()=>replyId});return {code,doc:JSON.parse(io.out),err:io.err};}
 return {base,home,origin,receiver,folder,targetRoot,targetSession,reply};
}
for(const [index,mode] of ['ordinary','stale-session'].entries())test(`P1${index+1}: cross-team reply reaches the sender reader`,async()=>{
 const f=fixture(mode),sent=await f.reply();expect(sent.code).toBe(0);
 const path=join(f.folder,replyId);expect(existsSync(path)).toBe(true);if(!existsSync(path))return;
 const record=JSON.parse(readFileSync(path,'utf8'));expect({root:record.payload.root,session:record.payload.session,to:record.payload.to,thread:record.payload.thread,inReply:record.payload.in_reply_to}).toEqual({root:f.targetRoot,session:f.targetSession,to:'speaker',thread:opening,inReply:opening});
 expect(existsSync(join(f.receiver,'.agents','send-drops','receiver-live','speaker',replyId))).toBe(false);
 if(index===0){const io=ioAt(f.origin,'speaker','origin-live');expect(await runMessages(['--json'],io.io,{home:f.home,now})).toBe(0);const document=JSON.parse(io.out);expect(document.rows.some((row:{id:string;status:string;body?:string})=>row.id===replyId&&row.status==='shown'&&row.body?.includes('fixture answer'))).toBe(true);}
 else {const read=readMessage({dropDir:f.folder,root:f.targetRoot,session:f.targetSession,seat:'speaker'},replyId,f.home);expect(read.ok&&read.body.includes('fixture answer')).toBe(true);}
 expect(existsSync(join(f.folder,replyId+'.read.json'))).toBe(true);
 expect(sent.doc.action_summary.includes('delivered (drop)')).toBe(true);
});
function holdsId(root:string):boolean {for(const name of readdirSync(root)){const path=join(root,name);if(statSync(path).isDirectory()){if(holdsId(path))return true;}else if(name===replyId)return true;}return false;}
for(const [index,mode] of ['unknown-agent','retired','missing-team','missing-file','missing-seat'].entries())test(`P2${index+1}: an unplaceable sender is refused without a reply record`,async()=>{
 const f=fixture(mode),sent=await f.reply();expect({exit:sent.code,refused:sent.doc.error?.id==='reply.refused',published:holdsId(f.base)}).toEqual({exit:1,refused:true,published:false});
});
for(const [index,field] of ['root','session','to','signature','id'].entries())test(`P3${index+1}: reader rejection prevents the delivered claim`,async()=>{
 const f=fixture('same-team');
 mocks.push(spyOn(records,'writeRecord').mockImplementation((folder:string,signed:{payload:Record<string,unknown>;signature:string})=>{
  const written=originalWrite(folder,signed);if(written.ok){
   let changed={...signed,payload:{...signed.payload}};
   if(field==='signature')changed.signature='0'.repeat(128);
   else {changed.payload[field]=field==='root'?join(f.base,'elsewhere'):'fixture-mismatch';changed=records.signRecord(changed.payload,f.home);}
   writeFileSync(join(folder,replyId),JSON.stringify(changed));
  }return written;
 }));
 const sent=await f.reply();expect(sent.code).toBe(0);
 const history=readHistory('receiver',f.receiver,f.home);expect(history.ok&&history.entries.some((entry:{id?:string;outcome:string})=>entry.id===replyId&&entry.outcome==='sent (unconfirmed)')).toBe(true);
 expect(sent.doc.action_summary.includes('could not confirm')&&!sent.doc.action_summary.includes('delivered (drop)')).toBe(true);
 const read=readMessage({dropDir:f.folder,root:f.targetRoot,session:f.targetSession,seat:'speaker'},replyId,f.home);expect(read.ok).toBe(false);
});
for(const [index,mode] of ['same-team','legacy-same'].entries())test(`P9${index+1}: same-team reader behavior remains intact`,async()=>{
 const f=fixture(mode),sent=await f.reply();expect(sent.code).toBe(0);expect(existsSync(join(f.folder,replyId))).toBe(true);
 const read=readMessage({dropDir:f.folder,root:f.targetRoot,session:f.targetSession,seat:'speaker'},replyId,f.home);expect(read.ok&&read.body.includes('fixture answer')).toBe(true);
 const sourceReceipt=join(f.receiver,'.agents','send-drops','receiver-live','responder',opening+'.replied.json');expect(existsSync(sourceReceipt)).toBe(true);
});
