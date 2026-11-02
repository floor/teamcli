// Socket kind and process launch are injected: regular marker files exercise real inode,
// permission, owner-record and link hygiene without starting a CLI or binding any live socket.
import {afterAll,afterEach,beforeEach,expect,spyOn,test} from 'bun:test';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import * as childProcesses from 'node:child_process';
import {basename,dirname,join} from 'node:path';

// All process identities are synthetic. Block even swallowed default signals before the source
// modules load; the state lock's self-liveness question is answered here without a syscall.
const originalKill=process.kill;
const signals:Array<{pid:number;signal:unknown}>=[];
process.kill=((pid:number,signal?:string|number)=>{
 if(pid===process.pid&&signal===0)return true;
 signals.push({pid,signal});throw Error('independent fixture blocked a real process signal');
}) as typeof process.kill;
const launches:string[]=[];
const spawnGuard=spyOn(childProcesses,'spawn').mockImplementation((()=>{launches.push('spawn');throw Error('no external process may start in this fixture');}) as typeof childProcesses.spawn);
const execGuard=spyOn(childProcesses,'execFileSync').mockImplementation((()=>{launches.push('execFileSync');throw Error('no external process may be read in this fixture');}) as typeof childProcesses.execFileSync);
const endpoint=await import('../../src/launch/codex-endpoint.ts');
const state=await import('../../src/state.ts');
beforeEach(()=>{signals.length=0;launches.length=0;});
afterEach(()=>{expect(signals).toEqual([]);expect(launches).toEqual([]);});
afterAll(()=>{process.kill=originalKill;spawnGuard.mockRestore();execGuard.mockRestore();});
const session='independent-room',seat='independent-seat',binding='prs_9876543210ab';
function world(){
 const base=mkdtempSync('/private/tmp/o3ep-');const dir=join(base,'deep'.repeat(32),'.agents');mkdirSync(dir,{recursive:true});
 state.updateState(dir,s=>{(s.sessions[session]??=state.emptySession()).seats[seat]={stage:'launched',presence_binding:binding};});
 return{base,dir,runtime:join(base,'rt')};
}
function socket(w:ReturnType<typeof world>){const got=endpoint.codexEndpointSocket(w.dir,session,seat,binding,w.runtime);expect(got).not.toBeNull();if(!got)throw Error('deep launch had no bindable endpoint');return got;}
function start(w:ReturnType<typeof world>,over:Partial<import('../../src/launch/codex-endpoint.ts').CodexEndpointDeps>={}){
 const terminated:number[]=[];let spawned=0;
 const deps={runtimeRoot:w.runtime,alive:()=>false,commandOf:()=>null,startOf:()=>null,terminate:(pid:number)=>{terminated.push(pid);},waitMs:500,
  spawn:({url}:{url:string})=>{spawned++;writeFileSync(url.slice('unix://'.length),'owned synthetic socket entry',{mode:0o600});return{pid:424242};},
  isSocket:(path:string)=>existsSync(path)&&lstatSync(path).isFile()&&path.endsWith('.sock'),sleep:async()=>{await new Promise(r=>setTimeout(r,5));},...over};
 return{terminated,spawned:()=>spawned,run:()=>endpoint.ensureCodexEndpoint({dir:w.dir,session,seat,deps})};
}
test('deep launches use a short distinct hashed path and retain an owner-only directory and record',async()=>{
 const w=world();mkdirSync(w.runtime,{mode:0o777});const chosen=socket(w);
 expect(Buffer.byteLength(chosen.path)).toBeLessThanOrEqual(100);expect(chosen.path.startsWith(w.runtime+'/')).toBe(true);
 expect(basename(chosen.path)).toMatch(/^[0-9a-f]{32}\.sock$/);
 expect(endpoint.codexEndpointSocket(w.dir,session,'different-seat',binding,w.runtime)?.path).not.toBe(chosen.path);
 const launched=start(w);expect((await launched.run()).kind).toBe('up');expect(launched.terminated).toEqual([]);
 expect(lstatSync(w.runtime).mode&0o777).toBe(0o700);expect(lstatSync(w.runtime).uid).toBe(process.getuid!());
 expect(lstatSync(chosen.path).isFile()).toBe(true);expect(lstatSync(chosen.path).mode&0o777).toBe(0o600);
 const owner=join(dirname(chosen.path),basename(chosen.path,'.sock')+'.owner.json');
 expect(lstatSync(owner).isSymbolicLink()).toBe(false);expect(lstatSync(owner).mode&0o777).toBe(0o600);
 expect(JSON.parse(readFileSync(owner,'utf8'))).toMatchObject({dir:w.dir,binding,pid:424242});
});
test('a linked runtime folder is refused before any launch and its target remains untouched',async()=>{
 const w=world(),target=join(w.base,'other');mkdirSync(target);writeFileSync(join(target,'sentinel'),'unchanged');symlinkSync(target,w.runtime);
 const launched=start(w);expect((await launched.run()).kind).toBe('unmanaged');expect(launched.spawned()).toBe(0);expect(readFileSync(join(target,'sentinel'),'utf8')).toBe('unchanged');expect(lstatSync(w.runtime).isSymbolicLink()).toBe(true);
});
test('a runtime folder belonging to a different user is refused without changing its metadata',async()=>{
 const w=world();mkdirSync(w.runtime,{mode:0o700});const before=lstatSync(w.runtime);const getuid=process.getuid!;const launched=start(w);
 try{process.getuid=()=>getuid()+1;expect((await launched.run()).kind).toBe('unmanaged');}finally{process.getuid=getuid;}
 expect(launched.spawned()).toBe(0);expect(lstatSync(w.runtime).mode).toBe(before.mode);expect(lstatSync(w.runtime).uid).toBe(before.uid);
});
test('an owner-record link is never followed or replaced and only the synthetic launch is stopped',async()=>{
 const w=world();mkdirSync(w.runtime,{mode:0o700});const chosen=socket(w);const target=join(w.base,'unrelated');writeFileSync(target,'unchanged');const record=join(w.runtime,basename(chosen.path,'.sock')+'.owner.json');symlinkSync(target,record);
 const launched=start(w);expect((await launched.run()).kind).toBe('unmanaged');expect(launched.terminated).toEqual([424242]);expect(readFileSync(target,'utf8')).toBe('unchanged');expect(lstatSync(record).isSymbolicLink()).toBe(true);expect(existsSync(chosen.path)).toBe(false);
});
test('a socket already alive at the selected path survives a competing launch byte-for-byte',async()=>{
 const w=world();mkdirSync(w.runtime,{mode:0o700});const chosen=socket(w);writeFileSync(chosen.path,'preexisting synthetic listener',{mode:0o600});const before=lstatSync(chosen.path);const launched=start(w,{spawn:()=>({pid:424242})});
 expect((await launched.run()).kind).toBe('unmanaged');expect(launched.terminated).toEqual([424242]);const after=lstatSync(chosen.path);expect(after.isFile()).toBe(true);expect(readFileSync(chosen.path,'utf8')).toBe('preexisting synthetic listener');expect([after.dev,after.ino,after.mode]).toEqual([before.dev,before.ino,before.mode]);
});
test('a binding change removes only the failed launch socket and owner record',async()=>{
 const w=world();mkdirSync(w.runtime,{mode:0o700});const chosen=socket(w);const unrelated=join(w.runtime,'unrelated');writeFileSync(unrelated,'retained');const launched=start(w,{now:()=>{state.updateState(w.dir,s=>{s.sessions[session]!.seats[seat]!.presence_binding='prs_abcdef012345';});return new Date('2026-11-02T00:00:00Z');}});
 expect((await launched.run()).kind).toBe('unmanaged');expect(launched.terminated).toEqual([424242]);expect(existsSync(chosen.path)).toBe(false);expect(existsSync(join(w.runtime,basename(chosen.path,'.sock')+'.owner.json'))).toBe(false);expect(readFileSync(unrelated,'utf8')).toBe('retained');
});
