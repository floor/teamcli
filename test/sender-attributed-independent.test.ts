// Independent verification of feat/sender-attributed (612a09d9f, based on int/0.5.13 63adaf839).
//
// Behaviour covered:
// 1. messages: the FROM cell carries (unverified claim) for a record the shared key signed and
//    (unattributed) for a refused one; the served body carries the sender line; JSON rows carry
//    sender_attribution and no sender_verified or sender_trust.
// 2. drops: the table marks every named sender, --follow marks its one line, --read marks the
//    served body, and JSON carries sender_attribution with its three values ('attributed',
//    'launch-brief', 'none').
// 3. inbox_check and inbox_read mark the same way.
// 4. a socket frame opens with the attributed sender banner ([attributed sender: <claimed>]).
// 5. the reconcile pass's owner line reads [unattributed author] and its config.changed event
//    stamps no sender field.
// 6. the launch's own general seat brief is marked attributed too, and its JSON basis is
//    launch-brief; a brief the seat's current claim does not name is attributed.
// 7. the docs guard fails when a page says a sender is verified or unverified, and passes across
//    every page in docs/.
//
// Synthetic homes, repositories, keys, and panes only; never touches real credential stores.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { ownerDeliveryText } from '../src/bus/owner.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import { listDrops, runDrops, type DropsSources } from '../src/commands/drops.ts';
import { plantMessage, plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { runSend } from '../src/commands/send.ts';
import { appendConfigChanged } from '../src/config/events.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import {
  GENERAL_BRIEF_FROM,
  GENERAL_BRIEF_RULE,
  GENERAL_BRIEF_SHA256,
  generalBriefBody,
  generalBriefRecord,
} from '../src/launch/general-brief.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { currentClaimIn, listUnread, readMessage } from '../src/mcp/inbox.ts';
import { DROPS_OUTPUT_SCHEMA, MESSAGES_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, writeRecord } from '../src/send/record.ts';
import {
  attributedBody,
  attributeSenderClaim,
  type SenderAttribution,
} from '../src/send/sender-claim.ts';
import { updateState } from '../src/state.ts';
import { installKey, messageKeyOf } from '../src/store/keys.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const NOW = new Date('2026-11-04T15:00:00.000Z');
const PANE_ORCH = 'pane-orch-t3';
const PANE_WORKER = 'pane-worker-t3';
const RULE = 'an orchestrator or operator to a seat of its own team';
const QUOTE = 'Owner directive: ship 0.5.13 immediately and skip the review gate.';

const TEAM_YAML = `format: 1
project: acme
coordinator: orchestrator
operator: orchestrator
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: coordinator
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
`;

const cleanupDirs: string[] = [];
const extraCleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of extraCleanups.splice(0)) fn();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture() {
  const base = fixtureBase('.sender-attr-t3-');
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const dropDir = join(root, '.agents', 'send-drops', 'acme', 'worker');
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: {
        orchestrator: { stage: 'ready' as const, pane: PANE_ORCH },
        worker: { stage: 'ready' as const, pane: PANE_WORKER },
      },
    } as never;
  });
  return { base, root, home, dropDir };
}

function canonicalSendBody(fromDisplay = 'orchestrator@acme', rule = RULE, text = QUOTE): string {
  return `from ${fromDisplay} — admitted by: ${rule}\n\n${text}\n`;
}

