// A dry run of the launcher migration. The temp check resolves the script and the temp
// root before it compares them, so a script reached through a symlinked temp directory
// stays in the plan. A script whose path sits under that link but whose real path is
// outside it is left out. The dry run writes nothing. Homes and scripts are synthetic.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runLaunchers } from '../src/commands/launchers.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, testIo } from './helpers.ts';

const MARKER = '# synthetic\n';
const owned: string[] = [];
let savedTemp: string | undefined;
let tempHeld = false;

afterEach(() => {
  if (tempHeld) {
    if (savedTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTemp;
    tempHeld = false;
  }
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

test('a script under a symlinked temp directory stays in the dry-run plan, and a script whose real path is outside it is left out', async () => {
  const base = fixtureBase('.launchers-symlink-temp-');
  owned.push(base);
  const home = join(base, 'home');
  const root = join(base, 'crate');
  const realTemp = join(base, 'real-temp');
  const linkedTemp = join(base, 'linked-temp');
  const outside = join(base, 'outside');
  const lobby = lobbyDir(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  mkdirSync(realTemp);
  symlinkSync(realTemp, linkedTemp);
  mkdirSync(outside);
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  const kept = join(linkedTemp, 'claude-glm.sh');
  const left = join(linkedTemp, 'claude-kimi.sh');
  writeFileSync(join(realTemp, 'claude-glm.sh'), MARKER);
  writeFileSync(join(outside, 'claude-kimi.sh'), MARKER);
  symlinkSync(join(outside, 'claude-kimi.sh'), left);
  const teamFile = join(root, '.agents', 'team.yaml');
  const text = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - ${JSON.stringify(root)}
  - ${JSON.stringify(lobby)}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: pebble
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: ${JSON.stringify(kept)}
    mode: shared
  - role: implementer
    name: cobble
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: ${JSON.stringify(left)}
    mode: shared
`;
  const parsed = validateTeamFile(text, { root, home });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  writeFileSync(teamFile, text);
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, at: '2026-11-09T09:00:00.000Z' });
  savedTemp = process.env.TMPDIR;
  tempHeld = true;
  process.env.TMPDIR = linkedTemp;
  const io = testIo(root, { kind: 'owner' });
  const code = await runLaunchers(['migrate', '--dry-run', '--json'], io, home);
  expect(code, `${io.out}\n${io.err}`).toBe(0);
  const doc = JSON.parse(io.out) as { dry_run: boolean; rows: { kind: string; seat: string; launcher?: string; from?: string }[] };
  expect(doc.dry_run).toBe(true);
  expect(doc.rows).toHaveLength(1);
  expect(doc.rows[0]).toMatchObject({ kind: 'change', seat: 'pebble', launcher: 'claude-glm', from: kept });
  expect(io.out.includes('cobble')).toBe(false);
  expect(io.out.includes('claude-kimi')).toBe(false);
  expect(readFileSync(teamFile, 'utf8')).toBe(text);
});
