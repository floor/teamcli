// The daemon's production endpoint callback reads the seat's own state record under the team
// state folder and lets the shared reader judge it; it adds no checks of its own. These scenes
// are synthetic state files only: no launch, home folder or socket is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintPresenceBinding } from '../src/daemon/presence/contract.ts';
import { currentCodexEndpoint } from '../src/daemon/presence/endpoint-state.ts';
import { STATE_FILE } from '../src/state.ts';

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-endpoint-state-')));
  bases.push(base);
  return base;
}

const urlOf = (binding: string): string => `unix:///private/tmp/launch/${binding}.sock`;

function record(binding: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { url: urlOf(binding), binding, pid: 4242, started_at: '2026-10-20T05:00:00.000Z', ...over };
}

/** Writes one session's state; `seat` undefined writes no seats at all. */
function writeState(dir: string, seat: Record<string, unknown> | undefined): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
    format: 1,
    sessions: { acme: { seats: seat === undefined ? {} : { clerk: seat }, worktrees: {} } },
  })}\n`);
}

describe('the current seat record the daemon reads its endpoint from', () => {
  test('a record on the seat current binding answers its URL', () => {
    const dir = scratch();
    const binding = mintPresenceBinding();
    writeState(dir, { id: 'seat_0123456789ab', presence_binding: binding, codex_endpoint: record(binding) });
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBe(urlOf(binding));
  });

  test('a record from an earlier incarnation is not attached to this one', () => {
    const dir = scratch();
    const binding = mintPresenceBinding();
    const earlier = mintPresenceBinding();
    writeState(dir, { id: 'seat_0123456789ab', presence_binding: binding, codex_endpoint: record(earlier) });
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();
  });

  test('no seat, no binding, no record, a malformed record or a non-unix URL all answer null', () => {
    const dir = scratch();
    const binding = mintPresenceBinding();
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();

    writeState(dir, undefined);
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();

    writeState(dir, { id: 'seat_0123456789ab', codex_endpoint: record(binding) });
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();

    writeState(dir, { id: 'seat_0123456789ab', presence_binding: binding });
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();

    writeState(dir, {
      id: 'seat_0123456789ab',
      presence_binding: binding,
      codex_endpoint: record(binding, { url: `tcp://127.0.0.1/${binding}` }),
    });
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();

    writeState(dir, {
      id: 'seat_0123456789ab',
      presence_binding: binding,
      codex_endpoint: record(binding, { started_at: 'today' }),
    });
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();
  });

  test('another session or seat name and an unreadable state file answer null', () => {
    const dir = scratch();
    const binding = mintPresenceBinding();
    writeState(dir, { id: 'seat_0123456789ab', presence_binding: binding, codex_endpoint: record(binding) });
    expect(currentCodexEndpoint(dir, 'other-session', 'clerk')).toBeNull();
    expect(currentCodexEndpoint(dir, 'acme', 'no-such-seat')).toBeNull();

    writeFileSync(join(dir, STATE_FILE), 'not json');
    expect(currentCodexEndpoint(dir, 'acme', 'clerk')).toBeNull();
  });
});
