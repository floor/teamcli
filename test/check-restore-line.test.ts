// team check's line for a seat the terminal host restored, read through the same proof `team up`
// adopts with. Four readings, one per answer the proof can give:
//
// - the proof holds: the difference names the re-tie `team up` makes, and the row is kept;
// - the proof fails at something a reader can act on (another conversation): that reason is the
//   difference, and no command is offered that could adopt it;
// - the pane never came back: the missing row says the CLI did not come back after a restore;
// - the seat was never launched, or nothing is running: today's line and repair are unchanged.
//
// Every pane, process and screen here is a synthetic fixture; no live host, registry home or CLI
// transcript is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStatus } from '../src/commands/status.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import { emptySession, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const SESSION = 'acme';
const PANE = 'restored-pane';
const SPACE = 'restored-space';
const LEAD_PANE = 'lead-pane';
const LEAD_SPACE = 'lead-space';

let base: string;
let root: string;
let home: string;
let lobby: string;
let dir: string;

function teamText(): string {
  return `format: 1
project: acme
session: ${SESSION}
operator: lead
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;
}

/** The lead's own record, so its pane reads as the same process and adds no difference of its
 *  own; the worker's record is what each scene varies (null: no record at all). */
function record(worker: Record<string, unknown> | null): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.lead = {
      stage: 'ready', pane: LEAD_PANE, workspace: LEAD_SPACE, launched: { shell: 10, cli: [11] },
    } as never;
    if (worker !== null) session.seats.worker = worker as never;
  });
}

/** The restored world: the lead is exactly the process its record names. `worker` is the entry on
 *  the recorded pane, or null when the host did not list the pane at all. */
function world(over: { worker?: Partial<HerdrAgent> | null; running?: boolean } = {}): Live {
  const lead: HerdrAgent = {
    name: 'lead', agent: 'claude', pane: LEAD_PANE, workspace: LEAD_SPACE, status: 'idle', cwd: null, session: 'ses_lead',
  };
  const worker: HerdrAgent | null = over.worker === null
    ? null
    : { name: null, agent: 'codex', pane: PANE, workspace: SPACE, status: 'idle', cwd: null, ...(over.worker ?? {}) };
  return {
    running: over.running ?? true,
    agents: worker === null ? [lead] : [lead, worker],
    workspaces: [{ id: LEAD_SPACE, label: 'lead' }, { id: SPACE, label: 'worker' }],
    screens: {},
    processes: {
      [LEAD_PANE]: { shell: 10, foreground: [10, 11] },
      ...(worker === null ? {} : { [PANE]: { shell: 20, foreground: [21] } }),
    },
    foreground: {
      [LEAD_PANE]: ['claude'],
      ...(worker === null ? {} : { [PANE]: ['codex'] }),
    },
  };
}

type StatusDoc = {
  rows: Array<{ name: string; state: string }>;
  differences: Array<{ what: string; repair: string; who: string }>;
};

async function readStatus(at: Live): Promise<{ code: number; doc: StatusDoc }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runStatus(['--json'], io, {
    live: () => at,
    branch: () => 'main',
    standing: () => ({ kind: 'none' } as const),
    now: () => NOW,
    home,
  });
  return { code, doc: JSON.parse(io.out) as StatusDoc };
}

const differenceFor = (doc: StatusDoc, name: string) => doc.differences.find((entry) => entry.what.startsWith(`${name}:`) || entry.what.startsWith(`${name} `));

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'check-restore-line-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root, env: gitEnv(),
  });
  writeFileSync(join(dir, 'team.yaml'), teamText());
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('a restored seat the proof holds', () => {
  test('the recorded conversation on the pane: the difference names the re-tie team up makes', async () => {
    record({ stage: 'ready', pane: PANE, workspace: SPACE, launched: { shell: 20, cli: [22] }, agent_session: 'ses_kept' });
    const { code, doc } = await readStatus(world({ worker: { session: 'ses_kept' } }));
    expect(code).toBe(1);
    expect(doc.rows.find((row) => row.name === 'worker')?.state).toBe('restored, not launched by team');
    const difference = differenceFor(doc, 'worker');
    expect(difference?.what).toBe("worker was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it");
    expect(difference?.repair).toBe('team up');
    expect(difference?.who).toBe("the team's lead");
  });

  test('no session on either side, the declared CLI alone and idle: the weak proof names it', async () => {
    record({ stage: 'ready', pane: PANE, workspace: SPACE, launched: { shell: 20, cli: [22] } });
    const { code, doc } = await readStatus(world());
    expect(code).toBe(1);
    expect(doc.rows.find((row) => row.name === 'worker')?.state).toBe('restored, not launched by team');
    const difference = differenceFor(doc, 'worker');
    expect(difference?.what).toBe("worker was restored by the terminal host; its pane holds the seat's declared CLI — team up re-ties it");
    expect(difference?.repair).toBe('team up');
  });
});

describe('a restored seat the proof refuses', () => {
  test('another conversation on the pane: the reason replaces the generic tail, and no command adopts it', async () => {
    record({ stage: 'ready', pane: PANE, workspace: SPACE, launched: { shell: 20, cli: [22] }, agent_session: 'ses_kept' });
    const { code, doc } = await readStatus(world({ worker: { session: 'ses_other' } }));
    expect(code).toBe(1);
    expect(doc.rows.find((row) => row.name === 'worker')?.state).toBe('restored, not launched by team');
    const difference = differenceFor(doc, 'worker');
    expect(difference?.what).toBe("worker: its pane holds another conversation (ses_other; the record's launch ran ses_kept)");
    expect(difference?.repair).toBe('look at the pane');
  });
});

describe('a seat whose CLI did not come back', () => {
  test('the recorded pane is not listed at all: the missing row says the CLI did not come back', async () => {
    record({ stage: 'ready', pane: PANE, workspace: SPACE, launched: { shell: 20, cli: [22] } });
    const { code, doc } = await readStatus(world({ worker: null }));
    expect(code).toBe(1);
    expect(doc.rows.find((row) => row.name === 'worker')?.state).toBe('missing');
    const difference = differenceFor(doc, 'worker');
    expect(difference?.what).toBe('worker was running and its CLI did not come back (the terminal host restored the session without it)');
    expect(difference?.repair).toBe('team up');
    expect(difference?.who).toBe("the team's lead");
  });

  test('a seat that was never launched keeps today\'s line and repair', async () => {
    record({ stage: 'named' });
    const { doc } = await readStatus(world({ worker: null }));
    const difference = differenceFor(doc, 'worker');
    expect(difference?.what).toBe('worker is in the file and is not running');
    expect(difference?.repair).toBe('team restart worker');
  });

  test('with nothing running, a launch record keeps today\'s line: no restore can be claimed', async () => {
    record({ stage: 'ready', pane: PANE, workspace: SPACE, launched: { shell: 20, cli: [22] } });
    const { doc } = await readStatus(world({ worker: null, running: false }));
    const difference = differenceFor(doc, 'worker');
    expect(difference?.what).toBe('worker is in the file and is not running');
  });
});
