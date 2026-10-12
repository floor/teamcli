import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { NOT_A_REPO } from '../src/file/load.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-12T20:00:00Z');

const sources: StatusSources = {
  live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
  branch: () => null,
  standing: () => ({ kind: 'none' }),
  now: () => NOW,
};

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function plainProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-status-plain-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents', 'team.yaml'), example);
  return dir;
}

test('a plain folder finds its team file with no flag', async () => {
  const dir = plainProject();
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus([], io, { ...sources, home: dir });
  expect(io.err).not.toContain(NOT_A_REPO);
  expect(io.out).toContain('team acme-web, session "acme-web"');
  expect(code).not.toBe(2);
});

test('a seat of that folder finds the same file with no flag', async () => {
  const dir = plainProject();
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats['claude-coordinator-acme'] = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
  });
  const io = testIo(dir, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: 'acme-web' });
  const code = await runStatus([], io, { ...sources, home: dir });
  expect(io.err).not.toContain(NOT_A_REPO);
  expect(io.out).toContain('team acme-web, session "acme-web"');
  expect(code).not.toBe(2);
});

test('a child of a plain folder does not read the parent file', async () => {
  const dir = plainProject();
  const child = join(dir, 'child');
  mkdirSync(child);
  const io = testIo(child, { kind: 'owner' });
  const code = await runStatus([], io, { ...sources, home: dir });
  expect(code).toBe(2);
  expect(io.err).toContain(NOT_A_REPO);
  expect(io.out).toBe('');
});
