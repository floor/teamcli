import { NO_EVENT_ADAPTER_TOOK_IT, NO_PANE_MESSAGING, queuedLine } from '../../src/send/no-pane-messaging.ts';
// The bootstrap scenes: a sender herdr has placed as a seat the live file declares, before any
// agent record exists for it. The own-team rules judge it as that seat, the drop file's header
// says so in as many words, and a refusal for the same caller names the command that would write
// the record. A target in another team, and the owner's grant store, both wait for that record.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../../src/commands/send.ts';
import { registerAgent } from '../../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { readSendGrants } from '../../src/send/grants.ts';
import { updateState } from '../../src/state.ts';
import { keyOf, signDomain } from '../../src/store/keys.ts';
import { recordBody, testIo } from '../helpers.ts';
import { dropDir, fake, scripted, world, type World } from '../send-native-fixtures.ts';
import { withoutSendId } from '../helpers/output.ts';

const made: World[] = [];

afterEach(() => {
  for (const one of made.splice(0)) one.cleanup();
});

function make(): World {
  const one = world();
  made.push(one);
  return one;
}

/** The state record `up` leaves for a launched seat: the pane herdr placed it on. Nothing here
 *  writes an agent record — that absence is the scene. */
function record(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.acme = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

describe("team send: the file's seat, before its record", () => {

  test('a caller the file does not declare is refused, and the refusal names the command that records it', async () => {
    const one = make();
    record(one.dir, 'drifter', 'w9:p9');
    const io = testIo(one.root, { kind: 'seat', name: 'drifter', pane: 'w9:p9', session: 'acme' });
    const host = fake(one);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('sender drifter has no agent record on this machine, so no rule admits the send');
    expect(io.err).toContain('`team up` registers a seat it leaves standing');
    expect(host.frames).toEqual([]);
    expect(existsSync(join(one.dir, 'send-drops'))).toBe(false);
  });

  test("a target in another team waits for the record, standing grant or not", async () => {
    // The declared sender has no identity yet, so nothing bears it across teams: not the rules,
    // which stop at its own file, and not the owner's grant store, which names records. The
    // grant below is a real one for the pair — the send still refuses until `team up` writes the
    // record, and this scene is what says the grant store waited.
    const one = make();
    const otherRoot = join(one.home, '..', 'other');
    mkdirSync(otherRoot, { recursive: true });
    upsertTeam(one.home, teamIdOf(otherRoot), {
      project: 'other',
      entity: null,
      session: 'other',
      root: otherRoot,
      lobby: join(one.home, 'lobby'),
      roster: [],
      lifecycle: 'running',
      by: 'test',
    });
    registerAgent(one.home, {
      name: 'quill',
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: 'other', seat: 'quill', session: 'other', pane: 'w5:p1', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'test',
    });
    mkdirSync(join(one.home, '.config', 'team', 'grants'), { recursive: true });
    const expires = '2026-11-16T00:00:00.000Z';
    const signature = signDomain(
      'team-send-grant-v1\n',
      { name: 'labs', send: { from: 'helper@acme', to: 'quill@other' }, expires },
      keyOf(one.home),
    );
    writeFileSync(
      join(one.home, '.config', 'team', 'grants', 'labs.yaml'),
      `send:\n  from: helper@acme\n  to: quill@other\nexpires: "${expires}"\nsignature: "${signature}"\n`,
    );
    expect(readSendGrants(one.home).length, 'the scene stands on a real standing grant').toBe(1);
    record(one.dir, 'helper', 'w2:p1');
    const io = testIo(one.root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
    const host = fake(one);

    const code = await runSend(['quill@other', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('sender helper has no agent record on this machine, so no rule admits the send');
    expect(io.err).toContain('`team up` registers a seat it leaves standing');
    expect(host.frames).toEqual([]);
    expect(existsSync(join(one.dir, 'send-drops'))).toBe(false);
  });
});
