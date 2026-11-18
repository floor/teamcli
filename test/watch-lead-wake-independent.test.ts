// A lead with unread mail past lead_unread_after is woken, and text already in the box stays.
// An idle lead whose delivery order is drop only is woken the same way. No read receipt within
// five minutes tells the parent orchestrator once. A seat whose box holds
// unsent text and whose mail is still queued reads blocked: unsent input, and is not called idle.
// Screens and the clock are injected. Pane names are synthetic. No terminal host is started.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { draftCopyPath } from '../src/send/deliver.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { dropMessage } from '../src/send/native.ts';
import { deliverLeadTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const FIVE_MINUTES = 5 * 60 * 1000;
const DRAFT = 'keep the owner line';
const MAIL = 'c0ffee00-1111-4000-8000-0000000000c1';
const PANE = 'pane-lead';
const MAKER_PANE = 'pane-maker';
const RULE = '─'.repeat(40);
const STATUS = '  main · …/box · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function frame(text: string): string {
  if (text === '') return `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
  return `${RULE}\n❯ ${text}\n${RULE}\n${STATUS}\n`;
}

type Box = { screen: string; status: string; typed: string[]; keys: string[] };

function sources(held: Box): RetrySources {
  return {
    screen: () => held.screen,
    status: () => held.status,
    typeText: (_pane, text) => {
      held.typed.push(text);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      const line = pasted ? pasted[1] ?? '' : text;
      held.screen = frame(line);
      return true;
    },
    pressEnter: () => {
      if (!held.screen.includes(DRAFT)) {
        held.status = 'working';
        held.screen = frame('');
      }
      return true;
    },
    sendKey: (_pane, key) => {
      held.keys.push(key);
      held.screen = frame('');
      return true;
    },
    sleep: async () => {},
  };
}

function open(leadOrder?: 'drop'): { home: string; root: string; parent: string; dir: string; team: TeamFile } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'watch-lead-wake-')));
  made.push(home);
  const root = join(home, 'repo');
  const parent = join(home, 'parent');
  const lobby = resolveLobby(home, { entity: 'acme' });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(parent, '.agents'), { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  const text = `format: 1
project: box
entity: acme
session: acme
coordinator: lead
operator: clerk
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude${leadOrder === 'drop' ? '\n    delivery_order:\n      - drop' : ''}
  - role: implementer
    name: maker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  upsertTeam(home, teamIdOf(parent), {
    project: 'acme',
    entity: 'acme',
    session: 'acme-parent',
    root: parent,
    roster: [{ agent: 'agt_parent000000', seat: 'parent', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(home, teamIdOf(root), {
    project: 'box',
    entity: 'acme',
    session: 'acme',
    root,
    roster: [{ agent: 'agt_lead00000000', seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  return { home, root, parent, dir: join(root, '.agents'), team: parsed.team };
}

function seed(place: { home: string; dir: string; root: string }, at: Date): void {
  const dropDir = join(place.dir, 'send-drops', 'acme', 'lead');
  const record = signRecord({
    kind: 'message',
    id: MAIL,
    to: 'lead',
    to_id: null,
    root: place.root,
    session: 'acme',
    at: at.toISOString(),
    body: 'from the owner\n\nA note still unread.\n',
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: MAIL,
  }, place.home);
  dropMessage(dropDir, MAIL, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, MAIL), at, at);
}

function leadLive(): Live {
  const agents: HerdrAgent[] = [
    { name: 'lead', agent: 'claude', pane: PANE, workspace: 'ws-lead', status: 'idle', cwd: null },
  ];
  return { running: true, agents, workspaces: [{ id: 'ws-lead', label: 'lead' }], screens: { [PANE]: frame(DRAFT) } };
}

function scene(place: ReturnType<typeof open>, box: Box, said: string[], now: Date) {
  return {
    dir: place.dir,
    session: 'acme',
    root: place.root,
    home: place.home,
    team: place.team,
    live: leadLive(),
    ownPane: null,
    sources: sources(box),
    now,
    say: (text: string) => said.push(text),
  };
}

function parentMail(parent: string): string[] {
  const folder = join(parent, '.agents', 'messages', 'parent');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.startsWith('evt-prompt-lead-'));
}

test('a lead with unread mail past lead_unread_after is woken and the owner text stays', async () => {
  const place = open();
  expect(place.team.watch.leadUnreadAfter).toBe(180);
  const landed = new Date(NOW.getTime() - place.team.watch.leadUnreadAfter * 1000);
  seed(place, landed);
  const held = { screen: frame(DRAFT), status: 'idle', typed: [], keys: [] };
  const said: string[] = [];
  await wakeUnreadDrops(scene(place, held, said, NOW), { unreadAfter: place.team.watch.unreadAfter });
  expect(said.join('\n')).toContain('wake');
  expect(held.screen).toContain(DRAFT);
  expect(existsSync(join(place.dir, 'send-drops', 'acme', 'lead', `${MAIL}.read.json`))).toBe(false);
});

test('an idle drop-only lead with unread mail still gets the wake', async () => {
  const place = open('drop');
  const lead = place.team.seats.find((seat) => seat.name === 'lead');
  expect(lead?.deliveryOrder).toEqual(['drop']);
  const landed = new Date(NOW.getTime() - place.team.watch.leadUnreadAfter * 1000);
  seed(place, landed);
  const held = { screen: frame(''), status: 'idle', typed: [], keys: [] };
  const said: string[] = [];
  await wakeUnreadDrops(scene(place, held, said, NOW), { unreadAfter: place.team.watch.unreadAfter });
  expect(said.join('\n')).toContain('wake');
  expect(existsSync(join(place.dir, 'send-drops', 'acme', 'lead', `${MAIL}.read.json`))).toBe(false);
});

test('no read receipt within five minutes tells the parent orchestrator once', async () => {
  const place = open();
  const landed = new Date(NOW.getTime() - place.team.watch.leadUnreadAfter * 1000);
  seed(place, landed);
  const held = { screen: frame(DRAFT), status: 'idle', typed: [], keys: [] };
  const said: string[] = [];
  await wakeUnreadDrops(scene(place, held, said, NOW), { unreadAfter: place.team.watch.unreadAfter });
  const later = new Date(NOW.getTime() + FIVE_MINUTES);
  await wakeUnreadDrops(scene(place, held, said, later), { unreadAfter: place.team.watch.unreadAfter });
  const names = parentMail(place.parent);
  expect(names).toHaveLength(1);
  const episode = MAIL.replace(/[^0-9A-Za-z]/g, '');
  const path = messageFile(place.parent, 'parent', `evt-prompt-lead-lead-${episode}`);
  expect(existsSync(path)).toBe(true);
  const body = JSON.parse(readFileSync(path, 'utf8')) as { payload: { to: string; body: string } };
  expect(body.payload.to).toBe('parent');
  expect(body.payload.body).toContain('no read receipt');
  expect(body.payload.body).toContain('5 minutes');
  const again = new Date(later.getTime() + FIVE_MINUTES);
  await wakeUnreadDrops(scene(place, held, said, again), { unreadAfter: place.team.watch.unreadAfter });
  expect(parentMail(place.parent)).toEqual(names);
});

test('unsent text with queued mail reads blocked: unsent input, never idle', () => {
  const place = open();
  const memory = newMemory();
  memory.history.maker = { lastWorking: undefined, idleSince: 0 };
  memory.slots.unsent = { maker: 0 };
  const agents: HerdrAgent[] = [
    { name: 'maker', agent: 'claude', pane: MAKER_PANE, workspace: 'ws-maker', status: 'idle', cwd: null },
  ];
  const live: Live = {
    running: true,
    agents,
    workspaces: [{ id: 'ws-maker', label: 'maker' }],
    screens: { [MAKER_PANE]: frame(DRAFT) },
  };
  const machine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
  const result = pass({
    team: place.team,
    watch: place.team.watch,
    state: emptySession(),
    live,
    machine,
    now: 10 * 60 * 1000,
    memory,
    queued: new Set(['maker']),
    readScreen: () => ({ kind: 'unsent' }),
  });
  const texts = result.reports.map((report) => report.text);
  expect(texts).toContain('maker: blocked: unsent input');
  expect(texts.some((text) => text.includes('idle'))).toBe(false);
});

const DRAFT_LINE = 'half a sentence';
const WAKE_LINE = 'wake the lead';

type WakeBox = { screen: string | null; typed: string[]; keys: string[]; enters: string[] };

function wakeHost(box: WakeBox, mode?: 'refuse-line' | 'stay-unsent' | 'dialog'): TypedWakeHost {
  return {
    read: () => box.screen,
    type: (_pane, text) => {
      if (mode === 'refuse-line' && !text.startsWith('\x1b[200~')) return false;
      box.typed.push(text);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      const line = pasted ? pasted[1] ?? '' : text;
      box.screen = frame(line);
      return true;
    },
    enter: () => {
      box.enters.push(box.screen ?? '');
      box.screen = `✻ Working… (12s)\n${frame('')}`;
      return true;
    },
    key: (_pane, key) => {
      box.keys.push(key);
      if (mode === 'stay-unsent') box.screen = frame('still there');
      else if (mode === 'dialog') box.screen = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n';
      else box.screen = frame('');
      return true;
    },
    wait: async () => {},
  };
}

const wakeOptions = { settleMs: 0, enterSettleMs: 0, pollMs: 1, ackSettleMs: 0, verifyMs: 1 };

test('a typed wake puts the draft back and never submits it', async () => {
  const held: WakeBox = { screen: frame(DRAFT_LINE), typed: [], keys: [], enters: [] };
  const woke = await deliverLeadTypedWake(wakeHost(held), PANE, WAKE_LINE, 'claude-code', wakeOptions);
  expect(woke.delivered).toBe(true);
  expect(boxHoldsText('claude-code', DRAFT_LINE, held.screen ?? undefined)).toBe(true);
  expect(held.keys).toEqual(['ctrl+c']);
  expect(held.enters.length).toBeGreaterThan(0);
  for (const at of held.enters) expect(boxHoldsText('claude-code', DRAFT_LINE, at)).toBe(false);

  const failed: WakeBox = { screen: frame(DRAFT_LINE), typed: [], keys: [], enters: [] };
  const missed = await deliverLeadTypedWake(wakeHost(failed, 'refuse-line'), PANE, WAKE_LINE, 'claude-code', wakeOptions);
  expect(missed.delivered).toBe(false);
  expect(boxHoldsText('claude-code', DRAFT_LINE, failed.screen ?? undefined)).toBe(true);
  expect(failed.enters).toEqual([]);
  expect(failed.typed).toEqual([`\x1b[200~${DRAFT_LINE}\x1b[201~`]);

  const dark: WakeBox = { screen: null, typed: [], keys: [], enters: [] };
  const unread = await deliverLeadTypedWake(wakeHost(dark), PANE, WAKE_LINE, 'claude-code', wakeOptions);
  expect(unread.typed).toBe(false);
  expect(dark.typed).toEqual([]);
  expect(dark.keys).toEqual([]);
  expect(dark.enters).toEqual([]);
});

test('a clear that leaves the box occupied keeps the draft beside the drop and does not paste it', async () => {
  const place = open();
  const folder = join(place.dir, 'send-drops', 'acme', 'lead');
  mkdirSync(folder, { recursive: true });

  const occupiedPath = join(folder, 'c0ffee00-1111-4000-8000-0000000000d1');
  writeFileSync(occupiedPath, 'drop\n');
  const occupied: WakeBox = { screen: frame(DRAFT_LINE), typed: [], keys: [], enters: [] };
  const stayed = await deliverLeadTypedWake(
    wakeHost(occupied, 'stay-unsent'), PANE, `Read ${occupiedPath} and do that.`, 'claude-code', wakeOptions,
  );
  expect(stayed.delivered).toBe(false);
  expect(occupied.typed.some((text) => text.includes(DRAFT_LINE))).toBe(false);
  expect(occupied.enters).toEqual([]);
  expect(readFileSync(draftCopyPath(occupiedPath), 'utf8')).toBe(DRAFT_LINE);

  const dialogPath = join(folder, 'c0ffee00-1111-4000-8000-0000000000d2');
  writeFileSync(dialogPath, 'drop\n');
  const asking: WakeBox = { screen: frame(DRAFT_LINE), typed: [], keys: [], enters: [] };
  const blocked = await deliverLeadTypedWake(
    wakeHost(asking, 'dialog'), PANE, `Read ${dialogPath} and do that.`, 'claude-code', wakeOptions,
  );
  expect(blocked.delivered).toBe(false);
  expect(asking.typed.some((text) => text.includes(DRAFT_LINE))).toBe(false);
  expect(asking.enters).toEqual([]);
  expect(readFileSync(draftCopyPath(dialogPath), 'utf8')).toBe(DRAFT_LINE);
});

test('E6: a refused wake-attempt gate stops the draft-clearing keys too (control: an open gate clears)', async () => {
  // Control: with the gate open, the copyable draft is cleared by the profile's clear keys.
  const open: WakeBox = { screen: frame(DRAFT_LINE), typed: [], keys: [], enters: [] };
  await deliverLeadTypedWake(wakeHost(open), PANE, WAKE_LINE, 'claude-code', { ...wakeOptions, beforeFirstKey: () => true });
  expect(open.keys.length).toBeGreaterThan(0);
  // The same draft with the gate refused: no clear key, no paste, no Enter; the draft stays.
  const refused: WakeBox = { screen: frame(DRAFT_LINE), typed: [], keys: [], enters: [] };
  const result = await deliverLeadTypedWake(wakeHost(refused), PANE, WAKE_LINE, 'claude-code', { ...wakeOptions, beforeFirstKey: () => false });
  expect(refused.keys).toEqual([]);
  expect(refused.typed).toEqual([]);
  expect(refused.enters).toEqual([]);
  expect(refused.screen).toBe(frame(DRAFT_LINE));
  expect(result.delivered).toBe(false);
});
