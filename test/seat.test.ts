// `team seat <seat>`: one seat as an object — its settings and where each value comes from, the
// row `team seats` reads for it, the newest session TeamCLI recorded (conversation and cost) and
// the CLI hook's last turn. The scenes cover a seat with a conversation and a turn, one with
// neither, the `--json` payload, and the refusals a read still owes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSeat, USAGE } from '../src/commands/seat.ts';
import { cliHookStatePath } from '../src/launch/cli-hook.ts';
import { SESSIONS_FILE } from '../src/sessions/registry.ts';
import { storePath } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
delivery_order: [mcp-inbox, typed]
seats:
  - role: coordinator
    name: lead
    nickname: Atlas
    effort: high
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const NOW = new Date('2026-10-19T14:10:00Z');
const IDLE_SCREEN = `● Done.\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

const START = {
  event: 'start',
  ts: '2026-10-19T13:58:00Z',
  id: 'ses_aaaaaaaaaaaa',
  team: 'acme',
  project: 'acme',
  seat: 'lead',
  nickname: 'Atlas',
  cli: 'claude-code',
  lab: 'anthropic',
  model: 'Claude Opus',
  version: '5.5',
  effort: 'high',
  account: 'anthropic',
  herdr_session: 'acme',
  pane: 'w1:p1',
  cli_session: 'cli-1',
  resumable: true,
} as const;

const END = {
  event: 'end',
  ts: '2026-10-19T14:03:00Z',
  id: 'ses_aaaaaaaaaaaa',
  reason: 'restart',
  cost: { amount: 1.2, currency: 'USD', source: 'measured' },
  tokens: { in: 100, out: 20, source: 'measured' },
} as const;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seat-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const OWNER: Caller = { kind: 'owner' };

function live(): Live {
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: 'acme' }],
    screens: { 'w1:p1': IDLE_SCREEN },
  };
}

function sources(over: { live?: Live | null; home?: string } = {}) {
  return {
    live: () => (over.live === undefined ? live() : over.live),
    branch: () => 'main',
    standing: () => ({ kind: 'none' }) as const,
    now: () => NOW,
    home: over.home ?? home,
  };
}

function writeConversation(): void {
  const dir = storePath('acme', root, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SESSIONS_FILE), `${JSON.stringify(START)}\n${JSON.stringify(END)}\n`);
}

function writeTurn(state: 'working' | 'idle', since: string): void {
  const path = cliHookStatePath(join(root, '.agents'), 'acme', 'lead');
  if (path === null) throw new Error('the fixture has no hook path');
  mkdirSync(join(root, '.agents', 'seat-state', 'acme'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ state, since })}\n`);
}

async function run(
  argv: string[],
  caller: Caller = OWNER,
  over: { live?: Live | null; home?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runSeat(argv, io, sources(over));
  return { code, out: io.out, err: io.err };
}

/** Every file under `.agents`, so a scene can prove the read wrote nothing. */
function agentsOnDisk(): Record<string, string> {
  const dir = join(root, '.agents');
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    try {
      out[name] = readFileSync(join(dir, name), 'utf8');
    } catch {
      out[name] = '<folder>';
    }
  }
  return out;
}

describe('a seat with a conversation and a turn', () => {
  test('prints its settings, its row, its session and its turn, and writes nothing', async () => {
    writeConversation();
    writeTurn('idle', '2026-10-19T14:03:00Z');
    // The first read seeds the trace cache `seatRegistryRows` keeps beside the state, as
    // `team seats` does; the shown run is the one that must change nothing.
    expect((await run(['lead'])).code).toBe(0);
    const before = agentsOnDisk();
    const result = await run(['lead']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      '  KEY             VALUE             SOURCE      APPLIES\n'
      + '  model           Claude Opus       team file   restart that resumes\n'
      + '  effort          high              team file   restart that resumes\n'
      + '  nickname        Atlas             team file   at once\n'
      + '  delivery_order  mcp-inbox, typed  team order  at once\n'
      + '  human           false             default     at once\n'
      + '\n'
      + '  FIELD         VALUE\n'
      + '  project       acme\n'
      + '  session       acme\n'
      + '  role          coordinator\n'
      + '  id            -\n'
      + '  status        idle\n'
      + '  state         idle\n'
      + '  source        cli-hook\n'
      + '  pane          w1:p1\n'
      + '  last active   -\n'
      + '  turn          idle since 2026-10-19 14:03Z\n'
      + '  conversation  ses_aaaaaaaaaaaa\n'
      + '  cli session   cli-1\n'
      + '  resumable     yes\n'
      + '  started       2026-10-19 13:58Z\n'
      + '  ended         2026-10-19 14:03Z\n'
      + '  cost          1.2 USD\n',
    );
    expect(result.err).toBe('');
    // The turn file is read, never written: the folder is exactly as it stood.
    expect(agentsOnDisk()).toEqual(before);
  });
});