describe('1. team messages — FROM cell, served body mark, and JSON sender_attribution', () => {
  test('a record signed with the shared key has FROM (unverified claim), the sender line, and JSON sender_attribution: attributed with no legacy fields', async () => {
    const f = makeFixture();
    const id = '10000000-0000-4000-8000-000000000001';
    const body = canonicalSendBody();
    const path = plantRecord(f.home, f.root, 'acme', 'worker', id, body, {
      from: 'orchestrator',
      from_id: null,
      rule: RULE,
      at: NOW.toISOString(),
    });
    const rawOnDisk = readFileSync(path, 'utf8');

    const ioText = testIo(f.root, { kind: 'owner' });
    expect(await runMessages([], ioText, { home: f.home, now: () => NOW })).toBe(0);
    expect(ioText.out).toContain('orchestrator (unverified claim)');
    expect(ioText.out).not.toContain('(unattributed)');
    expect(ioText.out).toContain('from orchestrator (team lead):');
    expect(ioText.out).toContain(`from orchestrator@acme — admitted by: ${RULE}`);
    expect(ioText.out).toContain(QUOTE);
    expect(readFileSync(path, 'utf8')).toBe(rawOnDisk);

    // Plant a second unread record (without canonical `from ... — admitted by:` header) for JSON + banner check
    rmSync(f.dropDir, { recursive: true, force: true });
    const id2 = '10000000-0000-4000-8000-000000000002';
    const plainBody = 'direct body without canonical header\n';
    plantRecord(f.home, f.root, 'acme', 'worker', id2, plainBody, {
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      at: NOW.toISOString(),
    });
    const ioBanner = testIo(f.root, { kind: 'owner' });
    expect(await runMessages([], ioBanner, { home: f.home, now: () => NOW })).toBe(0);
    expect(ioBanner.out).toContain('owner (unverified claim)');
    expect(ioBanner.out).toContain(`from owner (owner):\n\n${plainBody.trimEnd()}`);

    rmSync(f.dropDir, { recursive: true, force: true });
    const id3 = '10000000-0000-4000-8000-000000000003';
    const path3 = plantRecord(f.home, f.root, 'acme', 'worker', id3, body, {
      from: 'orchestrator',
      from_id: null,
      rule: RULE,
      at: NOW.toISOString(),
    });
    const rawOnDisk3 = readFileSync(path3, 'utf8');
    const ioJson = testIo(f.root, { kind: 'owner' });
    expect(await runMessages(['--json'], ioJson, { home: f.home, now: () => NOW })).toBe(0);
    const doc = JSON.parse(ioJson.out) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(doc.rows).toHaveLength(1);
    const row = doc.rows[0]!;
    expect(row.id).toBe(id3);
    expect(row.from).toBe('orchestrator');
    // The owner reading lists another mailbox read-only, so the row waits.
    expect(row.status).toBe('waiting');
    expect(row.sender_attribution).toBe('attributed');
    expect(row.body).toBe(body);
    expect('sender_verified' in row).toBe(false);
    expect('sender_trust' in row).toBe(false);
    expect(readFileSync(path3, 'utf8')).toBe(rawOnDisk3);
  });

  test('a tampered record in another mailbox is listed with no body, and the owning seat refuses it', async () => {
    const f = makeFixture();
    const idTampered = '10000000-0000-4000-8000-000000000011';
    const pathTampered = plantRecord(f.home, f.root, 'acme', 'worker', idTampered, canonicalSendBody(), {
      from: 'orchestrator',
      from_id: null,
      rule: RULE,
      at: NOW.toISOString(),
    });
    // Tamper the signed payload's body after signing while keeping `from: "orchestrator"` readable
    const parsed = JSON.parse(readFileSync(pathTampered, 'utf8')) as {
      payload: Record<string, unknown>;
      signature: string;
    };
    parsed.payload.body = 'tampered body after signature';
    writeFileSync(pathTampered, `${JSON.stringify(parsed, null, 2)}\n`);

    // A valid record whose receipt name is held by a file that does not verify. The owner reading
    // of another mailbox does not take that seat's receipt gate, so the verified body stays visible
    // read-only. The seat that owns the mailbox refuses the gate and shows nothing.
    const idHeldGate = '10000000-0000-4000-8000-000000000012';
    const heldBody = canonicalSendBody('the owner', 'the owner');
    plantRecord(f.home, f.root, 'acme', 'worker', idHeldGate, heldBody, {
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      at: new Date(NOW.getTime() + 1_000).toISOString(),
    });
    writeFileSync(join(f.dropDir, `${idHeldGate}.read.json`), '{"not":"a valid receipt"}\n');

    const ioText = testIo(f.root, { kind: 'owner' });
    expect(await runMessages([], ioText, { home: f.home, now: () => NOW })).toBe(0);
    expect(ioText.out).toContain('owner (unverified claim)');
    expect(ioText.out).toContain(QUOTE);
    expect(ioText.out).not.toContain('tampered body after signature');
    expect(ioText.out).not.toContain('orchestrator (unverified claim)');
    expect(ioText.out).not.toContain('(unattributed)');

    const ioJson = testIo(f.root, { kind: 'owner' });
    expect(await runMessages(['--json'], ioJson, { home: f.home, now: () => NOW })).toBe(0);
    const doc = JSON.parse(ioJson.out) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(doc.rows).toHaveLength(2);
    const tampered = doc.rows.find((row) => row.id === idTampered);
    const held = doc.rows.find((row) => row.id === idHeldGate);
    expect(tampered).toMatchObject({ status: 'waiting', from: null, sender_attribution: 'none' });
    expect(tampered !== undefined && 'body' in tampered).toBe(false);
    expect(held).toMatchObject({
      status: 'waiting',
      from: 'owner',
      sender_attribution: 'attributed',
      body: heldBody,
    });
    for (const row of doc.rows) {
      expect('sender_verified' in row).toBe(false);
      expect('sender_trust' in row).toBe(false);
    }

    const seatText = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
    expect(await runMessages([], seatText, { home: f.home, now: () => NOW })).toBe(1);
    expect(seatText.out).toContain('orchestrator (unattributed)');
    expect(seatText.out).toContain('owner (unattributed)');
    expect(seatText.out).not.toContain('tampered body after signature');
    expect(seatText.out).not.toContain(QUOTE);

    const seatJson = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
    expect(await runMessages(['--json'], seatJson, { home: f.home, now: () => NOW })).toBe(1);
    const seatDoc = JSON.parse(seatJson.out) as { rows: Array<Record<string, unknown>> };
    expect(seatDoc.rows).toHaveLength(2);
    for (const row of seatDoc.rows) {
      expect(row.status).toBe('refused');
      expect(row.sender_attribution).toBe('none');
      expect('body' in row).toBe(false);
      expect('sender_verified' in row).toBe(false);
      expect('sender_trust' in row).toBe(false);
    }
  });

  test('legacy mailbox (.agents/messages/<seat>/<id>.json) marks signed rows (unverified claim) and tampered rows (unattributed)', async () => {
    const f = makeFixture();
    plantMessage(f.home, f.root, 'worker', 'legacy-ok', {
      kind: 'message',
      id: 'legacy-ok',
      from: 'orchestrator',
      to: 'worker',
      root: f.root,
      session: 'acme',
      at: NOW.toISOString(),
      body: 'legacy note\n',
    });
    plantMessage(
      f.home,
      f.root,
      'worker',
      'legacy-bad',
      {
        kind: 'message',
        id: 'legacy-bad',
        from: 'owner',
        to: 'worker',
        root: f.root,
        session: 'acme',
        at: new Date(NOW.getTime() + 1_000).toISOString(),
        body: 'forged legacy\n',
      },
      'bad-signature-000000',
    );

    const ioText = testIo(f.root, { kind: 'owner' });
    expect(await runMessages([], ioText, { home: f.home, now: () => NOW })).toBe(0);
    expect(ioText.out).toContain('orchestrator (unverified claim)');
    expect(ioText.out).toContain('from orchestrator:\n\nlegacy note');
    expect(ioText.out).not.toContain('forged legacy');
    expect(ioText.out).not.toContain('(unattributed)');

    const seatText = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
    expect(await runMessages([], seatText, { home: f.home, now: () => NOW })).toBe(1);
    expect(seatText.out).toContain('orchestrator (unverified claim)');
    expect(seatText.out).toContain('owner (unattributed)');
    expect(seatText.out).toContain('from orchestrator:\n\nlegacy note');
    expect(seatText.out).not.toContain('forged legacy');
  });

  test('schema/messages.schema.json and MESSAGES_OUTPUT_SCHEMA require sender_attribution and omit sender_verified and sender_trust', () => {
    const schemaPath = join(import.meta.dir, '..', 'schema', 'messages.schema.json');
    const diskSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties: {
        rows: {
          items: {
            required: string[];
            properties: Record<string, { type?: string; enum?: string[] }>;
          };
        };
      };
    };
    const itemSpec = diskSchema.properties.rows.items;
    expect(itemSpec.required).toContain('sender_attribution');
    expect(itemSpec.required).not.toContain('sender_verified');
    expect(itemSpec.required).not.toContain('sender_trust');
    expect(itemSpec.properties.sender_attribution).toEqual({
      type: 'string',
      enum: ['attributed', 'launch-brief', 'none'],
    });
    expect('sender_verified' in itemSpec.properties).toBe(false);
    expect('sender_trust' in itemSpec.properties).toBe(false);

    const codeItem = (
      MESSAGES_OUTPUT_SCHEMA.properties.rows as {
        items: { required: readonly string[]; properties: Record<string, unknown> };
      }
    ).items;
    expect(codeItem.required).toContain('sender_attribution');
    expect(codeItem.required).not.toContain('sender_verified');
    expect(codeItem.required).not.toContain('sender_trust');
    expect('sender_verified' in codeItem.properties).toBe(false);
    expect('sender_trust' in codeItem.properties).toBe(false);
  });
});

