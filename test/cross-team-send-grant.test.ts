// The cross-team send grant: an owner-signed record naming `send`, the entity-bound
// `orchestrator@<entity>` receiver, the signature the reader verifies, and the `team grant --send`
// form that writes one. Fake host, synthetic home, no live session and no pane touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGrant } from '../src/commands/grant.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { lobbyDir, lobbyTrustEntry, resolveLobby } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readSendGrantReads, readSendGrants } from '../src/send/grants.ts';
import type { NativePane } from '../src/send/native.ts';
import { updateState } from '../src/state.ts';
import { keyOf, signDomain } from '../src/store/keys.ts';
import { recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const FUTURE = '2027-06-01T00:00:00.000Z';
const PAST = '2026-10-16T11:59:59.000Z';
const DOMAIN = 'team-send-grant-v1\n';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

type SeatLine = { name: string; role: string; cli: string; launch: string };

function teamFile(input: {
  project: string;
  entity: string;
  session: string;
  coordinator: string;
  root: string;
  lobby: string;
  seats: SeatLine[];
}): string {
  const seats = input.seats
    .map(
      (seat) => `  - role: ${seat.role}
    name: ${seat.name}
    cli: ${seat.cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${seat.launch}`,
    )
    .join('\n');
  return `format: 1
project: ${input.project}
entity: ${input.entity}
coordinator: ${input.coordinator}
operator: ${input.coordinator}
session: ${input.session}
workspace:
  mode: shared
trust:
  - ${input.lobby}
  - ${input.root}
seats:
${seats}
delivery_order: [mcp-inbox, typed]
`;
}

type World = {
  root: string;
  dir: string;
  home: string;
  sockets: string;
  teamcliRoot: string;
  teamcliDir: string;
  otherRoot: string;
  otherDir: string;
};

/** Three teams in two entities. `floor` (project floor, session studio) holds the sender; `teamcli`
 *  (same entity) holds the lead seat `lead` — deliberately not called `orchestrator`, so the grant's
 *  reserved `orchestrator@<entity>` is the only spelling that reaches it; `other` is another entity
 *  and its lead seat is literally `orchestrator`, so the old `seat@team` reading would reach it. */
function world(where: { under?: string } = {}): World {
  base = realpathSync(mkdtempSync(join(where.under ?? tmpdir(), 'team-cross-team-send-')));
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  const root = mkdirTeam('floor', {
    project: 'floor', entity: 'floor', session: 'studio', coordinator: 'architect', lobby: lobbyTrustEntry(home, { entity: 'floor' }),
    seats: [
      { name: 'architect', role: 'architect', cli: 'claude-code', launch: 'claude' },
      { name: 'builder', role: 'builder', cli: 'claude-code', launch: 'claude' },
    ],
  });
  const teamcliRoot = mkdirTeam('teamcli', {
    project: 'teamcli', entity: 'floor', session: 'teamcli', coordinator: 'lead', lobby: lobbyTrustEntry(home, { entity: 'floor' }),
    seats: [
      { name: 'lead', role: 'lead', cli: 'codex', launch: 'codex -m test' },
      { name: 'builder-1', role: 'builder', cli: 'claude-code', launch: 'claude' },
    ],
  });
  const otherRoot = mkdirTeam('other', {
    project: 'other', entity: 'other', session: 'other', coordinator: 'orchestrator', lobby: lobbyTrustEntry(home, { entity: 'other' }),
    seats: [
      { name: 'orchestrator', role: 'lead', cli: 'codex', launch: 'codex -m test' },
    ],
  });
  // The sender's home-chain id is the id the loaded root derives. The project name stays the address.
  const floorId = teamIdOf(root);
  const architect = registerSeat('architect', 'architect', 'pane1', { team: floorId, session: 'studio' });
  const builder = registerSeat('builder', 'builder', 'pane2', { team: floorId, session: 'studio' });
  const lead = registerSeat('lead', 'lead', 'pane3', { team: 'teamcli', session: 'teamcli' });
  const builderOne = registerSeat('builder-1', 'builder', 'pane4', { team: 'teamcli', session: 'teamcli' });
  const orchestrator = registerSeat('orchestrator', 'lead', 'pane5', { team: 'other', session: 'other' });
  upsertTeam(home, floorId, {
    project: 'floor', entity: 'floor', session: 'studio', root, lobby: resolveLobby(home, { entity: 'floor' }), lifecycle: 'running', by: 'test',
    roster: [
      { agent: architect, seat: 'architect', role: 'architect', leads: true },
      { agent: builder, seat: 'builder', role: 'builder' },
    ],
  });
  upsertTeam(home, 'teamcli', {
    project: 'teamcli', entity: 'floor', session: 'teamcli', root: teamcliRoot, lobby: lobbyDir(home), lifecycle: 'running', by: 'test',
    roster: [
      { agent: lead, seat: 'lead', role: 'lead', leads: true },
      { agent: builderOne, seat: 'builder-1', role: 'builder' },
    ],
  });
  upsertTeam(home, 'other', {
    project: 'other', entity: 'other', session: 'other', root: otherRoot, lobby: lobbyDir(home), lifecycle: 'running', by: 'test',
    roster: [{ agent: orchestrator, seat: 'orchestrator', role: 'lead', leads: true }],
  });
  record(join(root, '.agents'), 'builder', 'pane2');
  return {
    root, dir: join(root, '.agents'), home, sockets,
    teamcliRoot, teamcliDir: join(teamcliRoot, '.agents'),
    otherRoot, otherDir: join(otherRoot, '.agents'),
  };
}

function mkdirTeam(name: string, input: { project: string; entity: string; session: string; coordinator: string; lobby: string; seats: SeatLine[] }): string {
  const root = join(base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile({ ...input, root }));
  return root;
}

/** The id `up` registers for a seat, the identity admission reads. */
function agentIdOf(seat: string): string {
  return `agt_${createHash('sha256').update(seat).digest('hex').slice(0, 12)}`;
}

/** The agent record `up` writes for a launched seat, the identity admission reads. */
function registerSeat(seat: string, role: string, pane: string, where: { team: string; session: string }): string {
  const id = agentIdOf(seat);
  const file = join(base, 'home', '.config', 'team', 'agents', `${id}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `id: "${id}"`,
      `name: "${seat}"`,
      'signing:',
      '  model: "Test"',
      '  version: "1"',
      `  role: "${role}"`,
      'lab: "test"',
      'cli: "claude-code"',
      'launcher: null',
      'launch: "claude"',
      'reach:',
      `  team: "${where.team}"`,
      `  seat: "${seat}"`,
      `  session: "${where.session}"`,
      `  pane: "${pane}"`,
      '  address: null',
      'mcp: []',
      'skills: []',
      'lifecycle: "running"',
      'provenance:',
      '  registered_by: "team up"',
      '  registered_at: "2026-10-16T12:00:00.000Z"',
      '  updated_at: "2026-10-16T12:00:00.000Z"',
      '',
    ].join('\n'),
  );
  return id;
}

function record(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.studio = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

function fake(sockets: string, home: string): SendHost {
  return {
    agents: () => [
      { name: 'architect', pane: 'pane1' },
      { name: 'builder', pane: 'pane2' },
      { name: 'lead', pane: 'pane3' },
      { name: 'builder-1', pane: 'pane4' },
      { name: 'orchestrator', pane: 'pane5' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async () => ({ ok: true }),
    native: scripted(['idle', 'working']),
    now: () => NOW,
    home,
  };
}

function scripted(samples: string[]): NativePane {
  let read = 0;
  return {
    typeText: () => true,
    pressEnter: () => true,
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
}

function grantsFolder(home: string): string {
  return join(home, '.config', 'team', 'grants');
}

/** The re-issue command the refusal prints, as one line. */
function printedLine(text: string): string {
  const line = text.split('\n').find((one) => one.startsWith('team grant --send '));
  if (line === undefined) throw new Error(`no re-issue line in: ${text}`);
  return line;
}

/** One printed command line as its shell words: single quotes group, `'\''` is one quote. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line.charAt(index);
    if (!quoted && ch === '\\' && line[index + 1] === "'") {
      word += "'";
      index += 1;
      continue;
    }
    if (ch === "'") {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (word !== '') words.push(word);
      word = '';
      continue;
    }
    word += ch;
  }
  if (word !== '') words.push(word);
  return words;
}

/** The signed record the owner's side writes: the file carries the pair and its expiry, and the
 *  signature covers the stem's name, the pair and the expiry. */
function signSendRecord(
  home: string,
  stem: string,
  pair: { from: string; to: string; expires: string },
  options: { keyHome?: string } = {},
): string {
  const folder = grantsFolder(home);
  mkdirSync(folder, { recursive: true });
  const key = keyOf(options.keyHome ?? home);
  const payload = { name: stem, send: { from: pair.from, to: pair.to }, expires: pair.expires };
  const signature = signDomain(DOMAIN, payload, key);
  const file = join(folder, `${stem}.json`);
  writeFileSync(file, `${JSON.stringify({ send: payload.send, expires: pair.expires, signature }, null, 2)}\n`);
  return file;
}

/** An unsigned record, the shape the owner wrote before signatures were read. */
function unsignedSendRecord(home: string, stem: string, pair: { from: string; to: string; expires: string }): string {
  const folder = grantsFolder(home);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${stem}.yaml`);
  writeFileSync(file, `send:\n  from: ${pair.from}\n  to: ${pair.to}\nexpires: "${pair.expires}"\n`);
  return file;
}

function builderIo(root: string) {
  return testIo(root, { kind: 'seat', name: 'builder', pane: 'pane2', session: 'studio' });
}

function sendAsBuilder(world: World, target: string, extra: string[] = []) {
  const io = builderIo(world.root);
  const code = runSend([target, 'a note', ...extra], io, fake(world.sockets, world.home));
  return { code, out: () => io.out, err: () => io.err };
}

function dropBodies(dir: string, session: string, seat: string): string[] {
  const drops = join(dir, 'send-drops', session, seat);
  if (!existsSync(drops)) return [];
  return readdirSync(drops)
    .filter((name) => !name.startsWith('.') && !name.endsWith('.pending') && !name.endsWith('.fallback.json') && !name.endsWith('.meta.json'))
    .map((name) => recordBody(join(drops, name)));
}

describe('team send: the entity-bound send grant', () => {
  test('a signed record admits a seat to another team\'s lead through orchestrator@<entity>', async () => {
    const w = world();
    signSendRecord(w.home, 'builder-to-lead', { from: 'builder@floor', to: 'orchestrator@floor', expires: FUTURE });
    const { code, out, err } = sendAsBuilder(w, 'lead@teamcli');
    expect(await code).toBe(0);
    expect(err()).toBe('');
    expect(out()).toContain('lead@teamcli: queued, not woken');
    expect(out()).toContain('team teamcli, session "teamcli"');
    expect(dropBodies(w.teamcliDir, 'teamcli', 'lead')).toEqual([
      'from builder@floor — admitted by: an owner-signed grant naming send (builder-to-lead)\n\na note',
    ]);
  });

  test('the dry run names the grant that admits the pair', async () => {
    const w = world();
    signSendRecord(w.home, 'builder-to-lead', { from: 'builder@floor', to: 'orchestrator@floor', expires: FUTURE });
    const { code, out, err } = sendAsBuilder(w, 'lead@teamcli', ['--dry-run']);
    expect(await code).toBe(0);
    expect(`${out()}${err()}`).toContain('lead: dry-run:');
    expect(`${out()}${err()}`).toContain('admitted by: an owner-signed grant naming send (builder-to-lead)');
    expect(existsSync(join(w.teamcliDir, 'send-drops'))).toBe(false);
  });

  test('the entity pattern names the lead only: a non-lead seat of that team is refused', async () => {
    const w = world();
    signSendRecord(w.home, 'builder-to-lead', { from: 'builder@floor', to: 'orchestrator@floor', expires: FUTURE });
    const { code, err } = sendAsBuilder(w, 'builder-1@teamcli');
    expect(await code).toBe(1);
    expect(err()).toContain('no rule admits it');
    expect(existsSync(join(w.teamcliDir, 'send-drops'))).toBe(false);
  });

  test('the pattern is bound to the sender\'s entity: another entity\'s lead is refused', async () => {
    const w = world();
    // The other team's lead is literally named `orchestrator`, so the old `seat@team` reading
    // would have reached it. The reserved pattern must not.
    signSendRecord(w.home, 'builder-to-other', { from: 'builder@floor', to: 'orchestrator@other', expires: FUTURE });
    const { code, err } = sendAsBuilder(w, 'orchestrator@other');
    expect(await code).toBe(1);
    expect(err()).toContain('no rule admits it');
    expect(existsSync(join(w.otherDir, 'send-drops'))).toBe(false);
  });

  test('an expired record admits nothing, signed or not', async () => {
    const w = world();
    signSendRecord(w.home, 'lapsed', { from: 'builder@floor', to: 'orchestrator@floor', expires: PAST });
    const { code, err } = sendAsBuilder(w, 'lead@teamcli');
    expect(await code).toBe(1);
    expect(err()).toContain('no rule admits it');
  });
});

describe('team send: an unsigned record refuses and says how to re-issue it', () => {
  const REISSUE =
    "team grant --send --from 'builder@floor' --to 'lead@teamcli' --expires '2027-06-01T00:00:00.000Z' --name 'old-grant'";

  test('the refusal names the record and prints the exact line, and the dry run shows it too', async () => {
    const w = world();
    unsignedSendRecord(w.home, 'old-grant', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE });
    const real = sendAsBuilder(w, 'lead@teamcli');
    expect(await real.code).toBe(1);
    expect(real.err()).toContain('send-grant');
    expect(real.err()).toContain('not signed by the owner');
    expect(real.err()).toContain('"old-grant"');
    expect(real.err()).toContain(REISSUE);
    expect(existsSync(join(w.teamcliDir, 'send-drops'))).toBe(false);

    const dry = sendAsBuilder(w, 'lead@teamcli', ['--dry-run']);
    expect(await dry.code).toBe(1);
    expect(dry.err()).toContain('not signed by the owner');
    expect(dry.err()).toContain(REISSUE);
  });

  test('the structured refusal carries the send.grant-invalid id', async () => {
    const w = world();
    unsignedSendRecord(w.home, 'old-grant', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE });
    const { code, out } = sendAsBuilder(w, 'lead@teamcli', ['--json']);
    expect(await code).toBe(1);
    const body = JSON.parse(out()) as { error: { id: string; message: string } };
    expect(body.error.id).toBe('send.grant-invalid');
    expect(body.error.message).toContain(REISSUE);
  });

  test('a record signed by another key is refused the same way', async () => {
    const w = world();
    const elsewhere = join(base, 'elsewhere-home');
    mkdirSync(elsewhere, { recursive: true });
    signSendRecord(w.home, 'forged', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE }, { keyHome: elsewhere });
    const { code, err } = sendAsBuilder(w, 'lead@teamcli');
    expect(await code).toBe(1);
    expect(err()).toContain('does not verify with the owner\'s approval key');
    expect(err()).toContain("team grant --send --from 'builder@floor' --to 'lead@teamcli'");
  });

  test('the printed line recreates the record signed, and the send then goes through', async () => {
    const w = world();
    unsignedSendRecord(w.home, 'old-grant', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE });
    expect(await sendAsBuilder(w, 'lead@teamcli').code).toBe(1);
    const owner = testIo(w.root, { kind: 'owner' });
    const wrote = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'lead@teamcli', '--expires', FUTURE, '--name', 'old-grant'],
      owner,
      { home: w.home },
    );
    expect(await wrote).toBe(0);
    expect(owner.out).toContain('grant: updated');
    expect(readSendGrants(w.home).map((grant) => grant.name)).toEqual(['old-grant']);
    // The re-issue writes the JSON sibling; the old unsigned YAML stays and admits nothing.
    expect(existsSync(join(grantsFolder(w.home), 'old-grant.yaml'))).toBe(true);
    expect(readSendGrantReads(w.home).map((read) => read.state).sort()).toEqual(['unsigned', 'verified']);
    const { code } = sendAsBuilder(w, 'lead@teamcli');
    expect(await code).toBe(0);
    expect(dropBodies(w.teamcliDir, 'teamcli', 'lead')).toEqual([
      'from builder@floor — admitted by: an owner-signed grant naming send (old-grant)\n\na note',
    ]);
  });

  test('a legacy display name prints a name the writer takes, and that line runs as printed', async () => {
    const w = world();
    const folder = grantsFolder(w.home);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'legacy.yaml'),
      `name: the review channel\nsend:\n  from: builder@floor\n  to: lead@teamcli\nexpires: "${FUTURE}"\n`,
    );
    const refused = sendAsBuilder(w, 'lead@teamcli');
    expect(await refused.code).toBe(1);
    // The refusal still names the record as it calls itself; the printed line carries a stem the
    // writer accepts, which it would have refused with "is not a record name".
    expect(refused.err()).toContain('"the review channel"');
    expect(refused.err()).toContain("--name 'the-review-channel'");
    const line = printedLine(refused.err());
    const owner = testIo(w.root, { kind: 'owner' });
    const wrote = runGrant(shellWords(line).slice(2), owner, { home: w.home });
    expect(await wrote).toBe(0);
    expect(readSendGrants(w.home)).toEqual([
      { name: 'the-review-channel', from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE },
    ]);
    expect(await sendAsBuilder(w, 'lead@teamcli').code).toBe(0);
  });

  // The writer reserves `grant`, `delegate` and every `revoke-…` stem, and also refuses a name whose
  // `revoke-<name>` would not fit one file name; the printed line must survive all of them.
  for (const { display, expected } of [
    { display: 'grant', expected: 'send-grant' },
    { display: 'delegate', expected: 'send-delegate' },
    { display: 'revoke-old', expected: 'send-revoke-old' },
    { display: 'grant!', expected: 'send-grant' },
    { display: 'g'.repeat(60), expected: 'g'.repeat(57) },
  ]) {
    test(`a record called ${JSON.stringify(display)} prints --name '${expected}', and that line runs`, async () => {
      const w = world();
      const folder = grantsFolder(w.home);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'legacy.yaml'),
        `name: ${JSON.stringify(display)}\nsend:\n  from: builder@floor\n  to: lead@teamcli\nexpires: "${FUTURE}"\n`,
      );
      const refused = sendAsBuilder(w, 'lead@teamcli');
      expect(await refused.code).toBe(1);
      expect(refused.err()).toContain(`"${display}"`);
      expect(refused.err()).toContain(`--name '${expected}'`);
      const owner = testIo(w.root, { kind: 'owner' });
      const wrote = runGrant(shellWords(printedLine(refused.err())).slice(2), owner, { home: w.home });
      expect(await wrote).toBe(0);
      expect(readSendGrants(w.home).map((grant) => grant.name)).toEqual([expected]);
      expect(await sendAsBuilder(w, 'lead@teamcli').code).toBe(0);
    });
  }

  // A legacy expiry may be an offset form the writer now refuses; the line carries the same instant
  // in the canonical form, never the raw text and never nothing.
  for (const { raw, canonical } of [
    { raw: '2027-06-01T00:00:00+02:00', canonical: '2027-05-31T22:00:00.000Z' },
    { raw: '2027-06-01T00:00:00.000-05:00', canonical: '2027-06-01T05:00:00.000Z' },
  ]) {
    test(`a legacy expiry ${JSON.stringify(raw)} prints the canonical instant, and that line runs`, async () => {
      const w = world();
      const folder = grantsFolder(w.home);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'old-grant.yaml'),
        `send:\n  from: builder@floor\n  to: lead@teamcli\nexpires: ${JSON.stringify(raw)}\n`,
      );
      const refused = sendAsBuilder(w, 'lead@teamcli');
      expect(await refused.code).toBe(1);
      expect(refused.err()).toContain(`--expires '${canonical}'`);
      expect(refused.err()).not.toContain(`--expires '${raw}'`);
      const owner = testIo(w.root, { kind: 'owner' });
      const wrote = runGrant(shellWords(printedLine(refused.err())).slice(2), owner, { home: w.home });
      expect(await wrote).toBe(0);
      expect(readSendGrants(w.home)).toEqual([
        { name: 'old-grant', from: 'builder@floor', to: 'lead@teamcli', expires: canonical },
      ]);
    });
  }
});

