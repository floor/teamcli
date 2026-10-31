// `team config set` and `team config unset` on a record a person wrote by hand: the comments
// around a key stay byte for byte, whether they sit above it, beside it, below it or between
// keys; a key nested in a section or in a seat's list item is reached the same way; and where a
// line edit cannot keep a comment the command rewrites the record whole and says so. Hermetic: a
// temporary HOME and project root, the file source, never ~/.config/team.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { testIo } from './helpers.ts';
import { realRegistryTouched } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-26T09:00:00.000Z');

const SEATS = `# Between the sections.
seats:
  # The coordinator.
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus # Beside the model.
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

// A record whose comments sit above a key, below it, and between whole sections.
const RECORD = `# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
${SEATS}`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(realRegistryTouched()).toBe(false);
});

type Place = { home: string; root: string; file: string };
function place(text: string): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-comments-independent-')));
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
  const code = await runConfig([...argv, '--json'], io, { home: at.home, env, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

function jsonOf(out: string): Record<string, unknown> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`expected one json object on stdout, got: ${JSON.stringify(out)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`expected one json object on stdout, got: ${JSON.stringify(out)}`);
  }
  return parsed as Record<string, unknown>;
}

test('a set keeps the comments above the key, below the format and between the top keys', async () => {
  const at = place(`# The team's record.
# Below the format.
format: 1
project: acme
# Between the top keys.
coordinator: lead
operator: lead
workspace:
  # Above the mode.
  mode: shared
${SEATS}`);
  const ran = await config(at, ['set', 'project', 'beta']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
# Below the format.
format: 1
project: beta
# Between the top keys.
coordinator: lead
operator: lead
workspace:
  # Above the mode.
  mode: shared
${SEATS}`);
});

test('a set on a seat key keeps the comments around it, beside it and below it', async () => {
  const at = place(RECORD);
  const ran = await config(at, ['set', 'seats.lead.model', 'Claude Sonnet']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Between the sections.
seats:
  # The coordinator.
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet # Beside the model.
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
});

test('an unset of a seat key leaves the comment beside it as its own line, where the key was', async () => {
  const at = place(RECORD.replace('label: lead\n', 'label: lead # Beside label.\n'));
  const ran = await config(at, ['unset', 'seats.lead.label']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Between the sections.
seats:
  # The coordinator.
  - role: coordinator
    name: lead
    # Beside label.
    cli: claude-code
    vendor: anthropic
    model: Claude Opus # Beside the model.
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
});

test('a set inside a section keeps every comment of the section, above, between and below its keys', async () => {
  const at = place(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Above watch.
watch:
  # Above interval.
  interval: 10s # Beside interval.
  # Between the keys.
  unread_after: 30m
  # Below the keys.
${SEATS}`);
  const ran = await config(at, ['set', 'watch.unread_after', '5m']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Above watch.
watch:
  # Above interval.
  interval: 10s # Beside interval.
  # Between the keys.
  unread_after: 5m
  # Below the keys.
${SEATS}`);
});

test('a set adds a key to a commented section and keeps the comment that sat below the last key', async () => {
  const at = place(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Above watch.
watch:
  # Above interval.
  interval: 10s # Beside interval.
  # Below interval.
${SEATS}`);
  const ran = await config(at, ['set', 'watch.team_idle', '2m']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Above watch.
watch:
  # Above interval.
  interval: 10s # Beside interval.
  team_idle: 2m
  # Below interval.
${SEATS}`);
});

test('an unset of the only item of a commented list empties it in place and keeps the comment', async () => {
  const at = place(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
rules:
  - a rule # rule comment
${SEATS}`);
  const ran = await config(at, ['unset', 'rules.0']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
rules: []
  # rule comment
${SEATS}`);
});

test('an unset of a commented item from a list of two rewrites the record whole and says so', async () => {
  const at = place(RECORD.replace('  mode: shared\n', '  mode: shared\nrules:\n  - alpha # first rule\n  - beta\n'));
  const ran = await config(at, ['unset', 'rules.0']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(jsonOf(ran.out).comments_kept).toBe(false);
  expect(ran.err).toBe('team config: the record was rewritten whole to change rules.0; its comments were not kept\n');
  expect(readFileSync(at.file, 'utf8')).toBe(`format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
rules:
  - beta
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
});

test('the same fallback reaches the last item of a list as well as the first', async () => {
  const at = place(RECORD.replace('  mode: shared\n', '  mode: shared\nrules:\n  - alpha\n  - beta # last rule\n'));
  const ran = await config(at, ['unset', 'rules.1']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(jsonOf(ran.out).comments_kept).toBe(false);
  expect(ran.err).toBe('team config: the record was rewritten whole to change rules.1; its comments were not kept\n');
  expect(readFileSync(at.file, 'utf8')).toBe(`format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
rules:
  - alpha
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
});

test('the list fallback is taken only when a comment would be lost: a bare item is removed line by line', async () => {
  const at = place(RECORD.replace('  mode: shared\n', '  mode: shared\nrules:\n  - alpha\n  - beta\n'));
  const ran = await config(at, ['unset', 'rules.0']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
rules:
  - beta
${SEATS}`);
});

test('an unset of the only key of a commented section leaves the comments where they were', async () => {
  const at = place(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Above watch.
watch:
  # Inner note.
  interval: 10s # Beside.
  # Below interval.
${SEATS}`);
  const ran = await config(at, ['unset', 'watch.interval']);
  expect(ran.code, ran.err + ran.out).toBe(0);
  expect(ran.err).toBe('');
  expect(jsonOf(ran.out).comments_kept).toBe(true);
  expect(readFileSync(at.file, 'utf8')).toBe(`# The team's record.
format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
# Above watch.
watch: {}
  # Inner note.
  # Beside.
  # Below interval.
${SEATS}`);
});
