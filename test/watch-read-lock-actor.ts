// A synthetic second command or hosted watch, always started with its own HOME.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spyOn } from 'bun:test';
import type { WatchSources } from '../src/commands/watch.ts';
const [mode,worldFile]=process.argv.slice(2),w=JSON.parse(readFileSync(worldFile!,'utf8')) as {root:string;home:string;dir:string;barrier:string};
const path=(name:string)=>join(w.barrier,name),write=(name:string,value:unknown=true)=>writeFileSync(path(name),JSON.stringify(value));
function wait(name:string){const end=Date.now()+10000;while(!existsSync(path(name))){if(Date.now()>end)throw new Error('fixture barrier timeout: '+name);Bun.sleepSync(5);}}
const forbidden:unknown[][]=[];
process.kill=((pid:number,signal?:NodeJS.Signals|number)=>{const allowed=existsSync(path('pids'))?JSON.parse(readFileSync(path('pids'),'utf8')) as number[]:[];if(signal===0&&(pid===process.pid||allowed.includes(pid)))return true;forbidden.push([pid,signal]);throw new Error('real signal forbidden');}) as typeof process.kill;
const home=realpathSync(process.env.HOME!),proof={pid:process.pid,parent:process.ppid,home,osHome:realpathSync(homedir()),mode:statSync(home).mode&0o777,uid:statSync(home).uid};
if(proof.home!==proof.osHome||proof.home===w.home||proof.mode!==0o700||proof.uid!==process.getuid?.())throw new Error('actor HOME is not isolated before imports');
write(mode+'-ready',proof);wait('go');
let result:Record<string,unknown>={proof,forbidden};
try{
 const state=await import('../src/state.ts');
 if(mode==='command'){
  wait('scan-entered');
  try{state.updateState(w.dir,s=>{s.pause={by:'fixture-command',at:'2026-11-02T09:00:00.000Z',reason:'concurrent marker',stops:[]};},{waitMs:0});result.took=true;}catch(e){result.took=false;result.error=(e as Error).name;}
  write('command-done',result);
 }else{
  const readings=await import('../src/budgets/readings.ts'),watch=await import('../src/commands/watch.ts'),status=await import('../src/commands/status.ts'),helpers=await import('./helpers.ts');
  const original=readings.updateReadings,observed:unknown[]=[];
  const replacement:typeof original=(dir,now,fold)=>{
   write(mode+'-fold-attempt');return original(dir,now,stored=>{
    write(mode+'-fold-entered');observed.push(stored.map(x=>[x.account,x.window,x.left]));
    if(mode==='first'){wait('second-fold-attempt');Bun.sleepSync(80);result.overlapped=existsSync(path('second-fold-entered'));result.lockHeld=readFileSync(join(w.dir,'team.lock'),'utf8').trim()===String(process.pid);}
    return fold(stored);
   });
  };
  const hooked=spyOn(readings,'updateReadings').mockImplementation(replacement),now=new Date('2026-11-02T09:00:00.000Z'),controller=new AbortController();let cycles=0;
  const reject=(..._args:unknown[]):never=>{throw new Error('unexpected host effect');};
  const source:WatchSources={home:w.home,pid:process.pid,alive:()=>false,live:()=>({running:true,agents:[],workspaces:[],screens:{}}),machine:()=>({loadPerCore:0.1,memoryFree:80,diskFree:1024**4,swapTotal:1024**3,swapFree:1024**3,swapUsed:0}),standing:status.standingSource(w.home),readChecks:()=>{
   write(mode+'-checks');if(mode==='first')wait('second-checks');else wait('first-fold-entered');return[{account:'openai',state:'read',reading:{kind:'subscription',windows:[{window:mode==='first'?'weekly':'daily',left:mode==='first'?61:72,used:mode==='first'?39:28,at:now.getTime(),resetsAt:null}]}}];
  },screen:reject,status:reject,foreground:reject,processes:reject,typeText:reject,pressEnter:reject,sendKey:reject,sleep:async()=>{},notify:()=>{},now:()=>now,wait:async()=>false,hosted:{signal:controller.signal,wait:async()=>false,cycled:()=>{cycles++;},standby:reject}};
  const io=helpers.testIo(w.root,{kind:'owner-no-tty'});result.code=await watch.runWatch([],io,source);result.cycles=cycles;result.observed=observed;result.err=io.err;hooked.mockRestore();
 }
}catch(e){result.error=(e as Error).stack;}
write(mode+'-result',result);
if(result.error||forbidden.length||result.code!==undefined&&result.code!==0)process.exitCode=1;