describe('team grant --send: the writer', () => {
  test('the owner writes a signed record; the default name is the pair', async () => {
    const w = world();
    const owner = testIo(w.root, { kind: 'owner' });
    const code = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', FUTURE],
      owner,
      { home: w.home },
    );
    expect(await code).toBe(0);
    expect(owner.out).toContain('grant: updated');
    const name = 'builder-at-floor-to-orchestrator-at-floor';
    expect(readSendGrants(w.home)).toEqual([{ name, from: 'builder@floor', to: 'orchestrator@floor', expires: FUTURE }]);
    const file = join(grantsFolder(w.home), `${name}.json`);
    expect(existsSync(file)).toBe(true);
    const disk = JSON.parse(readFileSync(file, 'utf8')) as { signature: string };
    expect(typeof disk.signature).toBe('string');
  });

  test('the dry run writes nothing and says what it would write', async () => {
    const w = world();
    const owner = testIo(w.root, { kind: 'owner' });
    const code = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', FUTURE, '--name', 'planned', '--dry-run'],
      owner,
      { home: w.home },
    );
    expect(await code).toBe(0);
    expect(owner.out).toContain('would write');
    expect(owner.out).toContain('planned');
    expect(existsSync(grantsFolder(w.home)) ? readdirSync(grantsFolder(w.home)) : []).toEqual([]);
  });

  test('a seat cannot issue the record itself', async () => {
    const w = world();
    const seat = builderIo(w.root);
    const code = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', FUTURE],
      seat,
      { home: w.home },
    );
    expect(await code).toBe(1);
    expect(seat.err).toContain('only the owner runs this');
    expect(existsSync(grantsFolder(w.home))).toBe(false);
  });

  test('an expiry past a year, or already past, is refused', async () => {
    const w = world();
    for (const expires of ['2099-01-01T00:00:00.000Z', PAST]) {
      const owner = testIo(w.root, { kind: 'owner' });
      const code = runGrant(
        ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', expires],
        owner,
        { home: w.home },
      );
      expect(await code).toBe(2);
      expect(owner.err).toContain('team grant:');
    }
  });

  test('a date the calendar does not have is refused, not signed as the day it rolls to', async () => {
    const w = world();
    const owner = testIo(w.root, { kind: 'owner' });
    // `Date.parse` reads 2027-02-30 as March 2; the record would then carry a day the owner never saw.
    const code = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', '2027-02-30T00:00:00.000Z'],
      owner,
      { home: w.home },
    );
    expect(await code).toBe(2);
    expect(owner.err).toContain('not a real date and time');
    expect(existsSync(grantsFolder(w.home)) ? readdirSync(grantsFolder(w.home)) : []).toEqual([]);
  });

  test('a timestamp in another spelling is refused; the ISO form without a fraction is taken', async () => {
    const w = world();
    const loose = testIo(w.root, { kind: 'owner' });
    const refused = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', 'June 1, 2027'],
      loose,
      { home: w.home },
    );
    expect(await refused).toBe(2);
    expect(loose.err).toContain('is not an ISO timestamp');
    const owner = testIo(w.root, { kind: 'owner' });
    const wrote = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', '2027-06-01T00:00:00Z'],
      owner,
      { home: w.home },
    );
    expect(await wrote).toBe(0);
    expect(readSendGrants(w.home)).toEqual([
      {
        name: 'builder-at-floor-to-orchestrator-at-floor',
        from: 'builder@floor',
        to: 'orchestrator@floor',
        expires: '2027-06-01T00:00:00Z',
      },
    ]);
  });

  test('the writer refuses to write over a record of another kind', async () => {
    const w = world();
    mkdirSync(grantsFolder(w.home), { recursive: true });
    writeFileSync(join(grantsFolder(w.home), 'occupied.yaml'), 'entity: floor\n');
    const owner = testIo(w.root, { kind: 'owner' });
    const code = runGrant(
      ['--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', FUTURE, '--name', 'occupied'],
      owner,
      { home: w.home },
    );
    expect(await code).toBe(2);
    expect(owner.err).toContain('occupied');
    expect(readFileSync(join(grantsFolder(w.home), 'occupied.yaml'), 'utf8')).toBe('entity: floor\n');
  });
});

