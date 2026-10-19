// `team usage` per seat: the spend a seat's own screen printed is that seat's and nobody else's,
// and a seat no screen answered for reads `unknown` with its reason — never a zero, never another
// seat's figure. The cases here are the ones a packed CLI run on a fake herdr showed (a
// claude-code row printing `S: $5.8`, a grok screen no profile recognizes, and a seat the state
// records no pane for): the observer's own loop and the report's two faces.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runUsage } from '../src/commands/usage.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { observeQuota } from '../src/information/quota-observe.ts';
import type { MachineUsage } from '../src/information/usage.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T03:00:00Z');

/** The status row a real 2.1.299 screen drew, the one grammar a capture showed printing money. */
const REAL_SCREEN = [
  '❯',
  '─'.repeat(40),
  '  main · …/floor/docs · Opus 5.5 · S: $5.8 ⣿⣄⣀⣀⣀ 24% · L: 20% (2h6m) · W: 12% (+13.3%) (125h26m)',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  '',
].join('\n');
/** A grok screen: readable text, and no row any shipped profile recognizes as a status line. */
const GROK_SCREEN = '● Working on the task.\n\nNo status line here, and no money figure.\n';
const UNREAD = "no money cost was read from this seat's screen this run";

/** A seat's caller: the restricted view's ordinary reader, handed in so the fixture's view does
 *  not depend on the process tree the test runs from. */
const SEAT: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' };

describe('a seat’s spend is its own', () => {
  test('a screen no CLI profile recognizes reads no cost and is not an unread pane, beside a seat whose status line printed one', () => {
    // What the packed run showed: the observer reads both panes, the claude-code row yields its
    // measured cost stamped with the run, and the grok screen yields nothing — not a zero, not a
    // borrowed figure, and not a "pane could not be read" note either, because it was read.
    const machine = {
      teams: [{
        kind: 'team',
        root: '/mine',
        usage: {
          session: 'acme-web',
          seatAccounts: [
            { seat: 'lead', cli: 'claude-code', account: 'anthropic', pane: 'w1:p1' },
            { seat: 'mystery', cli: 'grok', account: 'xai', pane: 'w2:p1' },
            // The state records no pane for this seat, so there is nothing to read.
            { seat: 'ghost', cli: 'claude-code', account: 'anthropic' },
          ],
        },
      }],
    } as unknown as MachineUsage;
    const screens: Record<string, string> = { 'w1:p1': REAL_SCREEN, 'w2:p1': GROK_SCREEN };
    const reads: string[] = [];
    const live = observeQuota(machine, { full: false, mine: '/mine' }, {
      now: NOW.getTime(),
      pane: (pane) => { reads.push(pane); return screens[pane] ?? null; },
      usage: () => { throw new Error('no seat here runs a CLI with a usage command'); },
    });
    // Only the two seats the state records a pane for are read, once each.
    expect(reads).toEqual(['w1:p1', 'w2:p1']);
    // The money figure is the status line's, on the seat that printed it, stamped with its run.
    expect(live.costs).toEqual([{
      seat: 'lead',
      account: 'anthropic',
      session: 'acme-web',
      amount: 5.8,
      currency: 'USD',
      observedAt: NOW.getTime(),
      source: 'status line',
    }]);
    // The grok screen printed no window and no money figure; it is still an answered pane.
    expect(live.observations.map((one) => `${one.account}/${one.window}`)).toEqual(['anthropic/session', 'anthropic/weekly']);
    expect(live.notes).toEqual([]);
  });

  test('one run’s report gives the measured spend to the seat that printed it, and `unknown` with its reason to an unrecognized CLI and a seat with no state record', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seat-usage-')));
    const home = join(base, 'home');
    const root = join(base, 'acme');
    mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
    mkdirSync(join(root, '.agents'), { recursive: true });
    try {
      const text = `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    anthropic:
      kind: subscription
      reserve: 10%
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: member
    name: mystery
    cli: grok
    vendor: xai
    model: Grok
    version: "4"
    launch: grok
  - role: member
    name: ghost
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
      writeFileSync(join(root, '.agents', 'team.yaml'), text);
      const checked = validateTeamFile(text, { home, root });
      if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
      writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, [], home);
      // The state records the two seats whose panes it saw; `ghost` has no seat record at all.
      updateState(join(root, '.agents'), (state) => {
        state.sessions['acme-web'] = {
          ...emptySession(),
          seats: {
            lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' },
            mystery: { stage: 'ready', pane: 'w2:p1', workspace: 'w1' },
          },
        } as never;
      });
      // The observer's own reading of the two panes above, handed in as the command's source:
      // only the claude-code row printed an amount.
      const cost = {
        seat: 'lead',
        account: 'anthropic',
        session: 'acme-web',
        amount: 5.8,
        currency: 'USD' as const,
        observedAt: NOW.getTime(),
        source: 'status line' as const,
      };
      const tree = testIo(root, SEAT);
      expect(await runUsage(['--tree'], tree, { home, now: () => NOW, observe: () => ({ observations: [], costs: [cost], notes: [] }) })).toBe(0);
      // The measured figure stands on its own seat, with the surface and its age; the grok seat
      // and the seat with no state record print `unknown` and the one reason, never a zero.
      expect(tree.out).toContain('  lead  claude-code  anthropic  cost  $5.8  measured  status line  read 0m ago\n');
      expect(tree.out).toContain(`  mystery  grok  xai  cost  unknown  ${UNREAD}\n`);
      expect(tree.out).toContain(`  ghost  claude-code  anthropic  cost  unknown  ${UNREAD}\n`);
      // The same run's document carries the session registry's cost vocabulary on every seat.
      const json = testIo(root, SEAT);
      expect(await runUsage(['--json'], json, { home, now: () => NOW, observe: () => ({ observations: [], costs: [cost], notes: [] }) })).toBe(0);
      const doc = JSON.parse(json.out) as { teams: { seats: { seat: string; cli: string; account: string; run: string; windows: unknown[]; cost: Record<string, unknown> }[] }[] };
      expect(doc.teams[0]?.seats).toEqual([
        {
          seat: 'lead',
          cli: 'claude-code',
          account: 'anthropic',
          run: 'acme-web',
          windows: [],
          cost: {
            amount: 5.8,
            currency: 'USD',
            source: 'measured',
            readFrom: 'status line',
            readAt: new Date(NOW.getTime()).toISOString(),
            age: '0m',
          },
        },
        {
          seat: 'mystery',
          cli: 'grok',
          account: 'xai',
          run: 'acme-web',
          windows: [],
          cost: { amount: null, currency: 'USD', source: 'unknown', why: UNREAD },
        },
        {
          seat: 'ghost',
          cli: 'claude-code',
          account: 'anthropic',
          run: 'acme-web',
          windows: [],
          cost: { amount: null, currency: 'USD', source: 'unknown', why: UNREAD },
        },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
