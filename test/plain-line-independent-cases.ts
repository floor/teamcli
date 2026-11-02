// Plain-line delta only: all public readers agree and uncertain rewrites retain existing bytes.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliWordList, cliWordsOf, launchCommand, launchSessionId, namedResumeTarget, profileFor, resumeCarry, withLaunchOverrides, withLaunchSession, withResume, withoutResume } from '../src/profiles/profile.ts';
import { assertIndependentHome, releaseIndependentFixture } from './plain-line-home-fixture.ts';
const owned:string[]=[];afterEach(()=>{for(const p of owned.splice(0))releaseIndependentFixture(p);});
test('plain-line parsers run under the child HOME from startup',assertIndependentHome);
const tails=['# hidden --model decoy','; printf harmless','&& printf harmless','|| printf harmless','| cat','> fixture-output','\nprintf harmless','& printf harmless'];
for(const tail of tails)test(`all plain readers and span rewriters refuse a swallowed tail ${JSON.stringify(tail)}`,()=>{
 const line=`claude --model old --effort low --resume prior ${tail}`,p=profileFor('claude-code')!;
 const session=withLaunchSession('claude-code',line),notes:string[]=[];
 const launched=launchCommand(p,line,'synthetic rules',undefined,undefined,undefined,undefined,undefined,n=>notes.push(n));
 expect({words:cliWordList('claude-code',line),text:cliWordsOf('claude-code',line),resume:namedResumeTarget('claude-code',line),id:launchSessionId(line.replace('--resume prior','--session-id prior')),carry:resumeCarry('claude-code',line,'next').kind,added:withResume('claude-code',line,'next'),stripped:withoutResume('claude-code',line),overridden:withLaunchOverrides(p,line,{modelId:'fresh',effort:'high'})}).toEqual({words:null,text:'',resume:null,id:undefined,carry:'refuse',added:null,stripped:null,overridden:line+' --model fresh --effort high'});
 expect(session.command).toBe(line);expect(session.sessionId).toBeUndefined();expect(session.notice).toContain('cannot take a session id');expect(notes.length).toBeGreaterThan(0);expect(launched).toContain(line);
});
for(const cli of ['codex','grok'])for(const tail of tails)test(`${cli} model and effort spans keep uncertain plain words ${JSON.stringify(tail)}`,()=>{
 const p=profileFor(cli)!,line=cli==='codex'?`codex -m old -c model_reasoning_effort=low ${tail}`:`grok --model old --effort low ${tail}`;
 const addition=cli==='codex'?' -m fresh -c model_reasoning_effort=high':' --model fresh --effort high';
 expect(cliWordList(cli,line)).toBeNull();expect(cliWordsOf(cli,line)).toBe('');expect(withLaunchOverrides(p,line,{modelId:'fresh',effort:'high'})).toBe(line+addition);
});
test('unclosed plain quoting remains unreadable and only appends without changing existing text',()=>{
 const line='claude --model "old --resume prior',p=profileFor('claude-code')!;expect(cliWordList('claude-code',line)).toBeNull();expect(withoutResume('claude-code',line)).toBeNull();expect(withLaunchOverrides(p,line,{modelId:'fresh'})).toBe(line+' --model fresh');
});
for(const model of ['old # literal','old;literal','old | literal','old > literal'])test(`quoted operator text is still a proved plain argument ${model}`,()=>{
 const line=`claude --model '${model}' --effort low --resume prior`,p=profileFor('claude-code')!;expect(cliWordList('claude-code',line)).toEqual(['claude','--model',model,'--effort','low','--resume','prior']);expect(namedResumeTarget('claude-code',line)).toBe('prior');expect(withoutResume('claude-code',line)).toBe(`claude --model '${model}' --effort low`);expect(withLaunchOverrides(p,line,{modelId:'fresh',effort:'high'})).toBe('claude --model fresh --effort high --resume prior');expect(withResume('claude-code',line,'different')).toBeNull();
});
test('attached and quoted flag names on a proved line still rewrite the actual CLI arguments',()=>{
 const p=profileFor('claude-code')!,line=`claude "--model" old --effort=low --resume=prior`;expect(withoutResume('claude-code',line)).toBe('claude "--model" old --effort=low');expect(withLaunchOverrides(p,line,{modelId:'fresh',effort:'high'})).toBe('claude "--model" fresh --effort=high --resume=prior');
});
function argv(line:string){const base=realpathSync(mkdtempSync(join(tmpdir(),'plain-line-independent-')));owned.push(base);const bin=join(base,'bin'),file=join(base,'argv');mkdirSync(bin);const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";writeFileSync(join(bin,'claude'),`#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(file)}\n`,{mode:0o755});const r=spawnSync('/bin/sh',['-c',line],{cwd:base,env:{HOME:process.env.HOME,PATH:bin+':/usr/bin:/bin'},encoding:'utf8'});expect(r.status,r.stderr).toBe(0);return readFileSync(file,'utf8').trimEnd().split('\n');}
test('a model override before a comment leaves the fake CLI original arguments intact',()=>{
 const line='claude --model old # retain this comment',next=withLaunchOverrides(profileFor('claude-code')!,line,{modelId:'fresh'});expect(argv(next)).toEqual(['--model','old']);expect(next).toBe(line+' --model fresh');
});
test('a refused resume strip does not remove arguments actually received before a comment',()=>{
 const line='claude --model old --resume prior # retain this comment',stripped=withoutResume('claude-code',line);expect(argv(stripped??line)).toEqual(['--model','old','--resume','prior']);expect(stripped).toBeNull();
});