describe('the send-grant reader', () => {
  test('readSendGrants hands over verified records only', () => {
    const w = world();
    signSendRecord(w.home, 'good', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE });
    unsignedSendRecord(w.home, 'unsigned', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE });
    const elsewhere = join(base, 'other-home');
    mkdirSync(elsewhere, { recursive: true });
    signSendRecord(w.home, 'forged', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE }, { keyHome: elsewhere });
    writeFileSync(join(grantsFolder(w.home), 'no-send.yaml'), `expires: "${FUTURE}"\n`);
    expect(readSendGrants(w.home)).toEqual([{ name: 'good', from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE }]);
  });

  test('the detailed read classifies each send-shaped record for the refusal', () => {
    const w = world();
    signSendRecord(w.home, 'good', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE });
    unsignedSendRecord(w.home, 'unsigned', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE });
    const elsewhere = join(base, 'other-home');
    mkdirSync(elsewhere, { recursive: true });
    signSendRecord(w.home, 'forged', { from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE }, { keyHome: elsewhere });
    const reads = readSendGrantReads(w.home).map((read) => ({ name: read.name, state: read.state }));
    expect(reads).toEqual([
      { name: 'forged', state: 'bad-signature' },
      { name: 'good', state: 'verified' },
      { name: 'unsigned', state: 'unsigned' },
    ]);
  });

  test('a record that names itself is signed under that name', () => {
    const w = world();
    const key = keyOf(w.home);
    const folder = grantsFolder(w.home);
    mkdirSync(folder, { recursive: true });
    const payload = { name: 'the review channel', send: { from: 'builder@floor', to: 'lead@teamcli' }, expires: FUTURE };
    writeFileSync(
      join(folder, 'named.json'),
      JSON.stringify({ name: 'the review channel', send: payload.send, expires: FUTURE, signature: signDomain(DOMAIN, payload, key) }),
    );
    expect(readSendGrants(w.home)).toEqual([{ name: 'the review channel', from: 'builder@floor', to: 'lead@teamcli', expires: FUTURE }]);
  });
});

