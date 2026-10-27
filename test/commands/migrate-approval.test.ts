// `team migrate` through the owner seat: a dry run needs no one, a real run waits for a signature
// bound to this record, and a denial, a bad signature, or a changed file writes nothing.
// Hermetic: a temporary HOME, an in-memory credential store, never ~/.config/team.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { approveOwnerAction, OWNER_ACTION_TTL_MS, readOwnerActionRecord } from '../../src/client/owner-action.ts';
import { ownerSeatMessages, readOwnerSeat, signOwnerAnswer } from '../../src/client/owner-seat.ts';
import { actionRequestsFolder } from '../../src/client/team-create.ts';
import { runMigrate } from '../../src/commands/migrate.ts';
import { canonicalTeam, readTeamConfig } from '../../src/file/team-config.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { Io } from '../../src/io.ts';
import { sha256, teamConfigDir } from '../../src/registry/team-config-store.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import { seatOwner } from '../helpers/owner-seat.ts';

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-10-26T12:00:00.000Z');
const agent: Caller = { kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' };
const detached: Caller = { kind: 'owner-no-tty' };
const seat: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const owner: Caller = { kind: 'owner' };
const self: Caller = { kind: 'seat', name: 'mac', pane: 'w9:p1', session: 'acme' };

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const EXTRA_SEAT = `  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function place(text = TEAM) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'migrate-approval-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'code', 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  return { base, home, root, file: join(root, '.agents', 'team.yaml') };
}

function ioOf(root: string, caller: Caller): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(text: string) { io.out += text; },
    stderr(text: string) { io.err += text; },
    cwd: root,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    caller,
  };
  return io;
}

function recordOf(root: string, home: string): { team: string; id: string; project: string; seats: number; record: string } {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return {
    team: loaded.team.project,
    id: teamIdOf(loaded.root),
    project: loaded.team.inProject ?? loaded.team.project,
    seats: loaded.team.seats.length,
    record: sha256(canonicalTeam(loaded.team)),
  };
}

function requestId(text: string): string {
  return /owner-seat request (oa_[0-9a-f]{24})/.exec(text)?.[1] ?? '';
}

describe('team migrate through the owner seat', () => {
  test('a dry run needs no owner and writes nothing', async () => {
    for (const caller of [seat, detached, agent]) {
      const p = place();
      mkdirSync(join(p.home, '.config', 'team'), { recursive: true });
      writeFileSync(join(p.home, '.config', 'team', 'charter.json'), '{}\n');
      const io = ioOf(p.root, caller);
      expect(await runMigrate(['--dry-run'], io, { home: p.home, now: () => NOW }), io.err).toBe(0);
      expect(io.out).toContain('nothing written');
      expect(existsSync(teamConfigDir(p.home))).toBe(false);
      expect(existsSync(actionRequestsFolder(p.home))).toBe(false);
    }
  });

  test('an approved migrate imports the record the card named', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const facts = recordOf(p.root, p.home);
    const io = ioOf(p.root, agent);
    const code = await runMigrate([], io, {
      home: p.home,
      now: () => NOW,
      ownerSeatStore: store,
      onOwnerRequest: (id) => { expect(approveOwnerAction(p.home, id, 'oui', store, NOW)).toMatchObject({ ok: true }); },
    });
    expect(code, io.err + io.out).toBe(0);
    expect(io.out).toContain('read back and verified');
    expect(io.out).toContain(`team "${facts.team}" (${facts.id})`);
    expect(io.out).toContain(`project "${facts.project}"`);
    expect(io.out).toContain('1 seat');
    expect(io.out).toContain(facts.record);
    expect(io.out).toContain('The file is retired after the record verifies.');
    expect(io.err).toContain('signed by mac');
    const id = requestId(io.out);
    expect(existsSync(join(actionRequestsFolder(p.home), `${id}.used-team-migrate`))).toBe(true);
    expect(existsSync(p.file)).toBe(false);
    expect(existsSync(`${p.file}.migrated`)).toBe(true);
    const held = readTeamConfig(p.root, { home: p.home, source: 'registry' });
    expect(held.ok && held.team.project).toBe('acme');
    const card = ownerSeatMessages(p.home).map((message) => message.text).join('\n');
    expect(card).toContain(facts.record);
    expect(card).toContain('1 seat');
  });

  test('--keep-file leaves the file, and the same approval cannot be spent again', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const io = ioOf(p.root, agent);
    expect(await runMigrate(['--keep-file'], io, {
      home: p.home,
      now: () => NOW,
      ownerSeatStore: store,
      onOwnerRequest: (id) => { expect(approveOwnerAction(p.home, id, 'oui', store, NOW).ok).toBe(true); },
    }), io.err).toBe(0);
    expect(io.out).toContain('The file stays.');
    expect(existsSync(p.file)).toBe(true);
    const id = requestId(io.out);
    rmSync(teamConfigDir(p.home), { recursive: true, force: true });
    const again = ioOf(p.root, agent);
    expect(await runMigrate(['--keep-file', '--approval', id], again, { home: p.home, now: () => NOW, ownerSeatStore: store })).toBe(1);
    expect(again.err).toContain('single-use');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
  });

  test('a denial writes nothing', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const io = ioOf(p.root, agent);
    const code = await runMigrate([], io, {
      home: p.home,
      now: () => NOW,
      ownerSeatStore: store,
      onOwnerRequest: (id) => { expect(approveOwnerAction(p.home, id, 'non', store, NOW).ok).toBe(true); },
    });
    expect(code).toBe(1);
    expect(io.err).toContain('denied');
    expect(existsSync(p.file)).toBe(true);
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
  });

  test('a tampered signature writes nothing', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const io = ioOf(p.root, agent);
    const code = await runMigrate([], io, {
      home: p.home,
      now: () => NOW,
      ownerSeatStore: store,
      onOwnerRequest: (id) => {
        expect(approveOwnerAction(p.home, id, 'oui', store, NOW).ok).toBe(true);
        const path = join(actionRequestsFolder(p.home), `${id}.seat-answer.json`);
        const signed = JSON.parse(readFileSync(path, 'utf8')) as { signature: string };
        const flipped = signed.signature[0] === 'a' ? 'b' : 'a';
        signed.signature = flipped + signed.signature.slice(1);
        writeFileSync(path, `${JSON.stringify(signed)}\n`);
      },
    });
    expect(code).toBe(1);
    expect(io.err).toContain('does not verify');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
    expect(existsSync(p.file)).toBe(true);
  });

  test('a file that changes after the signature is not the record that was approved', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const io = ioOf(p.root, agent);
    const code = await runMigrate([], io, {
      home: p.home,
      now: () => NOW,
      ownerSeatStore: store,
      onOwnerRequest: (id) => {
        expect(approveOwnerAction(p.home, id, 'oui', store, NOW).ok).toBe(true);
        writeFileSync(p.file, TEAM + EXTRA_SEAT);
      },
    });
    expect(code).toBe(1);
    expect(io.err).toContain('other team-migrate arguments');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
  });

  test('an expired request writes nothing', async () => {
    const p = place();
    const store = seatOwner(p.home);
    let now = NOW;
    const io = ioOf(p.root, agent);
    const code = await runMigrate([], io, {
      home: p.home,
      now: () => now,
      ownerSeatStore: store,
      onOwnerRequest: () => { now = new Date(NOW.getTime() + OWNER_ACTION_TTL_MS + 1); },
    });
    expect(code).toBe(1);
    expect(io.err).toContain('expired');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
    expect(existsSync(p.file)).toBe(true);
  });

  test('a signer does not approve a request they asked for', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const io = ioOf(p.root, self);
    const code = await runMigrate([], io, {
      home: p.home,
      now: () => NOW,
      ownerSeatStore: store,
      onOwnerRequest: (id) => {
        expect(approveOwnerAction(p.home, id, 'oui', store, NOW)).toEqual({
          ok: false,
          why: `signer "mac" asked for request ${id}; no principal approves its own request`,
        });
        const record = readOwnerActionRecord(p.home, id);
        if (typeof record === 'string') throw new Error(record);
        const seatRecord = readOwnerSeat(p.home);
        if (seatRecord === null) throw new Error('no seat');
        const signed = signOwnerAnswer(p.home, {
          kind: 'owner-action',
          request_id: id,
          params_sha256: record.params_sha256,
          choice: 'once',
          team: seatRecord.team,
          seat: 'owner',
          at: NOW.toISOString(),
        }, 'mac', store, 'self');
        if (!signed.ok) throw new Error(signed.why);
        writeFileSync(join(actionRequestsFolder(p.home), `${id}.seat-answer.json`), `${JSON.stringify(signed.signed)}\n`);
      },
    });
    expect(code).toBe(1);
    expect(io.err).toContain('no principal approves its own request');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
  });

  test('a team the registry already holds is not asked again when the file differs or is gone', async () => {
    const p = place();
    const ownerIo = ioOf(p.root, owner);
    expect(await runMigrate(['--keep-file'], ownerIo, { home: p.home, now: () => NOW }), ownerIo.err).toBe(0);
    writeFileSync(p.file, TEAM.replace('project: acme', 'project: acme-other'));
    const before = readTeamConfig(p.root, { home: p.home, source: 'registry' });
    const differing = ioOf(p.root, agent);
    expect(await runMigrate([], differing, { home: p.home, now: () => NOW })).toBe(1);
    expect(differing.err).toContain('team import');
    expect(existsSync(actionRequestsFolder(p.home))).toBe(false);
    const after = readTeamConfig(p.root, { home: p.home, source: 'registry' });
    if (!before.ok || !after.ok) throw new Error('the registry record was not readable');
    expect(sha256(canonicalTeam(after.team))).toBe(sha256(canonicalTeam(before.team)));

    const gone = place();
    expect(await runMigrate([], ioOf(gone.root, owner), { home: gone.home, now: () => NOW })).toBe(0);
    expect(existsSync(gone.file)).toBe(false);
    const again = ioOf(gone.root, agent);
    expect(await runMigrate([], again, { home: gone.home, now: () => NOW }), again.err).toBe(0);
    expect(again.out).toContain('already holds');
    expect(existsSync(actionRequestsFolder(gone.home))).toBe(false);
  });

  test('--request records a card and does not import; a bad approval writes nothing', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const io = ioOf(p.root, agent);
    expect(await runMigrate(['--request'], io, { home: p.home, now: () => NOW, ownerSeatStore: store }), io.err).toBe(0);
    expect(io.out).toContain('owner-seat request');
    expect(requestId(io.out)).not.toBe('');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
    const bad = ioOf(p.root, agent);
    expect(await runMigrate(['--approval', 'oa_nope'], bad, { home: p.home, now: () => NOW, ownerSeatStore: store })).toBe(1);
    expect(bad.err).toContain('is not an owner-seat request id');
    expect(existsSync(p.file)).toBe(true);
  });

  test('an always rule does not skip the card', async () => {
    const p = place();
    const store = seatOwner(p.home);
    const asked = ioOf(p.root, agent);
    expect(await runMigrate(['--request'], asked, { home: p.home, now: () => NOW, ownerSeatStore: store })).toBe(0);
    expect(approveOwnerAction(p.home, requestId(asked.out), 'always', store, NOW)).toMatchObject({ ok: true, choice: 'always' });
    const io = ioOf(p.root, agent);
    const code = await runMigrate([], io, { home: p.home, now: () => NOW, ownerSeatStore: store, onOwnerRequest: () => {} });
    expect(code).toBe(1);
    expect(io.err).toContain('always rule does not migrate');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
    expect(existsSync(p.file)).toBe(true);
  });

  test('the owner at a terminal still migrates with no card', async () => {
    const p = place();
    const io = ioOf(p.root, owner);
    expect(await runMigrate([], io, { home: p.home, now: () => NOW }), io.err).toBe(0);
    expect(io.out).toContain('read back and verified');
    expect(io.out).not.toContain('owner-seat request');
    expect(existsSync(actionRequestsFolder(p.home))).toBe(false);
    expect(existsSync(`${p.file}.migrated`)).toBe(true);
  });

  test('--request and --approval together are refused', async () => {
    const p = place();
    seatOwner(p.home);
    const io = ioOf(p.root, agent);
    expect(await runMigrate(['--request', '--approval', 'oa_0123456789abcdef01234567'], io, { home: p.home, now: () => NOW })).toBe(1);
    expect(io.err).toContain('pass one');
    expect(existsSync(teamConfigDir(p.home))).toBe(false);
  });
});
