import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { entitiesPath } from '../../src/entities.ts';
import { grantsDir } from '../../src/grant.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { policySignaturePayload } from '../../src/policy/sources.ts';
import { POLICY_DOMAIN, type PolicyLevel } from '../../src/policy/types.ts';
import { registerAgent, updateAgent } from '../../src/registry/agents.ts';
import { upsertProject } from '../../src/registry/projects.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import { TRIGGER_MAX } from '../../src/send/native.ts';
import { pushAdapterFor, pushPointer, type RuntimePushRequest } from '../../src/send/push.ts';
import { RUNTIME_PUSH_ADAPTERS } from '../../src/send/push-adapters.ts';
import {
  CODEX_DAEMON_OFF_REASON,
  CODEX_PUSH_ADAPTER,
  CODEX_QUEUE_TIMEOUT_MS,
  codexPushAdapter,
  isValidCodexRemote,
  withCodexDaemonLaunchArgs,
} from '../../src/send/push-adapters/codex.ts';
import { bumpGeneration, keyOf, signDomain } from '../../src/store/keys.ts';
import type { YamlValue } from '../../src/yaml.ts';

const SAMPLE_ID = '38e81f88-fdd8-4370-b179-5609982498e9';
const SAMPLE_POINTER = `From tester-2@teamcli: New team message ${SAMPLE_ID}: call inbox_read({"id":"${SAMPLE_ID}"})`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRequest(overrides: Partial<RuntimePushRequest> = {}): RuntimePushRequest {
  return {
    root: '/tmp/nonexistent-teamcli-root',
    session: 'teamcli',
    seat: 'builder-3',
    id: SAMPLE_ID,
    sender: { seat: 'tester-2', team: 'teamcli' },
    agentSession: '019a0000-1111-7222-8333-444455556666',
    pointer: SAMPLE_POINTER,
    home: '/tmp/nonexistent-owner-home-never-read',
    ...overrides,
  };
}

import type { RecordedSeatSessionRead } from '../../src/registry/resume.ts';

function stubBoundSession(req: RuntimePushRequest): RecordedSeatSessionRead {
  const trimmed = req.agentSession?.trim() ?? '';
  if (!trimmed) {
    return { kind: 'none', why: 'no runtime session is recorded for this seat' };
  }
  return {
    kind: 'bound',
    recorded: {
      agentId: 'agt_123456789abc',
      seatHandle: 'seat_123456789abc',
      sessionId: trimmed,
      team: 'teamcli',
      seat: req.seat,
      cli: 'codex',
      herdrSession: req.session,
      pane: 'w1:p2',
      address: null,
    },
  };
}

