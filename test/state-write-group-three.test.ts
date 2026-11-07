import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logLine } from '../src/log.ts';
import { appendJournal, writeAtomicMode } from '../src/workflow/live/journal.ts';
import type { LiveRecord } from '../src/workflow/live/records.ts';
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-write-three-'))); dirs.push(base);
  const folder = join(base, 'state'); mkdirSync(folder); return { base, folder };
}
function planted(base: string, path: string, dangling: boolean) {
  const outside = join(base, 'outside'); if (!dangling) writeFileSync(outside, 'unchanged'); symlinkSync(outside, path);
  return () => {
    expect(existsSync(outside)).toBe(!dangling);
    if (!dangling) expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  };
}
const record: LiveRecord = { format: 1, kind: 'workflow-run-live', authoritative: true, seq: 1,
  at: '2026-11-07T00:00:00.000Z', record: 'outcome', outcome: 'done' };
for (const dangling of [false, true]) {
  test(`A9 log refuses a planted leaf and reports once (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const unchanged = planted(at.base, join(at.folder, 'team.log'), dangling);
    const say = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logLine(at.folder, 'check', 'owner', 'synthetic'); logLine(at.folder, 'check', 'owner', 'synthetic');
      unchanged(); expect(say).toHaveBeenCalledTimes(1); expect(String(say.mock.calls[0]?.[0])).toContain('log');
    } finally { say.mockRestore(); }
  });
  test(`A13 journal append refuses a planted leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const path = join(at.folder, 'run.jsonl'); const unchanged = planted(at.base, path, dangling);
    let refused = false; try { appendJournal(path, record); } catch { refused = true; }
    unchanged(); expect(refused).toBe(true);
  });
  test(`A13 index leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const path = join(at.folder, 'index.json');
    const unchanged = planted(at.base, `${path}.${process.pid}.tmp`, dangling);
    writeAtomicMode(path, '{"format":1}\n'); unchanged(); expect(lstatSync(path).isFile()).toBe(true);
  });
}

for (const dangling of [false, true]) {
  test(`A13 index refuses a planted final leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const path = join(at.folder, 'index.json'); const unchanged = planted(at.base, path, dangling);
    expect(() => writeAtomicMode(path, '{"format":1}\n')).toThrow(); unchanged();
  });
}
test('journal append preserves complete prior lines and refuses a hard-linked file', () => {
  const at = fixture(); const path = join(at.folder, 'run.jsonl');
  appendJournal(path, record); const first = readFileSync(path, 'utf8');
  appendJournal(path, { ...record, seq: 2 });
  const lines = readFileSync(path, 'utf8'); expect(lines.startsWith(first)).toBe(true);
  expect(lines.trimEnd().split('\n').map(line => JSON.parse(line).seq)).toEqual([1, 2]);
  const outside = join(at.base, 'outside'); writeFileSync(outside, 'unchanged');
  const hard = join(at.folder, 'hard.jsonl'); linkSync(outside, hard);
  expect(() => appendJournal(hard, record)).toThrow(); expect(readFileSync(outside, 'utf8')).toBe('unchanged');
});
