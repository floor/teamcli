// A record signed only with the shared checkout key never reads as attributed.
// Both readers say unverified claim. Synthetic homes only.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const homes: string[] = [];
afterEach(() => discardFixtures(homes.splice(0)));

const NOW = new Date('2026-11-06T16:30:00.000Z');

function place(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), 'sender-unverified-'));
  homes.push(home);
  const root = join(home, 'project');
  mkdirSync(join(root, '.agents'), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
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
    leads: true
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: { worker: { stage: 'ready' as const, pane: 'pane-worker' } },
    } as never;
  });
  plantRecord(home, root, 'acme', 'worker', '6b1f3c2d-4e5a-4b6c-8d7e-9f0a1b2c3d4e', 'shared-key body\n', {
    from: 'lead',
    rule: 'an orchestrator or operator to a seat of its own team',
    at: NOW.toISOString(),
  });
  return { home, root };
}

test('a shared-key-only record never shows (attributed) in either reader', async () => {
  const { home, root } = place();
  const messages = testIo(root, { kind: 'owner' });
  expect(await runMessages([], messages, { home, now: () => NOW })).toBe(0);
  expect(messages.out).toContain('lead (unverified claim)');
  expect(messages.out).not.toContain('(attributed)');
  const drops = testIo(root, { kind: 'seat', name: 'worker', pane: 'pane-worker', session: 'acme' });
  expect(await runDrops([], drops, { home })).toBe(0);
  expect(drops.err).toBe('');
  expect(drops.out).toContain('lead (unverified claim)');
  expect(drops.out).not.toContain('(attributed)');
});

test('a shared-key-only record never emits attributed in json or inbox_check', async () => {
  const { home, root } = place();
  const messages = testIo(root, { kind: 'owner' });
  expect(await runMessages(['--json'], messages, { home, now: () => NOW })).toBe(0);
  expect(messages.out).not.toContain('attributed');
  const messageDoc = JSON.parse(messages.out) as { rows: Array<{ sender_attribution?: string }> };
  expect(messageDoc.rows[0]?.sender_attribution).toBe('unverified_claim');
  const drops = testIo(root, { kind: 'seat', name: 'worker', pane: 'pane-worker', session: 'acme' });
  expect(await runDrops(['--json'], drops, { home })).toBe(0);
  expect(drops.out).not.toContain('attributed');
  const dropDoc = JSON.parse(drops.out) as { drops: Array<{ sender_attribution?: string }> };
  expect(dropDoc.drops[0]?.sender_attribution).toBe('unverified_claim');
  const unread = listUnread(recordDir(root, 'acme', 'worker'), { to: 'worker', root, session: 'acme' }, home);
  expect(JSON.stringify(unread)).not.toContain('attributed');
  expect(unread[0]?.sender_attribution).toBe('unverified_claim');
});
