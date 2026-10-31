// A receiving session older than its `crossSessionInbound: accept` declaration is not dialed:
// the frame it would take is one its box was never reconfigured to accept, so the walk skips the
// socket and the history says why. The same world with the declaration older than the socket
// dials, so the scene pins the mtime gate itself, not just the skip.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { readHistory } from '../src/send/history.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const REASON =
  'the receiving session was started before its crossSessionInbound declaration; restart its CLI host so it accepts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The team file names an entity whose lobby it trusts, so an owner send has a reply target. */
function declareEntity(made: World): void {
  const lobby = resolveLobby(made.home, { entity: 'floor' });
  mkdirSync(lobby, { recursive: true });
  const path = join(made.dir, 'team.yaml');
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `entity: floor\n${text}`);
}

/** The seat's launch settings declare accept; `bootedAfter` decides which of the settings file
 *  and the socket the running session is older than. */
function declareSeat(made: World, bootedAfter: boolean): void {
  const settings = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (settings === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = bootedAfter ? Date.now() - 60_000 : Date.now() + 60_000;
  utimesSync(settings, new Date(at), new Date(at));
}

describe('a receiving session that predates its accept declaration', () => {
  test('is skipped with the published reason, and nothing is dialed', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    declareEntity(made);
    declareSeat(made, false);
    const io = owner(made.root);
    const host = fake(made);

    const code = await runSend(['lead', 'a note'], io, host);

    expect(code).toBe(0);
    expect(host.frames).toEqual([]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const entry = history.entries.at(-1);
    expect(entry?.to).toBe('lead');
    expect(entry?.failed).toContain(`socket: ${REASON}`);
  });

  test('a session started after the declaration is dialed, so the gate is the socket age', async () => {
    const made = world(null);
    cleanup = made.cleanup;
    declareEntity(made);
    declareSeat(made, true);
    const io = owner(made.root);
    const host = fake(made);

    const code = await runSend(['lead', 'a note'], io, host);

    expect(code).toBe(0);
    expect(host.frames.length).toBe(1);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const entry = history.entries.at(-1);
    expect(entry?.failed ?? []).not.toContain(`socket: ${REASON}`);
  });
});
