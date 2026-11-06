// A machine with no trash binary parks a retired file in the dated runtime trash. The seam
// injects that absence: the scene never spawns a trash command, and the file is renamed, not deleted.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireTeamFile } from '../src/file/retire.ts';
import { runtimeTrashFolder } from '../src/file/runtime-trash.ts';

const NOW = new Date('2026-11-06T08:00:00.000Z');

test('no trash binary parks the file in the dated runtime trash and says how to empty it', () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-trash-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'runtime-trash-src-'));
  const file = join(dir, 'team.yaml');
  writeFileSync(file, 'kept\n');
  const retired = retireTeamFile(file, { home, now: NOW, trashCommand: null });
  const dated = runtimeTrashFolder(home, NOW);
  expect(retired.how).toBe('parked');
  expect(retired.to).toBe(join(dated, 'team.yaml'));
  expect(retired.empty).toBe(`empty it by removing the dated folder ${dated}`);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(retired.to, 'utf8')).toBe('kept\n');
});

test('a trash command that cannot be started parks the same way, and a second file keeps both', () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-trash-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'runtime-trash-src-'));
  mkdirSync(join(dir, 'pair'), { recursive: true });
  const first = join(dir, 'pair', 'note.txt');
  const second = join(dir, 'note.txt');
  writeFileSync(first, 'one\n');
  writeFileSync(second, 'two\n');
  const missing: [string, string[]] = ['/nonexistent/team-trash-bin', []];
  const parked = retireTeamFile(first, { home, now: NOW, trashCommand: missing });
  const again = retireTeamFile(second, { home, now: NOW, trashCommand: null });
  expect(parked.how).toBe('parked');
  expect(again.to).toBe(join(runtimeTrashFolder(home, NOW), 'note.txt-2'));
  expect(readFileSync(parked.to, 'utf8')).toBe('one\n');
  expect(readFileSync(again.to, 'utf8')).toBe('two\n');
});