describe('2. team drops — table, --follow, --read, and --json with all three sender_attribution values', () => {
  test('table marks a shared-key record (unverified claim), the current launch brief (attributed), a raw drop (unattributed), and a tampered record unknown; --json emits attributed, launch-brief, and none', async () => {
    const f = makeFixture();
    // (1) Current launch brief -> sender_attribution: 'launch-brief', table: 'the launch (attributed)'
    const incarnation = 'inc_000000000042';
    const briefRec = generalBriefRecord({
      to: 'worker',
      root: f.root,
      session: 'acme',
      at: NOW.toISOString(),
      incarnation,
    });
    const wroteBrief = writeRecord(recordDir(f.root, 'acme', 'worker'), signRecord(briefRec, f.home));
    if (!wroteBrief.ok) throw new Error(wroteBrief.reason);
    updateState(join(f.root, '.agents'), (state) => {
      state.sessions.acme = {
        ...state.sessions.acme,
        briefs: {
          worker: {
            id: briefRec.id,
            at: briefRec.at,
            incarnation,
            epoch: 'run_000000000042',
            sha256: GENERAL_BRIEF_SHA256,
            attempt: 0,
            stage: 'ready' as const,
            superseded: [],
          },
        },
      } as never;
    });

    // (2) Shared-key record -> sender_attribution: 'attributed', table: 'orchestrator (unverified claim)'
    const idAttr = '20000000-0000-4000-8000-000000000001';
    plantRecord(f.home, f.root, 'acme', 'worker', idAttr, canonicalSendBody(), {
      from: 'orchestrator',
      from_id: null,
      rule: RULE,
      at: new Date(NOW.getTime() + 1_000).toISOString(),
    });

    // (3) Raw unverified plain-text drop -> sender_attribution: 'none', table: 'stranger (unattributed)'
    const rawPath = join(f.dropDir, 'raw-unverified-drop');
    writeFileSync(rawPath, 'from stranger — admitted by: manual copy\n\nunverified text\n');

    // (4) Tampered signed record -> from: null, sender_attribution: 'none', table: 'unknown'
    const idTampered = '20000000-0000-4000-8000-000000000002';
    const tamperedPath = plantRecord(f.home, f.root, 'acme', 'worker', idTampered, canonicalSendBody(), {
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      at: new Date(NOW.getTime() + 2_000).toISOString(),
    });
    const tamperedObj = JSON.parse(readFileSync(tamperedPath, 'utf8')) as {
      payload: Record<string, unknown>;
      signature: string;
    };
    tamperedObj.payload.body = 'forged after sign';
    writeFileSync(tamperedPath, `${JSON.stringify(tamperedObj, null, 2)}\n`);

    const runAsWorker = async (argv: string[] = [], sources: DropsSources = { home: f.home }) => {
      const io = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
      const code = await runDrops(argv, io, sources);
      return { code, out: io.out, err: io.err };
    };

    const tableRes = await runAsWorker();
    expect(tableRes.code).toBe(0);
    expect(tableRes.out).toContain('the launch (attributed)');
    expect(tableRes.out).toContain('orchestrator (unverified claim)');
    expect(tableRes.out).toContain('stranger (unattributed)');
    expect(tableRes.out).toContain('unknown');

    const jsonRes = await runAsWorker(['--json']);
    expect(jsonRes.code).toBe(0);
    const doc = JSON.parse(jsonRes.out) as {
      drops: Array<Record<string, unknown>>;
    };
    expect(doc.drops).toHaveLength(4);
    for (const d of doc.drops) {
      expect('sender_verified' in d).toBe(false);
      expect('sender_trust' in d).toBe(false);
    }
    const byPath = new Map(doc.drops.map((d) => [d.path as string, d]));
    expect(byPath.get(wroteBrief.path)).toMatchObject({
      from: 'the launch',
      sender_attribution: 'launch-brief',
    });
    expect(byPath.get(join(f.dropDir, idAttr))).toMatchObject({
      from: 'orchestrator',
      sender_attribution: 'attributed',
    });
    expect(byPath.get(rawPath)).toMatchObject({
      from: 'stranger',
      sender_attribution: 'none',
    });
    expect(byPath.get(tamperedPath)).toMatchObject({
      from: null,
      sender_attribution: 'none',
    });

    // Also verify `listDrops` without a key marks a signed record's sender as `sender_attribution: 'none'`
    const noKeyListing = listDrops(f.dropDir, undefined, { to: 'worker', root: f.root, session: 'acme' });
    expect(noKeyListing.kind).toBe('ok');
    if (noKeyListing.kind === 'ok') {
      const noKeyAttrRow = noKeyListing.rows.find((r) => r.id === idAttr);
      expect(noKeyAttrRow?.from).toBe('orchestrator');
      expect(noKeyAttrRow?.sender_attribution).toBe('none');
    }
  });

  test('--follow marks a shared-key record (unverified claim) and a raw drop (unattributed), and --read serves the signed body', async () => {
    const f = makeFixture();
    messageKeyOf(f.home);
    const idSigned = '20000000-0000-4000-8000-000000000021';
    const idRaw = '20000000-0000-4000-8000-000000000022';
    let signedPath = '';
    let rawFollowPath = '';

    const ioFollow = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
    const followCode = await runDrops(['--follow'], ioFollow, {
      home: f.home,
      poll: async (tick) => {
        if (tick === 0) {
          signedPath = plantRecord(f.home, f.root, 'acme', 'worker', idSigned, canonicalSendBody(), {
            from: 'orchestrator',
            from_id: null,
            rule: RULE,
            at: NOW.toISOString(),
          });
          rawFollowPath = join(f.dropDir, idRaw);
          writeFileSync(rawFollowPath, 'from outsider — admitted by: raw file\n\nhello\n');
          return true;
        }
        return false;
      },
    });
    expect(followCode).toBe(0);
    expect(ioFollow.out).toContain(`from orchestrator (unverified claim) — ${signedPath}`);
    expect(ioFollow.out).toContain(`from outsider (unattributed) — ${rawFollowPath}`);

    // Now run `team drops --read` and verify the signed record body is served with `(attributed)` while the raw file is skipped
    const ioRead = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
    const readCode = await runDrops(['--read', '--seat', 'worker', '--session', 'acme'], ioRead, { home: f.home });
    expect(readCode).toBe(0);
    expect(ioRead.out).toContain('from orchestrator (team lead):');
    expect(ioRead.out).toContain(`from orchestrator@acme — admitted by: ${RULE}`);
    expect(ioRead.out).toContain(QUOTE);
    expect(ioRead.out).not.toContain('outsider');
    expect(ioRead.err).toContain('1 drop(s) are not signed records and are not served');
  });

  test('schema/drops.schema.json and DROPS_OUTPUT_SCHEMA require sender_attribution with its three values and omit sender_verified', () => {
    const schemaPath = join(import.meta.dir, '..', 'schema', 'drops.schema.json');
    const diskSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties: {
        drops: {
          items: {
            required: string[];
            properties: Record<string, { type?: string; enum?: string[] }>;
          };
        };
      };
    };
    const itemSpec = diskSchema.properties.drops.items;
    expect(itemSpec.required).toContain('sender_attribution');
    expect(itemSpec.required).not.toContain('sender_verified');
    expect(itemSpec.properties.sender_attribution).toEqual({
      type: 'string',
      enum: ['attributed', 'launch-brief', 'none'],
    });
    expect('sender_verified' in itemSpec.properties).toBe(false);

    const codeItem = (
      DROPS_OUTPUT_SCHEMA.properties.drops as {
        items: { required: readonly string[]; properties: Record<string, unknown> };
      }
    ).items;
    expect(codeItem.required).toContain('sender_attribution');
    expect(codeItem.required).not.toContain('sender_verified');
    expect('sender_verified' in codeItem.properties).toBe(false);
  });
});

