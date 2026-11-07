// Every path and transport in these scenes is synthetic; no live inbox or endpoint is used.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readStateFile, writeStateFile } from '../src/file-write.ts';
import { postArrivalWebhook } from '../src/bus/webhook.ts';
import { deferredNotePathOf, fallbackKeyOf, noteTransportSoon, type TransportFact } from '../src/send/fallback-events.ts';
import { historyPath } from '../src/send/history.ts';
import { clearUnread, noteUnread, readUnreadHint } from '../src/send/unread-hint.ts';
import { signRecord } from '../src/send/record.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-write-one-'))); dirs.push(base);
  const root = join(base, 'repo'); const home = join(base, 'home');
  const drop = join(root, '.agents', 'send-drops', 'session', 'worker');
  mkdirSync(drop, { recursive: true }); mkdirSync(home);
  return { base, root, home, drop };
}
function planted(base: string, path: string, dangling: boolean) {
  const outside = join(base, 'outside');
  if (!dangling) writeFileSync(outside, 'unchanged');
  symlinkSync(outside, path);
  return () => {
    expect(existsSync(outside)).toBe(!dangling);
    if (!dangling) expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  };
}
async function post(at: ReturnType<typeof fixture>, effect: () => void = () => {}) {
  const urlFile = join(at.base, 'url'); const secretFile = join(at.base, 'secret');
  writeFileSync(urlFile, 'https://fixture.invalid/receive'); writeFileSync(secretFile, 'synthetic-value', { mode: 0o600 });
  const message = signRecord({ kind: 'message', id: 'record', to: 'worker', to_id: null, root: at.root,
    session: 'session', at: '2026-11-07T00:00:00.000Z', body: 'fixture', from: 'lead', from_id: null,
    rule: 'synthetic', thread: 'record' }, at.home);
  return postArrivalWebhook({ seat: 'worker', webhook: { urlFile, secretFile, body: 'inbox' }, root: at.root,
    session: 'session', id: 'record', from: 'lead', message, dropDir: at.drop, home: at.home,
    now: () => new Date('2026-11-07T00:00:00.000Z'),
    fetch: (async () => { effect(); return new Response('ok'); }) as unknown as typeof fetch });
}

function deferred(at: ReturnType<typeof fixture>) {
  const parsed = validateTeamFile(`format: 1\nproject: fixture\nsession: session\ncoordinator: lead\noperator: lead\nworkspace:\n  mode: shared\nseats:\n  - name: lead\n    role: coordinator\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\n`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const caller = { kind: 'seat' as const, name: 'lead', pane: 'fixture-window:fixture-pane', session: 'session' };
  const fact: TransportFact = { recipient: { team: 'fixture', seat: 'worker', toId: null, session: 'session', root: at.root },
    messageId: 'record', recordDigest: 'a'.repeat(64), route: 'socket', outcome: 'unreachable',
    at: '2026-11-07T00:00:00.000Z', ms: 1, reason: 'synthetic refusal', liveRoutesRemain: false };
  const hash = createHash('sha256').update(fallbackKeyOf(fact.recipient, fact.messageId)).digest('hex').slice(0, 16);
  const lock = join(dirname(historyPath('fixture', at.root, at.home)), 'locks', `fallback-${hash}`);
  mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'team.lock'), `${process.pid}\n`);
  const text = JSON.stringify({ format: 1, sender: 'lead', fact });
  const factId = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const path = deferredNotePathOf(fact.recipient, fact.messageId, factId);
  return { path, fact, ctx: { caller, team: parsed.team, root: at.root, home: at.home, now: () => new Date(fact.at) } };
}

for (const dangling of [false, true]) {
  test(`A3 posted-mark fallback leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, async () => {
    const at = fixture(); const unchanged = planted(at.base, join(at.drop, '.record.posted.tmp'), dangling);
    expect((await post(at, () => unlinkSync(join(at.drop, 'record.posting')))).kind).toBe('posted');
    unchanged(); expect(lstatSync(join(at.drop, 'record.posted')).isFile()).toBe(true);
  });
  test(`A4 claim rewrite leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, async () => {
    const at = fixture(); const unchanged = planted(at.base, join(at.drop, '.record.posting.tmp'), dangling);
    expect((await post(at)).kind).toBe('posted'); unchanged();
    expect(lstatSync(join(at.drop, 'record.posted')).isFile()).toBe(true);
  });
  test(`A5 unread hint leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const unchanged = planted(at.base, join(at.drop, `.unread.json.${process.pid}.tmp`), dangling);
    noteUnread(at.drop, 'lead', 'record', '2026-11-07T00:00:00.000Z', { held: true });
    unchanged(); expect(readUnreadHint(at.drop, 'lead').map(entry => entry.id)).toEqual(['record']);
  });
  test(`A6 deferred note leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const { path, fact, ctx } = deferred(at);
    const unchanged = planted(at.base, `${path}.${process.pid}.tmp`, dangling);
    const note = noteTransportSoon(ctx, fact);
    expect(note.ok).toBe(true); if (!note.ok) throw new Error(note.reason);
    expect(note.state).toBe('deferred'); unchanged(); expect(lstatSync(path).isFile()).toBe(true);
  });
}

