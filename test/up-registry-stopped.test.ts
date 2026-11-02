// `remove --keep` on a team whose definition lives in the registry writes the sign-off into the
// registry's record and leaves the file the team was launched from as it was. `team up` reads the
// team the registry holds, so a signed-off seat is left out of its plan — never launched from the
// stale file beside it. Synthetic throughout: a temp home's registry, a temp checkout, a dry run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { runUp } from '../src/commands/up.ts';
import { markStopped } from '../src/file/lines.ts';
import { readTeamText, writeTeamText } from '../src/file/team-text.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { gitEnv, testIo } from './helpers.ts';
import { intoRegistry, underRegistry } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-16T02:00:00Z');

// A lead and a worker: the lead starts the session, the worker is the seat the sign-off parks.
const TEAM = (extra = ''): string => `format: 1
project: docs
entity: floor
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra}`;

const WORKER = `
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout whose team is in the scene's own registry, with its file left beside the record. */
function scene(): { home: string; root: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-stopped-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'docs');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM(WORKER));
  upsertTeam(home, teamIdOf(root), {
    project: 'docs',
    entity: 'floor',
    session: 'docs',
    root,
    lifecycle: 'running',
    roster: [{ agent: 'agt_crew000000', seat: 'lead', role: 'coordinator', leads: true }],
    by: 'owner',
    at: NOW.toISOString(),
  });
  intoRegistry(root, home);
  return { home, root, file };
}

test('a signed-off seat is left out of a registry team\'s up plan, over the stale file beside it', async () => {
  const { home, root, file } = scene();
  await underRegistry(async () => {
    // What `remove worker --keep` writes: the mark, in the registry's record, through the seam.
    expect(writeTeamText(file, markStopped(readTeamText(file, { home }), 'worker'), { home, command: 'remove' }))
      .toEqual({ ok: true, target: 'registry' });
    const io = testIo(root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runUp(['--dry-run'], io, { home, sessionRunning: () => false, agents: () => [], now: () => NOW });
    expect(code).toBe(0);
    // The plan starts the session for the seats that can run, and names the parked one with the
    // command that takes the sign-off off: no launch is planned for it.
    expect(io.out).toContain('herdr --session docs');
    expect(io.out).toContain('worker: stopped in the file; start it with `team add worker`');
  });
});

test('a signed-off seat stays out of the plan with dev mode unset: restart is the single-seat path', async () => {
  // `team restart` reviving a stopped seat is that command's own path; `up` still plans nothing
  // for a seat the file stops, dev mode on or off.
  const { home, root, file } = scene();
  await underRegistry(async () => {
    expect(writeTeamText(file, markStopped(readTeamText(file, { home }), 'worker'), { home, command: 'remove' }))
      .toEqual({ ok: true, target: 'registry' });
    const io = testIo(root, { kind: 'owner' });
    expect(io.env.TEAMCLI_DEV_MODE).toBeUndefined();
    const code = await runUp(['--dry-run'], io, { home, sessionRunning: () => false, agents: () => [], now: () => NOW });
    expect(code).toBe(0);
    expect(io.out).toContain('worker: stopped in the file; start it with `team add worker`');
    // The plan creates the lead's workspace and the watch's; the stopped worker's is absent.
    expect(io.out).toContain(`--label 'lead · coordinator'`);
    expect(io.out).not.toContain(`--label 'worker`);
  });
});