describe('the general door', () => {
  // A child process, not `main` in this one: the owner home is read through `homedir()`, which
  // this runner fixes at its own start, so only a child with HOME set is the synthetic home.
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  async function runCli(args: string[], on: { cwd: string; home: string }): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, cli, ...args], {
      cwd: on.cwd, env: { ...process.env, HOME: on.home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  }

  test('admits team grant --send as the owner, with no prompt', async () => {
    // The client-key guard refuses a key folder under the OS temp directory, so this world sits
    // beside the checkout and is removed by afterEach like every other one.
    const w = world({ under: process.cwd() });
    const pair = newClientKeyPair();
    const keys = writeClientKeyFiles(join(w.home, '.config', 'team-client', 'proof'), pair);
    if (!keys.ok) throw new Error(keys.why);
    const grant = issueOwnerGeneralGrant(w.home, {
      clientId: 'proof', publicKey: pair.publicKey, entities: ['*'], ops: ['grant'], mayIssue: false,
      expires: new Date(Date.now() + 86_400_000),
    });
    if (!grant.ok) throw new Error(grant.why);
    const plain = join(base, 'plain');
    mkdirSync(plain, { recursive: true });
    const line = ['grant', '--send', '--from', 'builder@floor', '--to', 'orchestrator@floor', '--expires', FUTURE];
    const dry = await runCli([...line, '--dry-run', '--general', grant.path, '--key', keys.keyPath], { cwd: plain, home: w.home });
    expect(dry.code).toBe(0);
    expect(dry.err).toContain('admitted by general grant');
    expect(dry.out).toContain('would write the send grant builder-at-floor-to-orchestrator-at-floor');
    expect(readSendGrants(w.home)).toEqual([]);
    const wrote = await runCli([...line, '--general', grant.path, '--key', keys.keyPath], { cwd: plain, home: w.home });
    expect(wrote.code).toBe(0);
    expect(wrote.out).toContain('grant: updated');
    expect(readSendGrants(w.home)).toEqual([
      { name: 'builder-at-floor-to-orchestrator-at-floor', from: 'builder@floor', to: 'orchestrator@floor', expires: FUTURE },
    ]);
  }, 30_000);
});
