// The can't-work detector waits on a wake only for mail the seat's own drop read would serve. A
// record the older mailbox store holds, or one a drop receipt already settled, is not mail this
// seat's wake could take: on 2026-11-14 four parked vlist seats with no unread drops were flagged
// "can't work: wake not taken" from such records.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass, type MailboxWaiting } from '../src/watch/pass.ts';

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const SEAT = 'deepseek-acme';
const PANE = 'w3:p1';

function team(): TeamFile {
  const parsed = validateTeamFile(readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8'));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function live(): Live {
  const agent: HerdrAgent = { workspace: 'w3', pane: PANE, agent: 'claude', name: SEAT, status: 'idle', cwd: null };
  return { running: true, agents: [agent], workspaces: [{ id: 'w3', label: SEAT }], screens: { [PANE]: idleScreen } };
}

function waiting(served: boolean, inDrops = true): MailboxWaiting {
  return { id: 'aaaaaaaa-0000-4000-8000-000000000001', to: SEAT, at: 0, pane: PANE, status: 'idle', cli: 'claude-code', screen: idleScreen, served, inDrops };
}

function passWith(record: MailboxWaiting) {
  const file = team();
  return pass({
    team: file,
    watch: file.watch,
    state: emptySession(),
    live: live(),
    machine: fine,
    now: 60_000,
    memory: newMemory(),
    mailbox: [record],
    processes: { [PANE]: { shell: 100, foreground: [101] } },
  });
}

function cantWorkFor(served: boolean): unknown {
  const file = team();
  const result = pass({
    team: file,
    watch: file.watch,
    state: emptySession(),
    live: live(),
    machine: fine,
    now: 60_000,
    memory: newMemory(),
    mailbox: [waiting(served)],
    processes: { [PANE]: { shell: 100, foreground: [101] } },
  });
  return (result.cantWork ?? []).find((plan) => plan.seat === SEAT);
}

test('a record the seat\'s drop read would not serve raises no "wake not taken"', () => {
  expect(cantWorkFor(false)).toBeUndefined();
});

test('an unread drop the seat\'s idle screen has not taken is still "wake not taken"', () => {
  expect(cantWorkFor(true)).toMatchObject({ seat: SEAT });
});

test('a record in the older mailbox store is reported once to the lead, naming its reader, and is no can\'t-work', () => {
  const result = passWith(waiting(false, false));
  expect((result.cantWork ?? []).find((plan) => plan.seat === SEAT)).toBeUndefined();
  expect(result.reports.map((report) => report.text)).toContain(`${SEAT}: 1 message(s) wait in the older mailbox store; \`team messages\` serves them, a wake does not`);
});

test('a record its drop receipt already settled raises nothing', () => {
  const result = passWith(waiting(false, true));
  expect((result.cantWork ?? []).find((plan) => plan.seat === SEAT)).toBeUndefined();
  expect(result.reports.some((report) => report.text.includes('older mailbox store'))).toBe(false);
});

test('the older-store report is said once while the count stands, and again when it changes', () => {
  const file = team();
  const memory = newMemory();
  const run = (records: MailboxWaiting[], now: number) => pass({
    team: file, watch: file.watch, state: emptySession(), live: live(), machine: fine, now, memory,
    mailbox: records, processes: { [PANE]: { shell: 100, foreground: [101] } },
  }).reports.filter((report) => report.text.includes('older mailbox store'));
  const one = waiting(false, false);
  expect(run([one], 60_000)).toHaveLength(1);
  expect(run([one], 120_000)).toHaveLength(0);
  expect(run([one, { ...one, id: 'aaaaaaaa-0000-4000-8000-000000000002' }], 180_000)).toHaveLength(1);
});
