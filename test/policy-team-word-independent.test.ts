// A policy address is refused at write time when its team word resolves to no registered
// team. The refusal names that word and the words that do resolve: the team id, the project
// name, and the session name. A dry run shows the same refusal and writes nothing. Synthetic
// registry only. Runs when builder-4 sends the head.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runPolicy } from '../src/commands/policy.ts';
import { entitiesPath } from '../src/entities.ts';
import { upsertTeam } from '../src/registry/teams.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T06:40:00.000Z');
const TEAM_ID = 'a1b2c3d4e5f6';
const PROJECT = 'oak';
const SESSION = 'morning';
const KNOWN = [TEAM_ID, PROJECT, SESSION];
const bases: string[] = [];

afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function world(): { home: string; root: string } {
  const base = fixtureBase('policy-team-word-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const root = join(base, 'oak');
  mkdirSync(join(root, '.agents'), { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: ${PROJECT}
entity: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    leads: true
`);
  upsertTeam(home, TEAM_ID, {
    project: PROJECT,
    session: SESSION,
    entity: 'acme',
    root,
    at: NOW.toISOString(),
    by: 'team',
  });
  return { home, root };
}

function policyBytes(home: string): string | null {
  const path = entitiesPath(home);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function setPolicy(root: string, home: string, name: string, value: string, dryRun: boolean): Promise<{ code: number | string; err: string; out: string }> {
  const io = testIo(root, { kind: 'owner' });
  const argv = ['set', 'entity', name, value, '--entity', 'acme', '--file', '.agents/team.yaml', ...(dryRun ? ['--dry-run'] : [])];
  const code = await runPolicy(argv, io, { home, now: () => NOW });
  return { code, err: io.err, out: io.out };
}

function expectRefusal(result: { code: number | string; err: string }, word: string): void {
  expect(result.code).not.toBe(0);
  expect(result.err).toContain(word);
  for (const known of KNOWN) expect(result.err).toContain(known);
}

test('an unresolved team word is refused for owner-reply and the router, and a resolving word is kept', async () => {
  const { home, root } = world();
  const before = policyBytes(home);

  for (const [name, value] of [
    ['owner-reply-to', 'keeper@cedar'],
    ['router.aliases', 'inbox=keeper@cedar'],
    ['router.fallback', 'inbox=keeper@cedar'],
  ] as const) {
    const refused = await setPolicy(root, home, name, value, false);
    expectRefusal(refused, 'cedar');
    expect(policyBytes(home)).toBe(before);
    const listed = await setPolicy(root, home, name, value, true);
    expectRefusal(listed, 'cedar');
    expect(listed.out).not.toContain('would set');
    expect(policyBytes(home)).toBe(before);
  }

  const byId = await setPolicy(root, home, 'owner-reply-to', `keeper@${TEAM_ID}`, false);
  expect(byId.code).toBe(0);
  expect(policyBytes(home)).toContain(`keeper@${TEAM_ID}`);

  const byProject = await setPolicy(root, home, 'router.aliases', `inbox=keeper@${PROJECT}`, false);
  expect(byProject.code).toBe(0);
  expect(policyBytes(home)).toContain(`keeper@${PROJECT}`);

  const bySession = await setPolicy(root, home, 'router.fallback', `inbox=keeper@${SESSION}`, false);
  expect(bySession.code).toBe(0);
  expect(policyBytes(home)).toContain(`keeper@${SESSION}`);
});
