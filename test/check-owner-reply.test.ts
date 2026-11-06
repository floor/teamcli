// `team check` names an entity that has a lead and no live signed owner-reply endpoint.
// The line says what is missing and the dry-run that declares it. A live declaration,
// a team that names no entity, and an unreadable value draw no such line.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { installKey } from '../src/store/keys.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
const KEY = join(import.meta.dir, 'fixtures', 'key.json');

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function teamText(root: string, lobby: string, entity: string | null): string {
  return `format: 1
project: acme
${entity === null ? '' : `entity: ${entity}\n`}coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: orchestrator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;
}

function place(entity: string | null): { root: string; home: string; text: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-owner-reply-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  installKey(home, JSON.parse(readFileSync(KEY, 'utf8')));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const lobby = entity === null ? join(home, 'lobby') : resolveLobby(home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = teamText(root, lobby, entity);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  writeFileSync(join(root, '.agents/team.yaml'), text);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    parsed.team.seats.forEach((seat, index) => {
      session.seats[seat.name] = { stage: 'ready', pane: `pane${index + 1}`, workspace: `space${index + 1}` };
    });
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.team.session,
    seats: parsed.team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });
  return { root, home, text };
}

function liveOf(text: string): Live {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat, index) => ({
      name: seat.name,
      agent: 'claude',
      pane: `pane${index + 1}`,
      workspace: `space${index + 1}`,
      status: 'idle',
      cwd: null,
      displayAgent: displayAgent(seat),
    })),
    workspaces: parsed.team.seats.map((seat, index) => ({ id: `space${index + 1}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.team.seats.map((_, index) => [`pane${index + 1}`, CLAUDE_IDLE])),
  };
}

function check(root: string, home: string, text: string, now: Date = NOW): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    home,
    live: () => liveOf(text),
    branch: () => 'main',
    standing: () => ({ kind: 'none' }),
    now: () => now,
  });
  return { code, out: `${io.out}${io.err}` };
}

function declare(home: string, entity: string, value: string, expiry?: string): void {
  const wrote = writePolicySet(
    home,
    { level: 'entity', target: entity, name: 'owner-reply-to', value, ...(expiry === undefined ? {} : { expiry }) },
    { now: NOW },
  );
  if (!wrote.ok) throw new Error(wrote.why);
}

const REPAIR = 'team policy set entity owner-reply-to lead@acme --entity lab --dry-run';

describe('team check names a missing owner-reply endpoint', () => {
  test('an entity with a lead and no declaration prints the dry-run', () => {
    const { root, home, text } = place('lab');
    const report = check(root, home, text);
    expect(report.out).toContain('difference: entity "lab" declares no owner-reply-to policy');
    expect(report.out).toContain(`repair: ${REPAIR}`);
    expect(report.out).toContain('who: the owner');
    expect(report.code).toBe(1);
  });

  test('a live signed declaration draws no such line', () => {
    const { root, home, text } = place('lab');
    declare(home, 'lab', 'lead@acme');
    const report = check(root, home, text);
    expect(report.out).not.toContain('owner-reply-to');
    expect(report.out).not.toContain(REPAIR);
  });

  test('an expired declaration is named the same way', () => {
    const { root, home, text } = place('lab');
    declare(home, 'lab', 'lead@acme', new Date(NOW.getTime() + 1_000).toISOString());
    const report = check(root, home, text, new Date(NOW.getTime() + 60_000));
    expect(report.out).toContain('difference: entity "lab" declares no live owner-reply-to: its only declaration expired');
    expect(report.out).toContain(`repair: ${REPAIR}`);
    expect(report.code).toBe(1);
  });

  test('a team that names no entity draws no such line', () => {
    const { root, home, text } = place(null);
    const report = check(root, home, text);
    expect(report.out).not.toContain('owner-reply-to');
  });
});