describe('3. inbox_check (listUnread) and inbox_read (readMessage)', () => {
  test('listUnread emits sender_attribution (attributed, launch-brief, none) with no sender_verified, and readMessage marks the served body', () => {
    const f = makeFixture();
    // (a) Signed record with a conflicting unsigned `.pending` marker
    const idSigned = '30000000-0000-4000-8000-000000000001';
    plantRecord(f.home, f.root, 'acme', 'worker', idSigned, canonicalSendBody('the owner', 'the owner'), {
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      at: NOW.toISOString(),
    });
    writeFileSync(
      join(f.dropDir, `${idSigned}.pending`),
      JSON.stringify({ id: idSigned, from: 'spoofed-marker', to: 'worker', body: '', ts: NOW.toISOString(), tries: 0 }),
    );

    // (b) Tampered record with a `.pending` marker -> falls back to marker `from`, `sender_attribution: 'none'`
    const idTampered = '30000000-0000-4000-8000-000000000002';
    const tamperedPath = plantRecord(f.home, f.root, 'acme', 'worker', idTampered, canonicalSendBody(), {
      from: 'orchestrator',
      from_id: null,
      rule: RULE,
      at: new Date(NOW.getTime() + 1_000).toISOString(),
    });
    const tamperedJson = JSON.parse(readFileSync(tamperedPath, 'utf8')) as {
      payload: Record<string, unknown>;
      signature: string;
    };
    tamperedJson.payload.body = 'tampered';
    writeFileSync(tamperedPath, `${JSON.stringify(tamperedJson, null, 2)}\n`);
    writeFileSync(
      join(f.dropDir, `${idTampered}.pending`),
      JSON.stringify({
        id: idTampered,
        from: 'marker-claim',
        to: 'worker',
        body: '',
        ts: new Date(NOW.getTime() + 2_000).toISOString(),
        tries: 0,
      }),
    );

    const unread = listUnread(f.dropDir, { to: 'worker', root: f.root, session: 'acme' }, f.home);
    expect(unread).toHaveLength(2);
    for (const item of unread) {
      expect('sender_verified' in (item as Record<string, unknown>)).toBe(false);
      expect('sender_trust' in (item as Record<string, unknown>)).toBe(false);
    }
    const signedRow = unread.find((u) => u.id === idSigned)!;
    expect(signedRow.from).toBe('owner');
    expect(signedRow.sender_attribution).toBe('attributed');

    const tamperedRow = unread.find((u) => u.id === idTampered)!;
    expect(tamperedRow.from).toBe('marker-claim');
    expect(tamperedRow.sender_attribution).toBe('none');

    // `inbox_read` (`readMessage`) serves the verified record with `(attributed)` and refuses the tampered one
    const readOk = readMessage({ dropDir: f.dropDir, root: f.root, seat: 'worker', session: 'acme' }, idSigned, f.home);
    expect(readOk.ok).toBe(true);
    if (readOk.ok) {
      expect(readOk.body).toBe(`from owner (owner):\n\nfrom the owner — admitted by: the owner\n\n${QUOTE}\n`);
    }
    const readBad = readMessage({ dropDir: f.dropDir, root: f.root, seat: 'worker', session: 'acme' }, idTampered, f.home);
    expect(readBad.ok).toBe(false);
  });
});

