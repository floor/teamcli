// A socket greeting reads the sender's own team record. A same-named seat on the receiving
// team, or on an unrelated team, cannot lend its nickname to the sender.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { TeamFile } from '../../src/file/types.ts';
import { cliHookSettingsPath } from '../../src/launch/cli-hook.ts';
import { registerLaunch } from '../../src/registry/sync.ts';
import { setRoster, teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const FOREIGN_TEAM_ID = 'eeeeeeeeeeee';

type Shadow = 'receiving' | 'foreign' | 'receiving-id' | 'foreign-id' | null;
type Scene = {
  cleanup: () => void;
  frames: string[];
  run: () => Promise<number>;
};

let made: Scene | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

function teamText(input: {
  project: string;
  session: string;
  lead: string;
  inProject?: string;
  projectLead?: boolean;
  seats: { name: string; role: string; label?: string; nickname?: string; inbound?: boolean }[];
}): string {
  const seats = input.seats.map((seat) => `  - role: ${seat.role}
    name: ${seat.name}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${seat.label === undefined ? '' : `    label: ${JSON.stringify(seat.label)}\n`}${seat.nickname === undefined ? '' : `    nickname: ${JSON.stringify(seat.nickname)}\n`}${seat.inbound === true ? '    inbound: accept\n' : ''}`).join('');
  return `format: 1
project: ${input.project}
entity: acme
session: ${input.session}
${input.inProject === undefined ? '' : `in_project: ${input.inProject}\n`}${input.projectLead === true ? 'project_lead: true\n' : ''}
coordinator: ${input.lead}
operator: ${input.lead}
workspace:
  mode: shared
seats:
${seats}`;
}

function makeTeam(root: string, text: string): TeamFile {
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(`the sender-scope fixture team is invalid: ${JSON.stringify(checked.errors)}`);
  return checked.team;
}

function place(root: string, sessionName: string, seat: string, pane: string, stage: 'launched' | 'ready' = 'launched'): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[sessionName] ??= emptySession());
    session.seats[seat] = { stage, pane, workspace: 'w1' };
  });
}

