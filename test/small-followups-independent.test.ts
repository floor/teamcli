// Builder-5's small follow-ups, independently: a codex launch line that spells its permission
// options with an attached short value (`-aon-request`, `-sworkspace-write`) or a joined
// `=` value names the same options as the spaced forms, so it receives no stray default and the
// endpoint config carries them; the watch binds its pane keyboard writer to the refusal; and a
// record the reader cannot parse is refused through the documented end — exit 2,
// config.no-record, nothing written — never an uncaught parser error.
// Hermetic: a temporary HOME and project root, never ~/.config/team.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { realWatchSources } from '../src/commands/watch.ts';
import { codexEndpointConfig, remoteCodexCommand } from '../src/launch/plan.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand } from '../src/profiles/profile.ts';
import { refuseTyping } from '../src/send/no-pane-messaging.ts';
import { testIo } from './helpers.ts';
import { realRegistryTouched } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const codex = profileFor('codex')!;
const launched = (line: string): string => launchCommand(codex, line, 'RULES.');

describe('an attached or joined short permission value is the option it names', () => {
  test('both attached short values keep their own and receive no default pair', () => {
    expect(launched('codex -aon-request -sworkspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex -aon-request -sworkspace-write --no-alt-screen -c features.mcp_oauth_refresh_coordination=false',
    );
  });

  test('one attached short value suppresses only its own default pair', () => {
    expect(launched('codex -aon-request')).toBe(
      'AGENT_UNATTENDED=1 codex -aon-request -s danger-full-access --no-alt-screen -c features.mcp_oauth_refresh_coordination=false',
    );
    expect(launched('codex -sworkspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex -sworkspace-write -a never --no-alt-screen -c features.mcp_oauth_refresh_coordination=false',
    );
  });

  test('a short value joined with = suppresses its own default pair', () => {
    expect(launched('codex -a=never')).toBe(
      'AGENT_UNATTENDED=1 codex -a=never -s danger-full-access --no-alt-screen -c features.mcp_oauth_refresh_coordination=false',
    );
    expect(launched('codex -s=workspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex -s=workspace-write -a never --no-alt-screen -c features.mcp_oauth_refresh_coordination=false',
    );
  });

  test('the endpoint config carries an attached short value as its key', () => {
    expect(codexEndpointConfig('codex -m gpt-6.1-sol -aon-request -sworkspace-write resume ses_abc')).toEqual([
      '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"',
    ]);
  });

  test('the endpoint config carries a joined short value as its key', () => {
    expect(codexEndpointConfig('codex -m gpt-6.1-sol -a=never -s=workspace-write resume ses_abc')).toEqual([
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"',
    ]);
  });

  test('the remote resume sheds the attached short values, so the endpoint is the one source', () => {
    expect(remoteCodexCommand('AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -aon-request -sworkspace-write resume ses_abc --no-alt-screen')).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc --no-alt-screen',
    );
  });

  test('the remote resume sheds the joined short values as well', () => {
    expect(remoteCodexCommand('AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -a=never -s=workspace-write resume ses_abc --no-alt-screen')).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc --no-alt-screen',
    );
  });

  test('attached permission words after -- stay positional, out of the endpoint config', () => {
    expect(codexEndpointConfig('codex -m gpt-6.1-sol resume ses_abc -- -aon-request -sworkspace-write')).toEqual([]);
  });

  test('spaced permission words after -- stay positional, out of the endpoint config', () => {
    expect(codexEndpointConfig('codex -m gpt-6.1-sol resume ses_abc -- -a on-request -s workspace-write')).toEqual([]);
  });

  test('the remote resume keeps the words after -- and sheds only the overrides before it', () => {
    expect(remoteCodexCommand('AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -aon-request resume ses_abc -- -sworkspace-write')).toBe(
      'AGENT_UNATTENDED=1 codex -m gpt-6.1-sol resume ses_abc -- -sworkspace-write',
    );
  });
});

test('the watch binds its pane keyboard writer to the refusal, not to the terminal host', () => {
  expect(realWatchSources.sendKey).toBe(refuseTyping);
  expect(realWatchSources.typeText).toBe(refuseTyping);
  expect(realWatchSources.pressEnter).toBe(refuseTyping);
});

// The shape of a record the reader refuses: a block scalar, and a flow map that continues on
// the next line. Both open on line 16 of this record.
const RECORD = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
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
const BLOCK_SCALAR = RECORD + 'lobby: |\n  one line\n';
const FLOW_MAP = RECORD + 'lobby: { mode: shared,\n  team_idle: 2m }\n';
const BLOCK_WHY = '.agents/team.yaml cannot be read: line 16: block scalars ("|", ">") are not supported: write the value on one line';
const FLOW_WHY = '.agents/team.yaml cannot be read: line 16: "{" is not closed on its line';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(realRegistryTouched()).toBe(false);
});