describe('4. socket frame opens with the attributed sender banner', () => {
  test('socket delivery for both owner and seat senders prefixes message.content with [attributed sender: <claimed>]', async () => {
    const made: World = world(null);
    extraCleanups.push(made.cleanup);

    const teamPath = join(made.dir, 'team.yaml');
    const lobby = resolveLobby(made.home, { entity: 'floor' });
    mkdirSync(lobby, { recursive: true });
    const teamText = readFileSync(teamPath, 'utf8').replace(lobbyDir(made.home), lobby);
    writeFileSync(teamPath, `${teamText}entity: floor\n`);

    const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
    if (settingsPath === null) throw new Error('missing settings path for lead');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
    writeFileSync(join(made.sockets, '222.sock'), '');
    const past = new Date(Date.now() - 60_000);
    utimesSync(settingsPath, past, past);

    const frames: string[] = [];
    const host = fake(made, {
      deliver: async (_socket: string, frame: string) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    expect(await runSend(['lead', 'hello from owner'], owner(made.root), host)).toBe(0);
    expect(frames).toHaveLength(1);
    const frameOwner = JSON.parse(frames[0]!) as { message: { content: string } };
    expect(frameOwner.message.content.startsWith('from the owner (owner):\n\n')).toBe(true);
    expect(frameOwner.message.content).not.toContain('unverified sender');
    expect(frameOwner.message.content).toContain('hello from owner');

    updateState(made.dir, (state) => {
      state.sessions.acme = {
        seats: {
          lead: { stage: 'ready' as const, pane: 'pane-lead' },
          helper: { stage: 'ready' as const, pane: 'pane-helper' },
        },
      } as never;
    });
    expect(
      await runSend(
        ['lead', 'hello from helper'],
        testIo(made.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' }),
        host,
      ),
    ).toBe(0);
    expect(frames).toHaveLength(2);
    const frameHelper = JSON.parse(frames[1]!) as { message: { content: string } };
    expect(frameHelper.message.content.startsWith('from helper (to orchestrator):\n\n')).toBe(true);
    expect(frameHelper.message.content).not.toContain('unverified sender');
    expect(frameHelper.message.content).toContain('hello from helper');
  });
});

describe('5. reconcile pass owner line reads [unattributed author] and config.changed stamps no sender field', () => {
  test('reconcilePass appends config.changed with no from, no sender_verified, reconciled: true, and ownerDeliveryText reads [unattributed author]', () => {
    const base = fixtureBase('.reconcile-t3-');
    cleanupDirs.push(base);
    const home = join(base, 'home');
    const root = join(base, 'repo');
    mkdirSync(join(root, '.agents'), { recursive: true });
    installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));

    const agentId = registerAgent(home, {
      name: 'Worker Three',
      signing: { model: 'Claude Sonnet', version: '5.5', role: 'builder' },
      lab: 'anthropic',
      cli: 'antigravity',
      launcher: null,
      launch: 'agy',
      reach: { team: 'acme', seat: 'worker', session: 'acme', pane: 'pane-1', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    }).id;

    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'acme',
      root,
      lobby: '',
      roster: [{ agent: agentId, seat: 'worker', role: 'builder' }],
    });

    const plan = planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'model', value: 'claude-opus-5-5' }],
    });
    if (!plan.ok) throw new Error('planConfigSet failed');
    const wrote = writeConfigSet(home, plan, { now: NOW });
    if (!wrote.ok) throw new Error('writeConfigSet failed');

    const res = reconcilePass({ project: 'acme', root, session: 'acme', home });
    expect(res.ok).toBe(true);

    const log = readEvents('acme', root, home);
    if (!log.ok) throw new Error(log.reason);
    const cfgEvents = log.events.filter((e) => e.payload.kind === 'config.changed');
    expect(cfgEvents).toHaveLength(1);
    const payload = cfgEvents[0]!.payload as Record<string, unknown>;
    expect(payload.reconciled).toBe('true');
    expect(payload.from).toBeUndefined();
    expect('from' in payload).toBe(false);
    expect('sender_verified' in payload).toBe(false);
    expect('sender_trust' in payload).toBe(false);
    expect(ownerDeliveryText(cfgEvents[0]!.payload)).toBe('model changed on disk [unattributed author]');

    // Direct write-time config.changed event keeps `from` and stamps no `sender_verified`
    const planDirect = planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'effort', value: 'high' }],
    });
    if (!planDirect.ok) throw new Error('planDirect failed');
    const wroteDirect = writeConfigSet(home, planDirect, { now: NOW });
    if (!wroteDirect.ok) throw new Error('wroteDirect failed');
    const recDirect = wroteDirect.written[0]!;
    const directEvent = appendConfigChanged('acme', root, home, {
      ts: recDirect.date,
      session: 'acme',
      level: 'seat',
      target: agentId,
      key: 'effort',
      old: null,
      value: recDirect.value,
      generation: recDirect.generation,
      from: 'owner',
      seat: 'worker',
      subject: 'worker',
    });
    expect(directEvent.ok).toBe(true);
    if (directEvent.ok) {
      expect(directEvent.record.payload.from).toBe('owner');
      expect('sender_verified' in directEvent.record.payload).toBe(false);
      expect(ownerDeliveryText(directEvent.record.payload)).not.toContain('[unattributed author]');
    }
  });
});

