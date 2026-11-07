import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerInbox } from '../src/mcp/register.ts';
const team = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-write-four-'))); dirs.push(base);
  const root = join(base, 'repo'); mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents', 'team.yaml'); writeFileSync(file, team);
  return { base, root, file };
}
function planted(base: string, path: string, dangling: boolean) {
  const outside = join(base, 'outside'); if (!dangling) writeFileSync(outside, 'unchanged'); symlinkSync(outside, path);
  return () => {
    expect(existsSync(outside)).toBe(!dangling);
    if (!dangling) expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  };
}
for (const dangling of [false, true]) {
  test(`A10 config leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); mkdirSync(join(at.root, '.cursor'));
    const path = join(at.root, '.cursor', 'mcp.json');
    const unchanged = planted(at.base, `${path}.team-tmp`, dangling);
    const result = registerInbox({ cli: 'cursor', seat: 'helper', cwd: at.root, file: at.file });
    unchanged(); expect(result).toEqual({ ok: true }); expect(lstatSync(path).isFile()).toBe(true);
  });
  test(`A11 exclude refuses a planted leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); execFileSync('git', ['init', '-q'], { cwd: at.root });
    const path = join(at.root, '.git', 'info', 'exclude'); rmSync(path);
    const unchanged = planted(at.base, path, dangling);
    const result = registerInbox({ cli: 'cursor', seat: 'helper', cwd: at.root, file: at.file });
    unchanged(); expect(result?.ok).toBe(false); expect(existsSync(join(at.root, '.cursor', 'mcp.json'))).toBe(false);
  });
}

for (const dangling of [false, true]) {
  test(`A10 config refuses a planted final leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); mkdirSync(join(at.root, '.cursor')); const path = join(at.root, '.cursor', 'mcp.json');
    const unchanged = planted(at.base, path, dangling);
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: at.root, file: at.file })?.ok).toBe(false); unchanged();
  });
}
