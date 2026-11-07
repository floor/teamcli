// A shared checkout key proves a record was not edited. Every seat can read it, so it does not
// say who sent the record. Both readers say that as an unverified claim. Only the launch brief
// bound to the seat's current claim says attributed. Synthetic homes and repositories only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { generalBriefRecord, GENERAL_BRIEF_SHA256 } from '../src/launch/general-brief.ts';
import { signRecord, writeRecord } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
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

const NOW = '2026-10-04T09:00:00.000Z';
const RULE = 'an orchestrator or operator to a seat of its own team';
const SHARED_ID = '6b1f3c2d-4e5a-4b6c-8d7e-9f0a1b2c3d4e';

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sender-unverified-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'ready' as const, pane: 'fixture-pane-lead' } } } as never;
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function plantSharedKey(): void {
  plantRecord(
    home,
    root,
    'acme',
    'lead',
    SHARED_ID,
    `from orchestrator@acme — admitted by: ${RULE}\n\nOwner says: ship it.\n`,
    { from: 'orchestrator', from_id: null, rule: RULE, at: NOW },
  );
}

function plantCurrentBrief(): void {
  const incarnation = 'inc_000000000012';
  const record = generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW, incarnation });
  const wrote = writeRecord(recordDir(root, 'acme', 'lead'), signRecord(record, home));
  if (!wrote.ok) throw new Error(wrote.reason);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      ...state.sessions.acme,
      briefs: {
        lead: {
          id: record.id,
          at: record.at,
          incarnation,
          epoch: 'run_000000000012',
          sha256: GENERAL_BRIEF_SHA256,
          attempt: 0,
          stage: 'ready' as const,
          superseded: [],
        },
      },
    } as never;
  });
}

describe('a shared checkout key is an unverified claim', () => {
  test('team messages reads the shared-key record as an unverified claim', async () => {
    plantSharedKey();
    const io = testIo(root, { kind: 'owner' });
    const code = await runMessages([], io, { home, now: () => new Date(NOW) });
    expect(code).toBe(0);
    expect(io.out).toContain('orchestrator (unverified claim)');
    expect(io.out).not.toContain('orchestrator (attributed)');
  });

  test('team drops reads the shared-key record as an unverified claim and the launch brief as attributed', async () => {
    plantSharedKey();
    plantCurrentBrief();
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'fixture-pane-lead', session: 'acme' });
    const code = await runDrops([], io, { home });
    expect(code).toBe(0);
    expect(io.out).toContain('orchestrator (unverified claim)');
    expect(io.out).not.toContain('orchestrator (attributed)');
    expect(io.out).toContain('the launch (attributed)');
  });

  test('team messages --json emits unverified_claim for a shared-key record', async () => {
    plantSharedKey();
    const io = testIo(root, { kind: 'owner' });
    const code = await runMessages(['--json'], io, { home, now: () => new Date(NOW) });
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { rows: { sender_attribution?: string }[] };
    expect(doc.rows[0]?.sender_attribution).toBe('unverified_claim');
    expect(io.out).not.toContain('"attributed"');
  });

  test('team drops --json and inbox_check emit unverified_claim for a shared-key record and launch-brief for the bound brief', async () => {
    plantSharedKey();
    plantCurrentBrief();
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'fixture-pane-lead', session: 'acme' });
    const code = await runDrops(['--json'], io, { home });
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { drops: { from: string | null; sender_attribution?: string }[] };
    const shared = doc.drops.find((row) => row.from === 'orchestrator');
    const brief = doc.drops.find((row) => row.from === 'the launch');
    expect(shared?.sender_attribution).toBe('unverified_claim');
    expect(brief?.sender_attribution).toBe('launch-brief');

    const unread = listUnread(join(root, '.agents', 'send-drops', 'acme', 'lead'), { to: 'lead', root, session: 'acme' }, home);
    expect(unread.find((row) => row.from === 'orchestrator')?.sender_attribution).toBe('unverified_claim');
    expect(unread.find((row) => row.from === 'the launch')?.sender_attribution).toBe('launch-brief');
  });
});