describe('codexPushAdapter (OpenAI Codex 0.161.0 runtime-push adapter)', () => {
  test('serves the codex CLI profile and is registered in RUNTIME_PUSH_ADAPTERS', () => {
    expect(CODEX_PUSH_ADAPTER.clis).toEqual(['codex']);
    expect(RUNTIME_PUSH_ADAPTERS).toEqual([CODEX_PUSH_ADAPTER]);
    expect(pushAdapterFor('codex')).toBe(CODEX_PUSH_ADAPTER);
    expect(pushAdapterFor('claude-code')).toBeNull();
    expect(pushAdapterFor('gemini')).toBeNull();
    expect(pushPointer(SAMPLE_ID, { seat: 'tester-2', team: 'teamcli' })).toBe(SAMPLE_POINTER);
  });

  test('pushPointer derives From <seat>@<team>: strictly from signed sender metadata (sender-forgery resistance)', () => {
    const pointer = pushPointer(SAMPLE_ID, { seat: 'tester-2', team: 'teamcli' });
    expect(pointer).toBe(
      `From tester-2@teamcli: New team message ${SAMPLE_ID}: call inbox_read({"id":"${SAMPLE_ID}"})`,
    );
    expect(pointer?.startsWith('From tester-2@teamcli: ')).toBe(true);
    expect(pointer?.includes('\n')).toBe(false);
  });

  test('forwards FLO-1054 signed-sender pointer verbatim via codex queue --thread <agent_session> --message <pointer> and returns enqueue (never delivered) on exit 0', async () => {
    const calls: { binary: string; args: readonly string[]; timeoutMs: number }[] = [];
    const adapter = codexPushAdapter({
      binary: '/opt/homebrew/bin/codex',
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      spawn: (binary, args, options) => {
        calls.push({ binary, args, timeoutMs: options.timeoutMs });
        return { status: 0, stdout: 'Queued\n', stderr: '' };
      },
    });

    const request = makeRequest();
    const outcome = await adapter.push(request);

    // Enqueue is NOT delivery/read confirmation: adapter returns `enqueue`, never `delivered`.
    expect(outcome).toEqual({ kind: 'enqueue' });
    expect(outcome.kind).not.toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      binary: '/opt/homebrew/bin/codex',
      args: [
        'queue',
        '--thread',
        '019a0000-1111-7222-8333-444455556666',
        '--message',
        SAMPLE_POINTER,
      ],
      timeoutMs: CODEX_QUEUE_TIMEOUT_MS,
    });
    expect(calls[0]?.args[4]).toBe(SAMPLE_POINTER);
    expect(calls[0]?.args[4]?.startsWith('From tester-2@teamcli: ')).toBe(true);
  });

  test('requires explicit resolved agentSession; rejects flag injection or whitespace in thread id without spawning', async () => {
    let spawned = false;
    const adapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const nullSession = await adapter.push(makeRequest({ agentSession: null }));
    expect(nullSession).toEqual({
      kind: 'unsupported',
      reason: 'no trusted runtime session is recorded for this seat (no runtime session is recorded for this seat)',
    });

    const emptySession = await adapter.push(makeRequest({ agentSession: '   ' }));
    expect(emptySession).toEqual({
      kind: 'unsupported',
      reason: 'no trusted runtime session is recorded for this seat (no runtime session is recorded for this seat)',
    });

    const flagInjection = await adapter.push(makeRequest({ agentSession: '--thread=other' }));
    expect(flagInjection).toEqual({
      kind: 'unsupported',
      reason: 'the recorded runtime session is not a valid thread id',
    });

    const whitespaceSession = await adapter.push(makeRequest({ agentSession: 'thread 123' }));
    expect(whitespaceSession).toEqual({
      kind: 'unsupported',
      reason: 'the recorded runtime session is not a valid thread id',
    });

    expect(spawned).toBe(false);
  });

  test('refuses empty, multi-line, or over-length pointers and validates --remote ws://|wss://host:port', async () => {
    let spawned = false;
    const adapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(await adapter.push(makeRequest({ pointer: '' }))).toEqual({
      kind: 'unsupported',
      reason: 'the runtime pointer is not a valid single line',
    });

    expect(await adapter.push(makeRequest({ pointer: `${SAMPLE_POINTER}\ninjected line` }))).toEqual({
      kind: 'unsupported',
      reason: 'the runtime pointer is not a valid single line',
    });

    expect(await adapter.push(makeRequest({ pointer: 'x'.repeat(TRIGGER_MAX + 1) }))).toEqual({
      kind: 'unsupported',
      reason: 'the runtime pointer is not a valid single line',
    });

    expect(isValidCodexRemote('ws://127.0.0.1:8765')).toBe(true);
    expect(isValidCodexRemote('wss://relay.example.com:443')).toBe(true);
    expect(isValidCodexRemote('http://127.0.0.1:8765')).toBe(false);
    expect(isValidCodexRemote('ws://127.0.0.1:8765/path')).toBe(false);

    const badRemoteAdapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      remote: 'http://127.0.0.1:8765',
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(await badRemoteAdapter.push(makeRequest())).toEqual({
      kind: 'unsupported',
      reason: 'the configured codex remote endpoint is not a valid ws://, wss://, or unix:// address',
    });

    expect(spawned).toBe(false);
  });

  test('maps non-zero exit (--no-daemon or inactive thread) to unreachable and unrecognized subcommand to unsupported', async () => {
    const noDaemonAdapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      spawn: () => ({
        status: 1,
        stdout: '',
        stderr: 'Error: no running codex daemon for thread 019a0000-1111-7222-8333-444455556666\nextra line',
      }),
    });
    expect(await noDaemonAdapter.push(makeRequest())).toEqual({
      kind: 'unreachable',
      reason:
        'codex queue refused the pointer (Error: no running codex daemon for thread 019a0000-1111-7222-8333-444455556666)',
    });

    const oldBinaryAdapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      spawn: () => ({
        status: 2,
        stdout: '',
        stderr: "error: unrecognized subcommand 'queue'",
      }),
    });
    expect(await oldBinaryAdapter.push(makeRequest())).toEqual({
      kind: 'unsupported',
      reason: "codex queue is not supported by this binary (error: unrecognized subcommand 'queue')",
    });
  });

  test('maps spawn errors and timeouts to unreachable', async () => {
    const errorAdapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      spawn: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('spawn codex ENOENT'),
      }),
    });
    expect(await errorAdapter.push(makeRequest())).toEqual({
      kind: 'unreachable',
      reason: 'codex queue could not run: spawn codex ENOENT',
    });

    const throwingAdapter = codexPushAdapter({
      codexDaemon: 'on',
      resolveSession: stubBoundSession,
      spawn: () => {
        throw new Error('timed out after 5000ms');
      },
    });
    expect(await throwingAdapter.push(makeRequest())).toEqual({
      kind: 'unreachable',
      reason: 'codex queue failed: timed out after 5000ms',
    });
  });

  test('enforces codex-daemon on|off policy: off reinjects --no-daemon on launch args and fails closed in push adapter without spawning', async () => {
    const baseArgs = ['-a', 'never', '-s', 'danger-full-access', '--no-alt-screen'];
    expect(withCodexDaemonLaunchArgs(baseArgs, 'on')).toEqual([
      '-a',
      'never',
      '-s',
      'danger-full-access',
      '--no-alt-screen',
    ]);
    expect(withCodexDaemonLaunchArgs(baseArgs, 'off')).toEqual([
      '-a',
      'never',
      '-s',
      'danger-full-access',
      '--no-daemon',
      '--no-alt-screen',
    ]);

    let spawned = false;
    const offAdapter = codexPushAdapter({
      codexDaemon: (req) => (req.seat === 'builder-3' ? 'off' : 'on'),
      resolveSession: stubBoundSession,
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(await offAdapter.push(makeRequest({ seat: 'builder-3' }))).toEqual({
      kind: 'unsupported',
      reason: CODEX_DAEMON_OFF_REASON,
    });
    expect(spawned).toBe(false);
  });

  type CodexPushScene = {
    base: string;
    root: string;
    dir: string;
    home: string;
    sockets: string;
    teamFile: string;
    agentId: string;
    sessionId: string;
  };

  function makeCodexPushScene(sessionId = '019a0000-1111-7222-8333-444455556666'): CodexPushScene {
    const base = realpathSync(makeTempDir('codex-push-scene-'));
    const root = join(base, 'acme');
    const dir = join(root, '.agents');
    const home = join(base, 'home');
    const sockets = join(base, 'sockets');
    mkdirSync(dir, { recursive: true });
    mkdirSync(dirname(entitiesPath(home)), { recursive: true });
    writeFileSync(
      entitiesPath(home),
      `floor:\n  roots:\n    - ${JSON.stringify(base)}\n`,
    );
    mkdirSync(sockets, { recursive: true });
    mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const teamFile = join(dir, 'team.yaml');
    writeFileSync(
      teamFile,
      `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: teamcli
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: builder-3
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
`,
    );
    writeFileSync(
      join(dir, 'team.state.json'),
      `${JSON.stringify({
        format: 1,
        sessions: {
          teamcli: {
            seats: {
              'builder-3': {
                id: 'seat_123456789abc',
                stage: 'ready',
                pane: 'w1:p2',
                agent_session: sessionId,
              },
            },
            worktrees: {},
          },
        },
      })}\n`,
    );
    const agent = registerAgent(home, {
      name: 'builder-3',
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test',
      cli: 'codex',
      launcher: null,
      launch: 'codex -m gpt-6-sol',
      seat_handle: 'seat_123456789abc',
      reach: {
        team: teamIdOf(root),
        seat: 'builder-3',
        session: 'teamcli',
        agent_session: sessionId,
        pane: 'w1:p2',
        address: null,
      },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
    return { base, root, dir, home, sockets, teamFile, agentId: agent.id, sessionId };
  }

  function signCodexDaemonPolicy(
    home: string,
    level: PolicyLevel,
    target: string,
    name: string,
    value: YamlValue,
    tamperSignature = false,
  ): Record<string, YamlValue> {
    const key = keyOf(home);
    const folder = grantsDir(home);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const now = new Date('2026-10-19T12:00:00.000Z');
    const generation = bumpGeneration(folder, home, now);
    const date = now.toISOString();
    const payload = policySignaturePayload({
      name,
      value: value as string,
      level,
      target,
      setter: 'owner',
      date,
      expiry: null,
      kind: 'enforced',
      generation,
    });
    const sig = signDomain(POLICY_DOMAIN, payload, key);
    return {
      value,
      setter: 'owner',
      date,
      expiry: null,
      kind: 'enforced',
      target,
      generation,
      signature: tamperSignature ? `${sig.slice(0, -4)}AAAA` : sig,
    };
  }

  function setSignedCodexDaemonAtLevel(
    scene: CodexPushScene,
    level: PolicyLevel,
    value: YamlValue,
    options: { name?: string; tamperSignature?: boolean } = {},
  ): void {
    const name = options.name ?? 'codex-daemon';
    if (level === 'entity') {
      const entry = signCodexDaemonPolicy(scene.home, 'entity', 'floor', name, value, options.tamperSignature);
      const path = entitiesPath(scene.home);
      mkdirSync(dirname(path), { recursive: true });
      const lines = [
        'floor:',
        '  roots:',
        `    - ${JSON.stringify(scene.base)}`,
        '  policies:',
        `    ${JSON.stringify(name)}:`,
        ...Object.entries(entry).map(([k, v]) => `      ${k}: ${v === null ? 'null' : JSON.stringify(v)}`),
      ];
      writeFileSync(path, `${lines.join('\n')}\n`);
    } else if (level === 'project') {
      const entry = signCodexDaemonPolicy(scene.home, 'project', 'acme', name, value, options.tamperSignature);
      upsertProject(scene.home, 'acme', {
        name: 'acme',
        entity: 'floor',
        policies: { [name]: entry },
        by: 'owner',
      });
    } else if (level === 'team') {
      const entry = signCodexDaemonPolicy(
        scene.home,
        'team',
        teamIdOf(scene.root),
        name,
        value,
        options.tamperSignature,
      );
      const current = readFileSync(scene.teamFile, 'utf8').replace(/\npolicies:\n[\s\S]*$/, '\n');
      const policyLines = [
        'policies:',
        `  ${JSON.stringify(name)}:`,
        ...Object.entries(entry).map(([k, v]) => `    ${k}: ${v === null ? 'null' : JSON.stringify(v)}`),
      ];
      writeFileSync(scene.teamFile, `${current}${policyLines.join('\n')}\n`);
    } else {
      const entry = signCodexDaemonPolicy(scene.home, 'seat', scene.agentId, name, value, options.tamperSignature);
      updateAgent(scene.home, scene.agentId, { policies: { [name]: entry } });
    }
  }

  test('real callsite: resolves bound recordedSeatSession and default/signed codex-daemon: on without manual option injection', async () => {
    const scene = makeCodexPushScene('019a0000-aaaa-7bbb-8ccc-ddddeeeeffff');
    const calls: { binary: string; args: readonly string[] }[] = [];
    // Only `spawn` is stubbed so no real child process is launched; `codexDaemon` and `resolveSession`
    // use the real production default readers (`resolveCodexDaemonPolicy` + `recordedSeatSession`).
    const adapter = codexPushAdapter({
      binary: '/opt/homebrew/bin/codex',
      spawn: (binary, args) => {
        calls.push({ binary, args });
        return { status: 0, stdout: 'Queued\n', stderr: '' };
      },
    });

    // Even when `request.agentSession` is null, the bound `recordedSeatSession` supplies the verified thread ID.
    const outcome = await adapter.push(
      makeRequest({
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        agentSession: null,
      }),
    );
    expect(outcome).toEqual({ kind: 'enqueue' });
    expect(outcome.kind).not.toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      binary: '/opt/homebrew/bin/codex',
      args: ['queue', '--thread', '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff', '--message', SAMPLE_POINTER],
    });
  });

  test.each(['entity', 'project', 'team', 'seat'] as const)(
    'real callsite: signed codex-daemon: off at %s level fails closed without manual option injection and never spawns codex queue',
    async (level) => {
      const scene = makeCodexPushScene();
      setSignedCodexDaemonAtLevel(scene, level, 'off');

      let spawned = false;
      const adapter = codexPushAdapter({
        spawn: () => {
          spawned = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      });

      const outcome = await adapter.push(
        makeRequest({
          root: scene.root,
          home: scene.home,
          session: 'teamcli',
          seat: 'builder-3',
          agentSession: scene.sessionId,
        }),
      );
      expect(outcome).toEqual({
        kind: 'unsupported',
        reason: CODEX_DAEMON_OFF_REASON,
      });
      expect(spawned).toBe(false);

      // Registered CODEX_PUSH_ADAPTER singleton also refuses from the signed disk policy without spawning.
      const singletonOutcome = await CODEX_PUSH_ADAPTER.push(
        makeRequest({
          root: scene.root,
          home: scene.home,
          session: 'teamcli',
          seat: 'builder-3',
          agentSession: scene.sessionId,
        }),
      );
      expect(singletonOutcome).toEqual({
        kind: 'unsupported',
        reason: CODEX_DAEMON_OFF_REASON,
      });
    },
  );

  test('real callsite: invalid signature, loosening (entity: off + team: on), missing context, or unreadable policy YAML fails closed without spawning codex queue', async () => {
    let spawned = false;
    const adapter = codexPushAdapter({
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const tamperedScene = makeCodexPushScene();
    setSignedCodexDaemonAtLevel(tamperedScene, 'team', 'on', { tamperSignature: true });
    const tamperedOutcome = await adapter.push(
      makeRequest({
        root: tamperedScene.root,
        home: tamperedScene.home,
        session: 'teamcli',
        seat: 'builder-3',
        agentSession: tamperedScene.sessionId,
      }),
    );
    expect(tamperedOutcome.kind).toBe('unsupported');
    if (tamperedOutcome.kind === 'unsupported') {
      expect(tamperedOutcome.reason).toContain('signature verification failed');
    }

    const reopenScene = makeCodexPushScene();
    setSignedCodexDaemonAtLevel(reopenScene, 'entity', 'off');
    setSignedCodexDaemonAtLevel(reopenScene, 'team', 'on');
    const reopenOutcome = await adapter.push(
      makeRequest({
        root: reopenScene.root,
        home: reopenScene.home,
        session: 'teamcli',
        seat: 'builder-3',
        agentSession: reopenScene.sessionId,
      }),
    );
    expect(reopenOutcome.kind).toBe('unsupported');
    if (reopenOutcome.kind === 'unsupported') {
      expect(reopenOutcome.reason).toContain('loosens level');
    }

    const corruptScene = makeCodexPushScene();
    const entitiesFile = entitiesPath(corruptScene.home);
    mkdirSync(dirname(entitiesFile), { recursive: true });
    writeFileSync(entitiesFile, 'floor:\n  policies: "broken"\n');
    const corruptOutcome = await adapter.push(
      makeRequest({
        root: corruptScene.root,
        home: corruptScene.home,
        session: 'teamcli',
        seat: 'builder-3',
        agentSession: corruptScene.sessionId,
      }),
    );
    expect(corruptOutcome.kind).toBe('unsupported');

    // Missing root/home context also fails closed without spawning
    const missingRootOutcome = await adapter.push(makeRequest());
    expect(missingRootOutcome.kind).toBe('unsupported');
    expect(spawned).toBe(false);
  });

  test('real callsite: unbound or mismatched recordedSeatSession fails closed without spawning codex queue', async () => {
    let spawned = false;
    const adapter = codexPushAdapter({
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    // 1. Mismatch between team.state.json and agents/<id>.yaml
    const mismatchScene = makeCodexPushScene('019a0000-1111-7222-8333-444455556666');
    updateAgent(mismatchScene.home, mismatchScene.agentId, {
      reach: { agent_session: '019a0000-9999-7999-8999-999999999999' },
    });
    expect(
      await adapter.push(
        makeRequest({
          root: mismatchScene.root,
          home: mismatchScene.home,
          session: 'teamcli',
          seat: 'builder-3',
          agentSession: '019a0000-1111-7222-8333-444455556666',
        }),
      ),
    ).toEqual({
      kind: 'unsupported',
      reason:
        'no trusted runtime session is recorded for this seat (the seat state and the agent record name different sessions)',
    });

    // 2. Orphaned agent record
    const orphanScene = makeCodexPushScene();
    updateAgent(orphanScene.home, orphanScene.agentId, {
      orphaned_at: '2026-10-19T12:00:00.000Z',
    });
    expect(
      await adapter.push(
        makeRequest({
          root: orphanScene.root,
          home: orphanScene.home,
          session: 'teamcli',
          seat: 'builder-3',
          agentSession: orphanScene.sessionId,
        }),
      ),
    ).toEqual({
      kind: 'unsupported',
      reason: 'no trusted runtime session is recorded for this seat (the record is orphaned; its seat is no longer declared)',
    });

    // 3. Wrong herdrSession
    const wrongSessionScene = makeCodexPushScene();
    expect(
      await adapter.push(
        makeRequest({
          root: wrongSessionScene.root,
          home: wrongSessionScene.home,
          session: 'other-session',
          seat: 'builder-3',
          agentSession: wrongSessionScene.sessionId,
        }),
      ),
    ).toEqual({
      kind: 'unsupported',
      reason: 'no trusted runtime session is recorded for this seat (the record was written in herdr session teamcli)',
    });

    // 4. Caller request.agentSession disagrees with bound recorded.sessionId
    const callerMismatchScene = makeCodexPushScene();
    expect(
      await adapter.push(
        makeRequest({
          root: callerMismatchScene.root,
          home: callerMismatchScene.home,
          session: 'teamcli',
          seat: 'builder-3',
          agentSession: '019a0000-0000-7000-8000-000000000000',
        }),
      ),
    ).toEqual({
      kind: 'unsupported',
      reason: 'the seat state and the agent record name different sessions',
    });

    expect(spawned).toBe(false);
  });
});
