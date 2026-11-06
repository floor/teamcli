// Independent check of the Muse hint colour (src/watch/screen-core.ts) and the status and
// check wording (src/status/compare.ts, src/watch/checks/unsent.ts). The frames are the
// shipped 1.4.14 hint box with the input row replaced. No live pane or CLI runs.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { compare, type Live } from '../src/status/compare.ts';
import { emptySession } from '../src/state.ts';
import type { SeatObservation } from '../src/watch/check.ts';
import { unsent } from '../src/watch/checks/unsent.ts';
import { readBox, readScreen, screenData } from '../src/watch/screen.ts';

const HINT = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.14', 'hint-grey-synthetic.txt'), 'utf8');
const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'working-synthetic.txt'), 'utf8');
const CODEX_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'codex', '0.161.0', 'idle.txt'), 'utf8');
const LINE = 'Read the note and act on it.';
const PANE = 'fixture-pane-one';
const BLUE = '\x1b[38;2;90;160;255m';
const GREY = '\x1b[38;2;103;108;116m';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const OTHERS = ['claude-code', 'codex', 'cursor', 'grok', 'antigravity', 'gemini', 'jules'] as const;

const input = HINT.split('\n').find((line) => line.includes('❯'));
if (input === undefined) throw new Error('the hint fixture has no input row');
const greyAt = input.indexOf(GREY);
if (greyAt < 0) throw new Error('the hint fixture input row has no declared grey');
const prompt = input.slice(0, greyAt);
const hintText = input.slice(greyAt).replace(/\x1b\[[0-9;]*m/g, '');

function withRow(row: string): string {
  return HINT.split('\n').map((line) => (line === input ? row : line)).join('\n');
}

function wake(screenAt: (read: number, enters: number) => string | null): { host: TypedWakeHost; typed: string[]; enters: () => number } {
  const typed: string[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => screenAt(reads++, enters),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return { host, typed, enters: () => enters };
}

test('a row wholly in the declared hint grey is an empty box, and a wake is typed', async () => {
  expect(readScreen('muse', HINT).kind).toBe('idle');
  expect(readBox('muse', HINT)).toBeNull();
  expect(boxHoldsText('muse', hintText, HINT)).toBe(false);

  const held = withRow(`${prompt}${BLUE}${LINE}\x1b[0m`);
  const run = wake((read, enters) => (enters > 0 ? WORKING : read < 2 ? HINT : held));
  const out = await deliverTypedWake(run.host, PANE, LINE, 'muse', FAST);
  expect(out.delivered).toBe(true);
  expect(out.typed).toBe(true);
  expect(run.typed).toEqual([LINE]);
  expect(run.enters()).toBe(1);
});

test('grey after a typed blue prefix, bold, inverse and a 256-colour grey stay text', async () => {
  const rows = [
    `${prompt}${BLUE}ship ${GREY}${hintText}\x1b[0m`,
    `${prompt}\x1b[1;38;2;103;108;116m${hintText}\x1b[0m`,
    `${prompt}${GREY}${hintText.slice(0, 4)}\x1b[7m${hintText.slice(4, 5)}\x1b[27m${hintText.slice(5)}\x1b[0m`,
    `${prompt}\x1b[38;5;244m${hintText}\x1b[0m`,
    `${prompt}\x1b[90m${hintText}\x1b[0m`,
  ];
  for (const row of rows) {
    const frame = withRow(row);
    expect(readScreen('muse', frame).kind).toBe('unsent');
    const run = wake(() => frame);
    const out = await deliverTypedWake(run.host, PANE, LINE, 'muse', FAST);
    expect(out.typed).toBe(false);
    expect(out.delivered).toBe(false);
    expect(run.typed).toEqual([]);
    expect(run.enters()).toBe(0);
  }
});

test('a hint that becomes a typed draft between the two reads is not typed into', async () => {
  const draft = withRow(`${prompt}${BLUE}ship the patch\x1b[0m`);
  const run = wake((read) => (read === 0 ? HINT : draft));
  const out = await deliverTypedWake(run.host, PANE, LINE, 'muse', FAST);
  expect(out.delivered).toBe(false);
  expect(out.typed).toBe(false);
  expect(out.reason).toContain('second read');
  expect(run.typed).toEqual([]);
  expect(run.enters()).toBe(0);
});

test('other CLI profiles do not treat the declared grey as an empty box', () => {
  for (const cli of OTHERS) {
    expect(screenData(cli)?.composer.placeholderFg).toBeUndefined();
    expect(readScreen(cli, HINT).kind).not.toBe('idle');
  }
  expect(readScreen('codex', CODEX_IDLE).kind).toBe('idle');
});

test('the unsent check and status say the box holds text and never say to clear it', () => {
  const draft = withRow(`${prompt}${BLUE}ship the patch\x1b[0m`);
  const screen = readScreen('muse', draft);
  expect(screen.kind).toBe('unsent');
  const since: Record<string, number> = {};
  const ctx = {
    now: 0,
    watch: { unsentAfter: 60 },
    once: (_key: string, text: string) => ({ key: 'unsent:worker', text, to: 'operator' as const }),
    keep: () => {},
    memory: () => since,
  };
  const seat = { name: 'worker', running: true, quiet: true, working: false, prompt: false, screen } as SeatObservation;
  expect(unsent.run(seat, ctx as never).length).toBe(0);
  ctx.now = 60_000;
  const reports = unsent.run(seat, ctx as never);
  expect(reports.map((report) => report.text)).toEqual(['worker: its input box reads as holding text; nothing is typed there']);
  expect(reports.some((report) => /clear/i.test(report.text))).toBe(false);

  const text = [
    'format: 1',
    'project: fixture',
    'visibility: private',
    'session: acme',
    'operator: worker',
    'trust:',
    '  - .',
    'workspace:',
    '  mode: shared',
    'watch:',
    '  unsent_after: 1m',
    'seats:',
    '  - role: implementer',
    '    name: worker',
    '    cli: muse',
    '    vendor: fixture',
    '    model: Muse Wonder',
    '    version: "1.0"',
    '    launch: muse',
    '    leads: true',
    '',
  ].join('\n');
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  const agent: HerdrAgent = { name: 'worker', agent: 'muse', pane: PANE, workspace: 'fixture-space', status: 'idle', cwd: null };
  const live: Live = {
    running: true,
    agents: [agent],
    workspaces: [{ id: 'fixture-space', label: 'fixture' }],
    screens: { [PANE]: draft },
  };
  const result = compare(parsed.team, 'acme', emptySession(), live, new Date(), parsed.team.watch, join(tmpdir(), 'fixture-muse-hint-absent'));
  const spoken = result.differences.flatMap((difference) => [difference.what, difference.repair]);
  expect(spoken.some((line) => line.includes('its input box reads as holding text; nothing is typed there'))).toBe(true);
  expect(spoken.some((line) => /clear/i.test(line))).toBe(false);
});