function scene(shadow: Shadow, localNickname?: string, declared = false): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sender-name-scope-')));
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const senderRoot = join(base, 'acme');
  const receiverRoot = declared ? senderRoot : join(base, 'floor');
  const senderPane = 'acme:sender5';
  const receiverPane = declared ? 'acme:lead' : 'floor:lead';
  mkdirSync(sockets, { recursive: true });

  const senderTeam = makeTeam(senderRoot, teamText({
    project: 'acme',
    session: 'acme',
    lead: declared ? 'lead' : 'sender5',
    ...(declared ? {} : { inProject: 'acme', projectLead: true }),
    seats: declared
      ? [
        { name: 'lead', role: 'facilitator', inbound: true },
        { name: 'sender5', role: 'builder', label: 'Agamemnon · builder' },
      ]
      : [{
        name: 'sender5',
        role: 'builder',
        label: 'Agamemnon · builder',
        ...(localNickname === undefined ? {} : { nickname: localNickname }),
      }],
  }));
  const receiverTeam = declared
    ? senderTeam
    : makeTeam(receiverRoot, teamText({
      project: 'floor',
      session: 'floor',
      lead: 'lead',
      inProject: 'acme',
      seats: [
        { name: 'lead', role: 'facilitator', inbound: true },
        ...(['receiving', 'receiving-id'].includes(shadow ?? '') ? [{ name: 'sender5', role: 'builder', nickname: 'Atlas' }] : []),
      ],
    }));

  const senderLaunch = declared
    ? null
    : registerLaunch({ home, team: senderTeam, root: senderRoot, by: 'test' }, senderTeam.seats[0] as TeamFile['seats'][number], senderPane);
  if (senderLaunch !== null && 'note' in senderLaunch) throw new Error(`could not register the sender: ${senderLaunch.note}`);
  const receiverLaunch = registerLaunch({ home, team: receiverTeam, root: receiverRoot, by: 'test' }, receiverTeam.seats[0] as TeamFile['seats'][number], receiverPane);
  if ('note' in receiverLaunch) throw new Error(`could not register the receiver: ${receiverLaunch.note}`);

  // Model a fresh registered sender whose id has not yet reached its own team's roster. The
  // project lead record continues to admit the sender to the other team's lead.
  if (!declared && localNickname === undefined) {
    setRoster(home, teamIdOf(senderRoot), []);
  }

  if (shadow === 'receiving' || shadow === 'receiving-id') {
    const receiverLead = 'agt_999999999998';
    setRoster(home, teamIdOf(receiverRoot), [
      { agent: receiverLaunch.id, seat: 'lead', role: 'facilitator', leads: true },
      { agent: shadow === 'receiving-id' ? senderLaunch?.id ?? receiverLead : receiverLead, seat: 'sender5', role: 'builder', nickname: 'Atlas' },
    ]);
  } else if (shadow === 'foreign' || shadow === 'foreign-id') {
    upsertTeam(home, FOREIGN_TEAM_ID, {
      project: 'other',
      entity: 'other',
      session: 'other',
      root: join(base, 'other'),
      roster: [{ agent: shadow === 'foreign-id' ? senderLaunch?.id ?? 'agt_999999999997' : 'agt_999999999997', seat: 'sender5', role: 'builder', nickname: 'Atlas' }],
      lifecycle: 'running',
      by: 'test',
      at: NOW.toISOString(),
    });
  }

  const receiverSession = declared ? 'acme' : 'floor';
  const settings = cliHookSettingsPath(join(receiverRoot, '.agents'), receiverSession, 'lead');
  if (settings === null) throw new Error('the receiving seat has no settings path');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const declaredAt = new Date(Date.now() - 60_000);
  utimesSync(settings, declaredAt, declaredAt);
  writeFileSync(join(sockets, '222.sock'), '');

  const frames: string[] = [];
  const host: SendHost = {
    agents: (sessionName) => sessionName === receiverSession
      ? [{ name: 'lead', pane: receiverPane }, ...(declared ? [{ name: 'sender5', pane: senderPane }] : [])]
      : sessionName === 'acme'
        ? [{ name: 'sender5', pane: senderPane }]
        : null,
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (_socketPath, frame) => {
      frames.push(frame);
      return { ok: true };
    },
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} },
    now: () => NOW,
    home,
  };
  const io = testIo(senderRoot, { kind: 'seat', name: 'sender5', pane: senderPane, session: 'acme' });
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  place(senderRoot, 'acme', 'sender5', senderPane, declared ? 'ready' : 'launched');
  place(receiverRoot, receiverSession, 'lead', receiverPane);
  return {
    cleanup,
    frames,
    run: async () => {
      const code = await runSend([declared ? 'lead' : 'lead@floor', 'a note'], io, host);
      if (code !== 0) throw new Error(`the fixture send was refused: ${io.err.trim()} ${io.out.trim()}`);
      return code;
    },
  };
}

function frameLine(frames: readonly string[]): string {
  const frame = frames[0];
  if (frame === undefined) throw new Error('no socket frame was dialed');
  return (JSON.parse(frame) as { message: { content: string } }).message.content.split('\n')[0] ?? '';
}

test('a sender reads its own team nickname ahead of its written label', async () => {
  const one = scene(null, 'Achilles');
  made = one;

  expect(await one.run()).toBe(0);
  expect(frameLine(one.frames)).toBe('Message from Achilles (sender5@acme)');
});

test('a receiving team nickname cannot rename a sender whose own roster lacks its id', async () => {
  const one = scene('receiving');
  made = one;

  expect(await one.run()).toBe(0);
  expect(frameLine(one.frames)).toBe('Message from Agamemnon (sender5@acme)');
});

test('a foreign team nickname cannot rename a sender whose own roster lacks its id', async () => {
  const one = scene('foreign');
  made = one;

  expect(await one.run()).toBe(0);
  expect(frameLine(one.frames)).toBe('Message from Agamemnon (sender5@acme)');
});

test('a receiving team roster cannot answer a sender id with a conflicting nickname', async () => {
  const one = scene('receiving-id');
  made = one;

  expect(await one.run()).toBe(0);
  expect(frameLine(one.frames)).toBe('Message from Agamemnon (sender5@acme)');
});

test('a foreign team roster cannot answer a sender id with a conflicting nickname', async () => {
  const one = scene('foreign-id');
  made = one;

  expect(await one.run()).toBe(0);
  expect(frameLine(one.frames)).toBe('Message from Agamemnon (sender5@acme)');
});

test('a declared sender also uses its own team label when a foreign team has the same seat nickname', async () => {
  const one = scene('foreign', undefined, true);
  made = one;

  expect(await one.run()).toBe(0);
  expect(frameLine(one.frames)).toBe('Message from Agamemnon (sender5@acme)');
});
