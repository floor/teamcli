// `team config set` and `unset` edit the record's text: only the lines of the key they change
// are rewritten, and every comment the record carries — above the key, beside it, below it, and
// between sections — stays byte for byte. Hermetic: a temporary HOME and project root, the file
// source, never ~/.config/team.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { testIo } from './helpers.ts';
import { realRegistryTouched } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-26T09:00:00.000Z');
const TEAM = `# The team's record.
# Every comment here is the owner's note.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Above the watch section.
watch:
  # Above the changed key.
  interval: 10s
  unread_after: 30m # Beside the changed key.
  # Below the changed key.
  nudge_wait: 5m
  # The watch section ends here.
# Below the watch section.
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(realRegistryTouched()).toBe(false);
});

type Place = { home: string; root: string; file: string };
function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-comments-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM);
  return { home, root, file };
}

async function config(at: Place, argv: string[]) {
  const io = testIo(at.root, { kind: 'owner' });
  const env = { ...process.env, TEAM_CONFIG_SOURCE: 'file' };
  const code = await runConfig(argv, io, { home: at.home, env, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

test('a set changes its value line and keeps every comment byte for byte', async () => {
  const at = place();
  const ran = await config(at, ['set', 'watch.unread_after', '5m']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(readFileSync(at.file, 'utf8')).toBe(TEAM.replace('unread_after: 30m # Beside the changed key.', 'unread_after: 5m # Beside the changed key.'));
});

test('a set that adds a key keeps the comments around it', async () => {
  const at = place();
  const ran = await config(at, ['set', 'watch.team_idle', '2m']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(readFileSync(at.file, 'utf8')).toBe(TEAM.replace('  nudge_wait: 5m\n', '  nudge_wait: 5m\n  team_idle: 2m\n'));
});

test('an unset removes its key line and keeps the comments beside it', async () => {
  const at = place();
  const ran = await config(at, ['unset', 'watch.nudge_wait']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(readFileSync(at.file, 'utf8')).toBe(TEAM.replace('  nudge_wait: 5m\n', ''));
});
