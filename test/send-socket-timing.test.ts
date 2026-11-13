// The sender's own path through a taken socket frame, measured on the wall clock: the frame is
// handed to the receiver's socket and the send reports `delivered (socket)` at once. Whatever the
// receiving box shows — an idle screen, or the held-message dialog — the send never waits on it:
// the dialog is the daemon's held step to see, on the presence beat. The bound is the one a
// person's command pays: p95 under 300 ms across repeated sends, where the sender's old
// held-dialog probe alone would have spent up to a second inside every send.
//
// A synthetic world, a fake host and a scripted pane: no live session, socket or owner home.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { heldSocketPath } from '../src/send/inbound.ts';
import { dropDir, owner, fake, scripted, world } from './send-native-fixtures.ts';

const HELD_DIALOG = 'Held message from another session\nPress enter to view';

/** The bound the sender's path is measured against, and how many sends the p95 is taken over. */
const BOUND_MS = 300;
const SENDINGS = 12;

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The team file names an entity, and that entity's lobby is the one in its trust list: an
 *  owner's send needs the entity to read its own reply target from. */
function declareEntity(made: ReturnType<typeof world>): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity: 'floor' });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: floor\n`);
}

/** The receiving seat declares `accept` at its launch's own settings path, and its pane exposes
 *  the socket the walk dials. */
function acceptSocket(made: ReturnType<typeof world>): void {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for the seat');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}
