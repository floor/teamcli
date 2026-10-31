// The owner-seat door for a team whose root is a plain folder. The registry's record is keyed by
// that folder, so `team config get` reads the team there; the door must name the same root and
// team, and a request must still wait for the owner seat's answer before anything is written.
// Every scene keeps its registry and its owner seat under its own temp home; no real team file,
// grant or key is read or written.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveOwnerAction } from '../src/client/owner-action.ts';
import { actionRequestsFolder } from '../src/client/team-create.ts';
import { realSources, runAdd } from '../src/commands/add.ts';
import { runConfig } from '../src/commands/config.ts';
import { findRoot } from '../src/file/load.ts';
import { readAgents } from '../src/registry/agents.ts';
import { seatOwner } from './helpers/owner-seat.ts';
import { intoRegistry, storedTeam, underRegistry } from './helpers/registry-team.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-31T12:00:00.000Z');

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
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
delivery_order: [mcp-inbox, typed]
`;

type Place = { base: string; home: string; root: string; store: ReturnType<typeof seatOwner> };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A team in `home`'s registry whose root is a temp folder: a plain folder, or a git checkout. Its
 *  team file is retired after the import, as `team migrate` leaves it, so only the record is read. */
function place(options: { git: boolean }): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-root-independent-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  if (options.git) execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  intoRegistry(root, home);
  renameSync(join(root, '.agents', 'team.yaml'), join(root, '.agents', 'team.yaml.migrated'));
  return { base, home, root, store: seatOwner(home) };
}

function configSources(at: Place) {
  return { home: at.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: at.store };
}

function addSources(at: Place) {
  return { ...realSources, home: at.home, ownerSeatStore: at.store, now: () => NOW };
}

function requestId(text: string): string {
  return /owner-seat request (oa_[0-9a-f]{24})/.exec(text)?.[1] ?? '';
}

function requestOf(home: string, id: string): { params: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(actionRequestsFolder(home), `${id}.json`), 'utf8'));
}

describe('a team whose root is a plain folder', () => {
  test('config set --request files the change, and nothing is written before its approval', async () => {
    const at = place({ git: false });
    expect(findRoot(at.root)).toBeNull();
    await underRegistry(async () => {
      const sources = configSources(at);
      const before = storedTeam(at.root, at.home)!.text;
      // config get reads this folder's team: the record the door must name.
      const read = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['get', 'project'], read, sources), read.err).toBe(0);
      expect(read.out).toBe('acme\n');

      const ask = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'project', 'other', '--request'], ask, sources), ask.err).toBe(0);
      const id = requestId(ask.out);
      expect(id).not.toBe('');
      const request = requestOf(at.home, id);
      expect(request.params).toMatchObject({ root: at.root, team: 'acme', head: null });
      expect(request.params.words).toEqual({ 'team-config': ['set', 'project', 'other'] });
      // Nothing is written before the owner seat answers.
      expect(storedTeam(at.root, at.home)!.text).toBe(before);
      expect(existsSync(join(at.root, '.agents', 'team.yaml'))).toBe(false);
      // An approval run with no answer applies nothing.
      const early = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'project', 'other', '--approval', id], early, sources)).toBe(1);
      expect(storedTeam(at.root, at.home)!.text).toBe(before);

      expect(approveOwnerAction(at.home, id, 'oui', at.store, NOW)).toMatchObject({ ok: true });
      const ran = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'project', 'other', '--approval', id], ran, sources), ran.err + ran.out).toBe(0);
      expect(storedTeam(at.root, at.home)!.text).toContain('\nproject: other\n');
      const got = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['get', 'project'], got, sources), got.err).toBe(0);
      expect(got.out).toBe('other\n');
    });
  });

  test('config unset --request files the removal, and its approval applies it', async () => {
    const at = place({ git: false });
    await underRegistry(async () => {
      const sources = configSources(at);
      const before = storedTeam(at.root, at.home)!.text;
      const ask = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['unset', 'session', '--request'], ask, sources), ask.err).toBe(0);
      const id = requestId(ask.out);
      expect(id).not.toBe('');
      const request = requestOf(at.home, id);
      expect(request.params).toMatchObject({ root: at.root, team: 'acme', head: null });
      expect(request.params.words).toEqual({ 'team-config': ['unset', 'session'] });
      expect(storedTeam(at.root, at.home)!.text).toBe(before);

      expect(approveOwnerAction(at.home, id, 'oui', at.store, NOW)).toMatchObject({ ok: true });
      const ran = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['unset', 'session', '--approval', id], ran, sources), ran.err + ran.out).toBe(0);
      expect(storedTeam(at.root, at.home)!.text).not.toContain('session: acme');
      const got = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['get', 'session'], got, sources)).toBe(1);
      expect(got.err).toContain("session is not set in the registry's record");
    });
  });

  test('add --request files the seat it would start, and writes nothing', async () => {
    const at = place({ git: false });
    expect(findRoot(at.root)).toBeNull();
    await underRegistry(async () => {
      const sources = addSources(at);
      const before = storedTeam(at.root, at.home)!.text;
      const io = testIo(at.root, { kind: 'owner' });
      expect(await runAdd(['worker', '--like', 'lead', '--request'], io, sources), io.err).toBe(0);
      const id = requestId(io.out);
      expect(id).not.toBe('');
      const request = requestOf(at.home, id);
      expect(request.params).toMatchObject({ root: at.root, team: 'acme', head: null });
      expect(request.params.words).toEqual({ 'team-add': ['worker', '--like', 'lead'] });
      expect(storedTeam(at.root, at.home)!.text).toBe(before);
      expect(readAgents(at.home)).toEqual([]);
      expect(existsSync(join(at.root, '.agents', 'team.yaml'))).toBe(false);
    });
  });
});

describe('the unchanged gates', () => {
  test('a git root still files and applies the same request', async () => {
    const at = place({ git: true });
    expect(findRoot(at.root)).toBe(at.root);
    await underRegistry(async () => {
      const sources = configSources(at);
      const before = storedTeam(at.root, at.home)!.text;
      const ask = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'project', 'other', '--request'], ask, sources), ask.err).toBe(0);
      const id = requestId(ask.out);
      expect(id).not.toBe('');
      expect(requestOf(at.home, id).params).toMatchObject({ root: at.root, team: 'acme', head: null });
      expect(storedTeam(at.root, at.home)!.text).toBe(before);
      expect(approveOwnerAction(at.home, id, 'oui', at.store, NOW)).toMatchObject({ ok: true });
      const ran = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'project', 'other', '--approval', id], ran, sources), ran.err + ran.out).toBe(0);
      const got = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['get', 'project'], got, sources)).toBe(0);
      expect(got.out).toBe('other\n');
    });
  });

  test('a folder that is not any team root still refuses, and files no request', async () => {
    const at = place({ git: false });
    const folder = join(at.base, 'nothing');
    mkdirSync(folder, { recursive: true });
    await underRegistry(async () => {
      const io = testIo(folder, { kind: 'owner' });
      expect(await runConfig(['set', 'project', 'other', '--request'], io, configSources(at))).toBe(2);
      expect(io.err).toContain(`no team is registered for ${folder}`);
      expect(existsSync(actionRequestsFolder(at.home))).toBe(false);
    });
  });

  test('a trust value that is not a list is refused through the door, and nothing is written', async () => {
    const at = place({ git: true });
    await underRegistry(async () => {
      const sources = configSources(at);
      const before = storedTeam(at.root, at.home)!.text;
      const ask = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'trust.0', at.root, '--request'], ask, sources), ask.err).toBe(0);
      const id = requestId(ask.out);
      expect(id).not.toBe('');
      expect(approveOwnerAction(at.home, id, 'oui', at.store, NOW)).toMatchObject({ ok: true });
      const ran = testIo(at.root, { kind: 'owner' });
      expect(await runConfig(['set', 'trust.0', at.root, '--approval', id], ran, sources)).toBe(1);
      expect(ran.err).toContain('trust must be a list');
      expect(storedTeam(at.root, at.home)!.text).toBe(before);
    });
  });
});