describe('a seat with neither', () => {
  test('reports each absent reading as absent, and its cost as unknown', async () => {
    const result = await run(['worker']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      '  KEY             VALUE             SOURCE      APPLIES\n'
      + '  model           Claude Opus       team file   restart that resumes\n'
      + '  effort          -                 unset       restart that resumes\n'
      + '  nickname        -                 unset       at once\n'
      + '  delivery_order  mcp-inbox, typed  team order  at once\n'
      + '  human           false             default     at once\n'
      + '\n'
      + '  FIELD         VALUE\n'
      + '  project       acme\n'
      + '  session       acme\n'
      + '  role          implementer\n'
      + '  id            -\n'
      + '  status        missing\n'
      + '  state         done\n'
      + '  source        process\n'
      + '  pane          -\n'
      + '  last active   -\n'
      + '  turn          -\n'
      + '  conversation  -\n'
      + '  cli session   -\n'
      + '  resumable     -\n'
      + '  started       -\n'
      + '  ended         -\n'
      + '  cost          unknown\n',
    );
  });
});

describe('--json', () => {
  test('carries the settings, the status row, the turn, the conversation and its cost', async () => {
    writeConversation();
    writeTurn('working', '2026-10-19T14:08:00Z');
    const result = await run(['lead', '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out) as Record<string, unknown>;
    expect(doc).toEqual({
      schema: { name: 'team.seat', version: 1 },
      format: 1,
      project: 'acme',
      session: 'acme',
      seat: 'lead',
      settings: [
        { key: 'model', value: 'Claude Opus', source: 'team file', applies: 'restart-resume' },
        { key: 'effort', value: 'high', source: 'team file', applies: 'restart-resume' },
        { key: 'nickname', value: 'Atlas', source: 'team file', applies: 'at-once' },
        { key: 'delivery_order', value: ['mcp-inbox', 'typed'], source: 'team default', applies: 'at-once' },
        { key: 'human', value: false, source: 'default', applies: 'at-once' },
      ],
      status: {
        name: 'lead',
        nickname: 'Atlas',
        id: null,
        role: 'coordinator',
        cli: 'claude-code',
        model: 'Claude Opus 5.5',
        effort: 'high',
        status: 'idle',
        state: 'working',
        state_source: 'cli-hook',
        last_active: NOW.toISOString(),
        pane: 'w1:p1',
        launch_line: 'claude --model claude-opus-5-5',
      },
      turn: { state: 'working', since: '2026-10-19T14:08:00Z' },
      conversation: {
        id: 'ses_aaaaaaaaaaaa',
        cli_session: 'cli-1',
        resumable: true,
        started: '2026-10-19T13:58:00Z',
        ended: '2026-10-19T14:03:00Z',
        reason: 'restart',
      },
      cost: { amount: 1.2, currency: 'USD', source: 'measured' },
      tokens: { in: 100, out: 20, source: 'measured' },
    });
  });

  test('omits cost and tokens a record does not hold, and says the conversation is null', async () => {
    const result = await run(['worker', '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out) as Record<string, unknown>;
    expect(doc.schema).toEqual({ name: 'team.seat', version: 1 });
    expect(doc.conversation).toBeNull();
    expect(doc.turn).toBeNull();
    expect('cost' in doc).toBe(false);
    expect('tokens' in doc).toBe(false);
  });
});

describe('refusals', () => {
  test('an invocation with no seat', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err).toBe(`team seat: a seat name is required\n${USAGE}`);
  });

  test('an invocation with a second word', async () => {
    const result = await run(['lead', 'worker']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unexpected "worker"');
  });

  test('an unknown option', async () => {
    const result = await run(['lead', '--nope']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown option --nope');
  });

  test('a seat the team file does not declare', async () => {
    const result = await run(['ghost']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('team seat: no seat "ghost" is declared in acme\n');
    expect(result.out).toBe('');
  });

  test('a seat the team file does not declare, under --json', async () => {
    const result = await run(['ghost', '--json']);
    expect(result.code).toBe(1);
    assertJsonErrorShape(result.out, { id: 'seat.no-seat', messageContains: 'no seat "ghost" is declared in acme' });
  });

  test('a file that does not parse', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), 'format: 1\nseats: not-a-list\n');
    const result = await run(['lead']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team.yaml line');
  });

  test('a file the owner names that is not there', async () => {
    const result = await run(['lead', '--file', 'missing.yaml']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team seat:');
  });

  test('herdr that does not answer', async () => {
    const result = await run(['lead'], OWNER, { live: null });
    expect(result.code).toBe(2);
    expect(result.err).toBe("team seat: herdr doesn't answer; is it installed and running?\n");
  });

  test('a team the caller is not part of', async () => {
    const result = await run(['lead'], { kind: 'pane', pane: 'w9:p1' });
    expect(result.code).toBe(2);
    expect(result.err).toBe('team seat: this team is not yours to read\n');
  });

  test('--file is the owner\'s', async () => {
    const result = await run(['lead', '--file', '.agents/team.yaml'], { kind: 'pane', pane: 'w9:p1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('team seat:');
  });

  test('--session is the owner\'s', async () => {
    const result = await run(['lead', '--session', 'acme'], { kind: 'pane', pane: 'w9:p1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('team seat:');
  });

  test('a session registry that cannot be read', async () => {
    const dir = storePath('acme', root, home);
    mkdirSync(dir, { recursive: true });
    const real = join(base, 'sessions.jsonl');
    writeFileSync(real, '');
    symlinkSync(real, join(dir, SESSIONS_FILE));
    const result = await run(['lead']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('team seat: a symbolic link was found and not followed\n');
  });
});