type Place = { home: string; root: string; file: string };
function place(text: string): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-small-followups-independent-')));
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

function errorOf(out: string): Record<string, unknown> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`expected one json object on stdout, got: ${JSON.stringify(out)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`expected one json object on stdout, got: ${JSON.stringify(out)}`);
  }
  const envelope = parsed as { schema?: unknown; error?: Record<string, unknown> };
  expect(envelope.schema).toEqual({ name: 'team.error', version: 1 });
  if (envelope.error === undefined) throw new Error(`expected an error document, got: ${JSON.stringify(out)}`);
  return envelope.error;
}

describe('a record the parser cannot read is refused as unreadable, nothing written', () => {
  test('a set on a block-scalar record exits 2 config.no-record and leaves the file', async () => {
    const at = place(BLOCK_SCALAR);
    const ran = await config(at, ['set', 'project', 'beta', '--json']);
    expect(ran.code, ran.err + ran.out).toBe(2);
    expect(ran.err).toBe('');
    expect(errorOf(ran.out)).toEqual({ id: 'config.no-record', message: BLOCK_WHY, repair: null });
    expect(readFileSync(at.file, 'utf8')).toBe(BLOCK_SCALAR);
  });

  test('a get on a block-scalar record is refused the same way', async () => {
    const at = place(BLOCK_SCALAR);
    const ran = await config(at, ['get', 'project', '--json']);
    expect(ran.code, ran.err + ran.out).toBe(2);
    expect(ran.err).toBe('');
    expect(errorOf(ran.out)).toEqual({ id: 'config.no-record', message: BLOCK_WHY, repair: null });
    expect(readFileSync(at.file, 'utf8')).toBe(BLOCK_SCALAR);
  });

  test('a set on a record whose flow map continues on the next line exits 2 and leaves the file', async () => {
    const at = place(FLOW_MAP);
    const ran = await config(at, ['set', 'coordinator', 'worker', '--json']);
    expect(ran.code, ran.err + ran.out).toBe(2);
    expect(ran.err).toBe('');
    expect(errorOf(ran.out)).toEqual({ id: 'config.no-record', message: FLOW_WHY, repair: null });
    expect(readFileSync(at.file, 'utf8')).toBe(FLOW_MAP);
  });

  test('a get on that record is refused the same way', async () => {
    const at = place(FLOW_MAP);
    const ran = await config(at, ['get', 'coordinator', '--json']);
    expect(ran.code, ran.err + ran.out).toBe(2);
    expect(ran.err).toBe('');
    expect(errorOf(ran.out)).toEqual({ id: 'config.no-record', message: FLOW_WHY, repair: null });
    expect(readFileSync(at.file, 'utf8')).toBe(FLOW_MAP);
  });

  test('the plain refusal is one line with the reader\'s reason, never a stack trace', async () => {
    const at = place(BLOCK_SCALAR);
    const ran = await config(at, ['set', 'project', 'beta']);
    expect(ran.code, ran.err + ran.out).toBe(2);
    expect(ran.out).toBe('');
    expect(ran.err).toBe(`team config: ${BLOCK_WHY}\n`);
    expect(ran.err).not.toContain('YamlError');
    expect(ran.err).not.toContain('\n    at ');
    expect(readFileSync(at.file, 'utf8')).toBe(BLOCK_SCALAR);
  });
});