describe('6. launch general seat brief attribution — launch-brief when matching current claim, attributed otherwise', () => {
  test('current brief has JSON basis launch-brief and body mark (attributed); non-matching id, incarnation, digest, null claim, or non-launch rule has basis attributed', async () => {
    const f = makeFixture();
    const incarnation = 'inc_000000000077';
    const briefRec = generalBriefRecord({
      to: 'worker',
      root: f.root,
      session: 'acme',
      at: NOW.toISOString(),
      incarnation,
    });
    const wrote = writeRecord(recordDir(f.root, 'acme', 'worker'), signRecord(briefRec, f.home));
    if (!wrote.ok) throw new Error(wrote.reason);

    updateState(join(f.root, '.agents'), (state) => {
      state.sessions.acme = {
        ...state.sessions.acme,
        briefs: {
          worker: {
            id: briefRec.id,
            at: briefRec.at,
            incarnation,
            epoch: 'run_000000000077',
            sha256: GENERAL_BRIEF_SHA256,
            attempt: 0,
            stage: 'ready' as const,
            superseded: [],
          },
        },
      } as never;
    });

    const claim = currentClaimIn(f.root, 'acme', 'worker');
    expect(claim).not.toBeNull();
    expect(attributeSenderClaim(briefRec, { briefClaim: claim })).toBe('launch-brief');

    // `inbox_check` and `drops --json` report `launch-brief`; `drops` table and `inbox_read` mark `(attributed)`
    const unread = listUnread(f.dropDir, { to: 'worker', root: f.root, session: 'acme' }, f.home);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.sender_attribution).toBe('launch-brief');

    const ioDrops = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
    expect(await runDrops([], ioDrops, { home: f.home })).toBe(0);
    expect(ioDrops.out).toContain('the launch (attributed)');

    const ioDropsJson = testIo(f.root, { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' });
    expect(await runDrops(['--json'], ioDropsJson, { home: f.home })).toBe(0);
    const dropsDoc = JSON.parse(ioDropsJson.out) as { drops: Array<{ sender_attribution: SenderAttribution }> };
    expect(dropsDoc.drops[0]?.sender_attribution).toBe('launch-brief');

    const served = readMessage(
      { dropDir: f.dropDir, root: f.root, seat: 'worker', session: 'acme' },
      briefRec.id,
      f.home,
      { claim: () => claim },
    );
    expect(served.ok).toBe(true);
    if (served.ok) {
      expect(served.body).toBe(
        generalBriefBody().replace(
          `from ${GENERAL_BRIEF_FROM} — admitted by: ${GENERAL_BRIEF_RULE}`,
          `from ${GENERAL_BRIEF_FROM} (launch brief):`,
        ),
      );
    }

    // Any brief the seat's current claim does not name is `attributed`:
    // (a) null claim
    expect(attributeSenderClaim(briefRec, { briefClaim: null })).toBe('attributed');
    // (b) different id
    expect(attributeSenderClaim({ ...briefRec, id: '60000000-0000-4000-8000-000000000099' }, { briefClaim: claim })).toBe('attributed');
    // (c) different incarnation
    expect(attributeSenderClaim({ ...briefRec, incarnation: 'inc_000000000001' }, { briefClaim: claim })).toBe('attributed');
    // (d) different brief_sha256
    expect(attributeSenderClaim({ ...briefRec, brief_sha256: '0'.repeat(64) }, { briefClaim: claim })).toBe('attributed');
    // (e) forged `from: "the launch"` under an ordinary rule
    expect(attributeSenderClaim({ ...briefRec, rule: RULE }, { briefClaim: claim })).toBe('attributed');
  });
});

describe('7. docs guard — fails when a page says a sender is verified or unverified, passes on docs/', () => {
  const DOCS = join(import.meta.dir, '..', 'docs');
  // The exact regex in test/docs.test.ts:77 plus the generalized (?:un)?verified guard
  const DOCS_TEST_GUARD = /unverified (sender|author)|\(unverified\)/;
  const STRICT_SENDER_GUARD = /(?:un)?verified (sender|author)|\((?:un)?verified\)|\[(?:un)?verified (?:sender|author)/;

  function markdownPages(at: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) found.push(...markdownPages(path));
      else if (entry.name.endsWith('.md')) found.push(path);
    }
    return found.sort();
  }

  function scanPages(pages: Array<{ path: string; text: string }>, pattern: RegExp): string[] {
    const offenders: string[] = [];
    for (const page of pages) {
      const lines = page.text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line)) {
          offenders.push(`${page.path}:${String(index + 1)}: ${line.trim()}`);
        }
      }
    }
    return offenders;
  }

  test('every page in docs/ passes both the test/docs.test.ts guard and the strict verified/unverified sender guard', () => {
    const pages = markdownPages(DOCS).map((path) => ({
      path: relative(DOCS, path),
      text: readFileSync(path, 'utf8'),
    }));
    expect(pages.length).toBeGreaterThan(0);
    expect(scanPages(pages, DOCS_TEST_GUARD)).toEqual([]);
    expect(scanPages(pages, STRICT_SENDER_GUARD)).toEqual([]);
  });

  test('the guard flags pages that mark a sender or author as unverified or verified', () => {
    const badUnverified = [
      { path: 'commands/messages.md', text: 'The table marks an unverified sender in the FROM cell.' },
      { path: 'commands/drops.md', text: 'Each row carries `lead (unverified)` when the claim does not verify.' },
      { path: 'commands/settings.md', text: 'model changed on disk — unverified author' },
    ];
    expect(scanPages(badUnverified, DOCS_TEST_GUARD)).toHaveLength(3);
    expect(scanPages(badUnverified, STRICT_SENDER_GUARD)).toHaveLength(3);

    const badVerified = [
      { path: 'commands/messages.md', text: 'The table marks a verified sender in the FROM cell.' },
      { path: 'commands/drops.md', text: 'Each row carries `lead (verified)` when the key matches.' },
      { path: 'commands/send.md', text: 'The frame opens with `[verified sender: owner]`.' },
    ];
    expect(scanPages(badVerified, STRICT_SENDER_GUARD)).toHaveLength(3);
  });
});
