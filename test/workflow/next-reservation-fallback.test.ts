// The `team next` compatibility control for the workflow MVP's reservation boundary.
//
// Written from the committed behaviour at int/0.5.5 b33084d70, not from the reservation slice:
// with no store injected, a claim must write exactly the local lease and print exactly the line
// a clone with no run store prints, and a release must remove exactly that lease. This is the
// scene that shows the new exclusion boundary is opt-in at the command: a default store write
// would appear under HOME or add a file in the checkout, and this test names both.
//
// The fixture is synthetic: a scratch project, its two seats recorded in the state file, one
// file-source task. Nothing here touches a real team, a daemon, or a run store root.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runNext } from '../../src/commands/next.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { LEASE_MS } from '../../src/tasks/lease.ts';
import { gitEnv, testIo } from '../helpers.ts';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const LIST = '- id: m1\n  title: the task title\n';

const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const CTX = 'team acme, session "acme"\n';

let base: string;
let root: string;
let home: string;
const now = Date.parse('2026-10-08T09:00:00.000Z');

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function ready(): void {
  base = mkdtempSync(join(tmpdir(), 'team-next-reservation-fallback-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), LIST);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(rel));
    else found.push(rel);
  }
  return found.sort();
}

function stateBytes(): string {
  return readFileSync(join(root, '.agents', 'team.state.json'), 'utf8');
}

describe('team next with no reservation store injected', () => {
  test('a claim writes exactly the local lease and keeps the committed answer', async () => {
    ready();
    const homeBefore = filesUnder(home);
    const rootBefore = filesUnder(root);
    const stateBefore = stateBytes();

    const io = testIo(root, lead);
    const code = await runNext([], io, { home, now: () => now });

    expect(code).toBe(0);
    expect(io.out).toBe(`${CTX}m1  the task title\nteam next: claimed m1\n`);
    expect(io.err).toBe('');
    expect(filesUnder(home)).toEqual(homeBefore);
    const rootAfter = filesUnder(root);
    expect(rootAfter.filter((path) => !rootBefore.includes(path))).toEqual([join(root, '.agents', 'leases', 'm1.json')]);
    expect(rootAfter.filter((path) => rootBefore.includes(path))).toEqual(rootBefore);
    expect(stateBytes()).toBe(stateBefore);

    const lease = JSON.parse(readFileSync(join(root, '.agents', 'leases', 'm1.json'), 'utf8')) as Record<string, unknown>;
    expect(lease).toMatchObject({ format: 1, id: 'm1', seat: 'lead', pane: 'w1:p1' });
    expect(Date.parse(String(lease.until))).toBe(now + LEASE_MS);
  });

  test('a release removes exactly the lease and writes no store file', async () => {
    ready();
    const claim = testIo(root, lead);
    expect(await runNext([], claim, { home, now: () => now })).toBe(0);
    const rootBefore = filesUnder(root);
    const homeBefore = filesUnder(home);
    const stateBefore = stateBytes();

    const io = testIo(root, lead);
    const code = await runNext(['--release'], io, { home, now: () => now });

    expect(code).toBe(0);
    expect(io.out).toBe(`${CTX}team next: released m1\n`);
    expect(io.err).toBe('');
    expect(filesUnder(home)).toEqual(homeBefore);
    expect(rootBefore.filter((path) => !filesUnder(root).includes(path))).toEqual([
      join(root, '.agents', 'leases', 'm1.json'),
    ]);
    expect(stateBytes()).toBe(stateBefore);
  });
});
