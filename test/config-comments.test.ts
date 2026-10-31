// `team config set` and `unset` edit the record's text: only the lines of the key they change
// are rewritten, and every comment the record carries — above the key, beside it, below it, and
// on a value the change removes — stays byte for byte. A record whose shape a line edit cannot
// reach is rewritten whole, and the command says so. Hermetic: a temporary HOME and project root,
// the file source, never ~/.config/team.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { editedRecordText } from '../src/config/team-record.ts';
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

// A list with one item and a comment beside it: an unset of its last item empties the section
// in place, and the comment stays where the item was.
const ONE_RULE = TEAM.replace('workspace:\n  mode: shared\n', 'workspace:\n  mode: shared\nrules:\n  - a rule # rule comment\n');

// The same list on one line: an item of it cannot be changed line by line.
const FLOW_RULES = TEAM.replace('workspace:\n  mode: shared\n', 'workspace:\n  mode: shared\nrules: [alpha, beta]\n');

type Place = { home: string; root: string; file: string };
function place(text = TEAM): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-comments-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, text);
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

test('an unset of a list\'s last item leaves [] in place and keeps every comment', async () => {
  const at = place(ONE_RULE);
  const ran = await config(at, ['unset', 'rules.0']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(readFileSync(at.file, 'utf8')).toBe(ONE_RULE.replace('rules:\n  - a rule # rule comment\n', 'rules: []\n  # rule comment\n'));
});

test('an unset keeps the comment beside the removed key, as a line where the key was', async () => {
  const at = place();
  const ran = await config(at, ['unset', 'watch.unread_after']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(readFileSync(at.file, 'utf8')).toBe(TEAM.replace('  unread_after: 30m # Beside the changed key.\n', '  # Beside the changed key.\n'));
});

test('a set that replaces a whole section keeps the comments written inside it', async () => {
  const at = place();
  const ran = await config(at, ['set', 'watch', '{interval: 20s, unread_after: 30m, nudge_wait: 5m}']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  const section = 'watch:\n  # Above the changed key.\n  interval: 10s\n  unread_after: 30m # Beside the changed key.\n  # Below the changed key.\n  nudge_wait: 5m\n';
  const replaced = 'watch:\n  interval: 20s\n  unread_after: 30m\n  nudge_wait: 5m\n  # Above the changed key.\n  # Beside the changed key.\n  # Below the changed key.\n';
  expect(readFileSync(at.file, 'utf8')).toBe(TEAM.replace(section, replaced));
});

test('a change of a one-line list is still a line edit and keeps every comment', async () => {
  const at = place(FLOW_RULES);
  const ran = await config(at, ['set', 'rules.0', 'gamma']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(readFileSync(at.file, 'utf8')).toBe(FLOW_RULES.replace('rules: [alpha, beta]\n', 'rules:\n  - gamma\n  - beta\n'));
});

test('the editor says when it cannot keep the record and returns the regenerated text', () => {
  // A text that is not a map is a shape the line editor cannot address: the metadata says the
  // record was regenerated, and the text is the regenerated one, comments and all.
  const before = '# a comment\n- alpha\n- beta\n';
  const after = editedRecordText(before, ['0'], 'gamma', ['gamma', 'beta']);
  expect(after.kept).toBe(false);
  expect(after.text).toBe('- gamma\n- beta\n');
});