for (const dangling of [false, true]) {
  test(`A4 refuses a planted claim leaf (${dangling ? 'dangling' : 'live'})`, async () => {
    const at = fixture(); const unchanged = planted(at.base, join(at.drop, 'record.posting'), dangling);
    let posted = false; expect((await post(at, () => { posted = true; })).kind).toBe('none');
    expect(posted).toBe(false); unchanged();
  });
  test(`A3 fallback refuses a planted posted leaf (${dangling ? 'dangling' : 'live'})`, async () => {
    const at = fixture(); let unchanged: (() => void) | undefined;
    await post(at, () => {
      unlinkSync(join(at.drop, 'record.posting'));
      unchanged = planted(at.base, join(at.drop, 'record.posted'), dangling);
    });
    expect(unchanged).toBeDefined(); unchanged!();
  });
  test(`A5 hint refuses a planted final leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const unchanged = planted(at.base, join(at.drop, '.unread.json'), dangling);
    noteUnread(at.drop, 'lead', 'record', '2026-11-07T00:00:00.000Z', { held: true });
    unchanged(); expect(readUnreadHint(at.drop, 'lead')).toEqual([]);
  });
}
test('the publisher and reader refuse linked leaves, hard links, and linked parents', () => {
  const at = fixture(); const target = join(at.base, 'outside'); writeFileSync(target, 'unchanged');
  const path = join(at.drop, 'linked'); symlinkSync(target, path);
  expect(() => writeStateFile(path, 'replacement')).toThrow();
  expect(() => readStateFile(path)).toThrow();
  const hard = join(at.drop, 'hard'); linkSync(target, hard);
  expect(() => writeStateFile(hard, 'replacement')).toThrow();
  expect(() => readStateFile(hard)).toThrow();
  const alias = join(at.drop, 'alias'); symlinkSync(at.base, alias);
  expect(() => writeStateFile(join(alias, 'outside'), 'replacement')).toThrow();
  expect(() => readStateFile(join(alias, 'outside'))).toThrow();
  expect(readFileSync(target, 'utf8')).toBe('unchanged');
});
test('a regular file can be published and replaced with no temporary left over', () => {
  const at = fixture(); const path = join(at.drop, 'plain');
  expect(readStateFile(path)).toBeNull();
  writeStateFile(path, 'first'); writeStateFile(path, 'second');
  expect(readStateFile(path)).toBe('second'); expect(lstatSync(path).mode & 0o777).toBe(0o600);
});

for (const dangling of [false, true]) {
  test(`A6 deferred note refuses a planted final leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const { path, fact, ctx } = deferred(at);
    const unchanged = planted(at.base, path, dangling);
    expect(noteTransportSoon(ctx, fact).ok).toBe(false); unchanged();
  });
}

test('an explicit root accepts an alias only above it and refuses links at or below it', () => {
  const at = fixture(); const physical = join(at.base, 'physical'); const root = join(physical, 'project');
  mkdirSync(join(root, 'state'), { recursive: true });
  const alias = join(at.base, 'alias-above'); symlinkSync(physical, alias);
  writeStateFile(join(alias, 'project', 'state', 'record'), 'allowed', { root: join(alias, 'project') });
  expect(readFileSync(join(root, 'state', 'record'), 'utf8')).toBe('allowed');
  const linkedRoot = join(at.base, 'linked-root'); symlinkSync(root, linkedRoot);
  expect(() => writeStateFile(join(linkedRoot, 'record'), 'refused', { root: linkedRoot })).toThrow();
  const outside = join(at.base, 'outside-folder'); mkdirSync(outside); mkdirSync(join(outside, 'nested'));
  symlinkSync(outside, join(root, 'linked-child'));
  expect(() => writeStateFile(join(root, 'linked-child', 'nested', 'record'), 'refused', { root })).toThrow();
  expect(existsSync(join(outside, 'nested', 'record'))).toBe(false);
});
test('unread writes report one refusal and return its visible outcome', () => {
  const at = fixture(); const unchanged = planted(at.base, join(at.drop, '.unread.json'), false);
  const say = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    for (let n = 0; n < 2; n++) {
      expect(noteUnread(at.drop, 'lead', 'record', '2026-11-07T00:00:00.000Z', { held: true })).toEqual({ ok: false, kind: 'refused', reason: 'the unread hint could not be written safely' });
      expect(clearUnread(at.drop, 'record')).toEqual({ ok: false, kind: 'refused', reason: 'the unread hint could not be written safely' });
    }
    expect(say).toHaveBeenCalledTimes(1); expect(String(say.mock.calls[0]?.[0])).toContain('unread hint'); unchanged();
  } finally { say.mockRestore(); }
});
