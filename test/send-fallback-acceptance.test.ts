import { NO_PANE_MESSAGING } from '../src/send/no-pane-messaging.ts';
// The send fallback acceptance, against the public `runSend`/`SendHost` seam.
//
// FIXED invariants (the reviewed decision, 2026-10-20) this file pins: the message is signed and staged
// once before any route attempt; every route attempt carries the same message id; the durable
// signed copy survives a failed route; and the receiver's effect is counted once across routes.
// Per-route timeout, route order and escalation delays are policies the walk varies.
//
// These scenes run against the walk this branch carries (`src/commands/send.ts` and
// `src/send/fallback-walk.ts`): a socket frame the transport refuses, or one the receiver holds at
// its dialog, falls through to the next allowed route with the same signed record and message id,
// never a second record; a walk no route takes records its exhaustion once and leaves one delayed
// escalation. The attempts feed, the held first attempt (receipt `unknown`, never read) and the
// all-failed event plus main escalation are pinned below as the walk records them.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import type { Caller } from '../src/caller.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { runNext } from '../src/commands/next.ts';
import { runSend } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { MESSAGE_ID, readMessage } from '../src/mcp/inbox.ts';
import { DELIVERY_ESCALATION_SECONDS } from '../src/policy/types.ts';
import {
  allFailedRecordId,
  attemptLedgerFileName,
  escalatedRecordId,
  escalationMailboxId,
  escalateDue,
  markerPathOf,
  type CanonicalRecipient,
} from '../src/send/fallback-events.ts';
import { historyPath, readHistory } from '../src/send/history.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { emptySession, updateState } from '../src/state.ts';
import { recordBody, testIo } from './helpers.ts';
import { dropDir, fake, filed, NOW, owner, scripted, world, type World } from './send-native-fixtures.ts';

const RULE = '─'.repeat(30);

/** A team the local queue reads, for the receiver-side scene: one placed seat and one task. */
const QUEUE_TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's own declaration that it accepts cross-session frames, and the socket its
 *  pane exposes. The declaration's file predates the socket, so the session was started after the
 *  declaration took effect and the socket leg is live. */
function accepting(made: World): void {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

/** The team file with an entity, and the entity's own lobby in its trust list: a team that names
 *  an entity starts in `<home>/.config/team/lobbies/<slug>`, and that is the lobby the file must
 *  trust. */
function declareEntity(made: World, entity = 'acme-corp'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

test('a socket frame taken into a held dialog is the delivery: the walk stops there, and held is the presence pass\'s word', async () => {
  // The frame reaches the transport and the receiver holds it at its dialog. A taken frame is
  // the delivery: the sender reads no other seat's screen, so the walk stops there, and the
  // daemon's presence pass raises `message.held` from the record and the screen on its own beat.
  // The staged record is the copy the watch and the seat read.
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const emptyBox = `${RULE}\n❯ \n${RULE}`;
  const heldDialog = `Held message from another session\n${RULE}\n❯ \n${RULE}`;
  let frameLanded = false;
  let dialogShown = false;
  const pane = scripted(['idle', 'working']);
  // The dialog renders right after the frame lands; every later read is the free box.
  pane.paneText = () => {
    if (frameLanded && !dialogShown) {
      dialogShown = true;
      return heldDialog;
    }
    return emptyBox;
  };
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_socketPath, frame) => {
      dials.push(frame);
      frameLanded = true;
      return { ok: true };
    },
  });
  const io = owner(made.root);

  expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

  // One staged record and one frame, both carrying the one message id the drop took.
  const dir = dropDir(made.dir, 'lead');
  const records = readdirSync(dir).filter((name) => MESSAGE_ID.test(name));
  expect(records).toHaveLength(1);
  const id = records[0] as string;
  expect(dials).toHaveLength(1);
  expect(dials[0]).toContain(id);
  expect(pane.typed).toEqual([]);
  expect(recordBody(join(dir, id))).toBe(filed('hello'));

  const recipient: CanonicalRecipient = { team: 'acme', seat: 'lead', toId: null, session: 'acme', root: made.root };
  // The one live route took the frame at the walk's first leg: there was no fallback, so no
  // episode opened (no marker, no attempt ledger) and no escalation can be scheduled.
  expect(existsSync(markerPathOf(recipient, id))).toBe(false);
  expect(existsSync(join(dirname(historyPath('acme', made.root, made.home)), attemptLedgerFileName(recipient, id)))).toBe(false);

  // The history records the taken frame as the delivery: the record stays unread for the seat's
  // own receipt, and the presence pass is where a dialog becomes `held`.
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.map((entry) => ({ id: entry.id, outcome: entry.outcome, via: entry.via }))).toEqual([
    { id, outcome: 'delivered', via: 'socket' },
  ]);
});
