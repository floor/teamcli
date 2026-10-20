import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CodexThreadReadResult,
  CodexThreadReadSnapshot,
} from '../../src/send/push-adapters/codex-relay.ts';
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
      timedOut: true,
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

  test('codexRelayCapabilities, probeCodexNativeRoute, and deliverCodexNativeRoute integrate with B5 deliveryTimeoutInForce and 785d63e1f FallbackWalk', async () => {
    const {
      CODEX_NATIVE_ROUTE,
      CODEX_NATIVE_TIMEOUT_MS,
      CODEX_PREPROBE_TIMEOUT_MS,
      CODEX_RECEIPT_TIMEOUT_SECONDS,
      codexRelayCapabilities,
      deliverCodexNativeRoute,
      probeCodexLiveReadiness,
      probeCodexNativeRoute,
      receiptSecondsFor,
      resolveCodexControlSocketPath,
      resolveCodexEscalationSeconds,
      resolveCodexNativeAttemptTimeoutMs,
    } = await import('../../src/send/push-adapters/codex-relay.ts');
    const { deliveryEscalationDelay, deliveryTimeoutInForce } = await import('../../src/policy/delivery.ts');
    const { loadTeamFile } = await import('../../src/file/load.ts');
    const { beginFallbackWalk } = await import('../../src/send/fallback-walk.ts');

    // 1. Capabilities and shared timing constants from src/policy/delivery.ts & src/policy/types.ts
    expect(CODEX_NATIVE_ROUTE).toBe('native');
    expect(CODEX_NATIVE_TIMEOUT_MS).toBe(15_000);
    expect(CODEX_PREPROBE_TIMEOUT_MS).toBe(400);
    expect(CODEX_RECEIPT_TIMEOUT_SECONDS).toBe(120);
    expect(receiptSecondsFor(15)).toBe(120);
    expect(receiptSecondsFor(15, 10)).toBe(15);

    const caps = codexRelayCapabilities('0.161.0');
    expect(caps.runtime).toBe('codex');
    expect(caps.routes).toEqual(['native', 'durable-copy']);
    expect(caps.native).toEqual({
      supported: true,
      command: ['codex', 'queue', '--thread', '<agent_session>', '--message', '<pointer>'],
      timeoutMs: 15_000,
      preprobeTimeoutMs: 400,
      precheck: 'local-policy-and-session-plus-optional-thread-read-rpc',
      liveProbeRpc: 'thread/read',
      ack: false,
      proof: 'queue-accepted-only',
    });
    expect(caps.durableCopy).toEqual({ supported: true });

    // 2. Accepts already-resolved B5 deliveryTimeoutInForce & deliveryEscalationDelay without re-parsing
    const scene = makeCodexPushScene('019a0000-1111-7222-8333-444455556666');
    const loadedDefault = loadTeamFile(scene.root, { home: scene.home, checkOnly: true });
    expect(loadedDefault.ok).toBe(true);
    if (!loadedDefault.ok) throw new Error('expected team.yaml to load');

    const defaultTimeouts = deliveryTimeoutInForce({
      home: scene.home,
      entity: 'floor',
      projectId: 'acme',
      root: scene.root,
      team: loadedDefault.team,
      seat: 'builder-3',
    });
    expect(defaultTimeouts).toEqual({
      ok: true,
      budgets: { socket: 15, 'mcp-inbox': 15, typed: 15, native: 15 },
      level: 'default',
    });
    expect(resolveCodexNativeAttemptTimeoutMs(defaultTimeouts)).toEqual({
      ok: true,
      timeoutMs: 15_000,
      attemptSeconds: 15,
    });

    const defaultEscalation = deliveryEscalationDelay({
      home: scene.home,
      entity: 'floor',
      projectId: 'acme',
      root: scene.root,
      team: loadedDefault.team,
      seat: 'builder-3',
    });
    expect(resolveCodexEscalationSeconds(defaultEscalation)).toEqual({
      ok: true,
      seconds: 300,
    });

    // Signed shortened delivery-timeout (native=6) at team level
    setSignedCodexDaemonAtLevel(scene, 'team', 'native=6', { name: 'delivery-timeout' });
    const loadedShortened = loadTeamFile(scene.root, { home: scene.home, checkOnly: true });
    expect(loadedShortened.ok).toBe(true);
    if (!loadedShortened.ok) throw new Error('expected team.yaml with delivery-timeout to load');

    const shortenedTimeouts = deliveryTimeoutInForce({
      home: scene.home,
      entity: 'floor',
      projectId: 'acme',
      root: scene.root,
      team: loadedShortened.team,
      seat: 'builder-3',
    });
    expect(shortenedTimeouts).toEqual({
      ok: true,
      budgets: { socket: 15, 'mcp-inbox': 15, typed: 15, native: 6 },
      level: 'team',
    });
    expect(resolveCodexNativeAttemptTimeoutMs(shortenedTimeouts)).toEqual({
      ok: true,
      timeoutMs: 6_000,
      attemptSeconds: 6,
    });

    // 2b. Override clamping & failed signed budget rejection:
    //   - A longer override (12_000ms) is clamped to the stricter signed budget (6_000ms)
    expect(resolveCodexNativeAttemptTimeoutMs(shortenedTimeouts, 12_000)).toEqual({
      ok: true,
      timeoutMs: 6_000,
      attemptSeconds: 6,
    });
    //   - A shorter override (4_000ms) shortens the signed budget (4_000ms)
    expect(resolveCodexNativeAttemptTimeoutMs(shortenedTimeouts, 4_000)).toEqual({
      ok: true,
      timeoutMs: 4_000,
      attemptSeconds: 4,
    });
    //   - A failed signed budget ({ ok: false }) is NEVER bypassed by a numeric override
    const failedTimeouts = {
      ok: false as const,
      error: 'delivery-timeout' as const,
      why: 'the team policy record for "delivery-timeout" failed signature verification',
    };
    expect(resolveCodexNativeAttemptTimeoutMs(failedTimeouts, 4_000)).toEqual({
      ok: false,
      why: failedTimeouts.why,
    });

    // 3. probeCodexNativeRoute local policy/session/pointer validation (ready vs codex-daemon: off)
    const readyProbe = probeCodexNativeRoute({
      root: scene.root,
      home: scene.home,
      session: 'teamcli',
      seat: 'builder-3',
      id: SAMPLE_ID,
      sender: { seat: 'lead', team: 'acme' },
    });
    expect(readyProbe.status).toBe('ready');
    if (readyProbe.status === 'ready') {
      expect(readyProbe.threadId).toBe(scene.sessionId);
      expect(readyProbe.pointer).toBe(
        `From lead@acme: New team message ${SAMPLE_ID}: call inbox_read({"id":"${SAMPLE_ID}"})`,
      );
    }

    expect(
      probeCodexNativeRoute({
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        id: SAMPLE_ID,
        sender: { seat: 'lead', team: 'acme' },
        codexDaemon: 'off',
      }),
    ).toEqual({
      status: 'unavailable',
      reason: CODEX_DAEMON_OFF_REASON,
    });

    // 4. Invalid signed budget + override in deliverCodexNativeRoute fails closed without spawning or staging
    const dropDir = join(scene.dir, 'send-drops', 'teamcli', 'builder-3');
    const signedRecordText = `${JSON.stringify({ payload: { id: SAMPLE_ID, body: 'hello' }, signature: 'sig' }, null, 2)}\n`;
    const invalidBudgetAttempt = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: dropDir, name: SAMPLE_ID },
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        sender: { seat: 'tester-2', team: 'teamcli' },
      },
      {
        id: SAMPLE_ID,
        record: signedRecordText,
        pointer: SAMPLE_POINTER,
      },
      {
        now: () => new Date('2026-10-20T01:00:00.000Z'),
        deliveryTimeout: failedTimeouts,
        timeoutMs: 4_000,
        liveRoutesRemain: true,
        spawn: () => {
          throw new Error('must never spawn when signed delivery-timeout policy failed');
        },
      },
    );
    expect(invalidBudgetAttempt).toEqual({
      route: 'native',
      outcome: 'unsupported',
      reason: failedTimeouts.why,
      walkAttempt: {
        route: 'native',
        outcome: 'unreachable',
        liveRoutesRemain: true,
        at: new Date('2026-10-20T01:00:00.000Z'),
        ms: 0,
        reason: failedTimeouts.why,
        receipt: { kind: 'unknown' },
      },
    });

    // 5. Shortened remaining deadline: preparation (stage + probeCodexNativeRoute) deducts from overall budget
    //   5a. When preparation takes 2_500ms of a 6_000ms budget (even with a 12_000ms override clamped to 6_000ms),
    //       spawn receives the remaining 3_500ms budget (never a fresh 6_000ms or 15_000ms).
    let clockStep = 0;
    const stepTimesMs = [
      Date.parse('2026-10-20T01:00:00.000Z'), // attemptStartedAtMs
      Date.parse('2026-10-20T01:00:01.000Z'), // relayStage timestamp
      Date.parse('2026-10-20T01:00:02.500Z'), // post-probe / pre-spawn elapsed check (2_500ms elapsed)
      Date.parse('2026-10-20T01:00:03.000Z'), // post-spawn completion timestamp (3_000ms total)
    ];
    const advancingNow = () => {
      const idx = Math.min(clockStep, stepTimesMs.length - 1);
      clockStep += 1;
      return new Date(stepTimesMs[idx]!);
    };

    const spawnCalls: { args: readonly string[]; timeoutMs: number }[] = [];
    const walk = beginFallbackWalk({
      caller: { kind: 'owner' },
      team: loadedShortened.team,
      root: scene.root,
      home: scene.home,
      now: () => new Date('2026-10-20T01:00:00.000Z'),
      recipient: {
        team: 'acme',
        seat: 'builder-3',
        toId: scene.agentId,
        session: 'teamcli',
        root: scene.root,
      },
      messageId: SAMPLE_ID,
      record: signedRecordText,
    });

    // First test failure fallback (continued walk) before final enqueue delivery:
    //   5b. When preparation exhausts the 6_000ms budget before spawn, spawn is NOT called and outcome is timeout
    let exhaustedStep = 0;
    const exhaustedTimesMs = [
      Date.parse('2026-10-20T01:00:00.000Z'), // attemptStartedAtMs
      Date.parse('2026-10-20T01:00:02.000Z'), // relayStage timestamp
      Date.parse('2026-10-20T01:00:06.000Z'), // post-probe elapsed check (6_000ms >= 6_000ms budget)
      Date.parse('2026-10-20T01:00:06.000Z'), // timeout walkAttempt timestamp
    ];
    const exhaustedAttempt = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: dropDir, name: SAMPLE_ID },
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        sender: { seat: 'tester-2', team: 'teamcli' },
      },
      {
        id: SAMPLE_ID,
        record: signedRecordText,
        pointer: SAMPLE_POINTER,
      },
      {
        now: () => {
          const idx = Math.min(exhaustedStep, exhaustedTimesMs.length - 1);
          exhaustedStep += 1;
          return new Date(exhaustedTimesMs[idx]!);
        },
        deliveryTimeout: shortenedTimeouts,
        liveRoutesRemain: true,
        spawn: () => {
          throw new Error('must never spawn when preparation exhausted the attempt budget');
        },
      },
    );
    expect(exhaustedAttempt.outcome).toBe('unreachable');
    if (exhaustedAttempt.outcome !== 'enqueue') {
      expect(exhaustedAttempt.timedOut).toBe(true);
    }
    expect(exhaustedAttempt.walkAttempt).toEqual({
      route: 'native',
      outcome: 'timeout',
      liveRoutesRemain: true,
      at: new Date('2026-10-20T01:00:06.000Z'),
      ms: 6_000,
      reason: 'codex queue timed out before spawn (6000ms attempt budget exhausted during preparation)',
      receipt: { kind: 'stored', id: SAMPLE_ID },
    });
    const continuedNote = walk.note(exhaustedAttempt.walkAttempt);
    expect(continuedNote.ok).toBe(true);
    if (continuedNote.ok) {
      expect(continuedNote.state).toBe('continued');
      expect(continuedNote.marker.receipt).toEqual({ kind: 'stored', id: SAMPLE_ID });
    }
    expect(readFileSync(join(dropDir, SAMPLE_ID), 'utf8')).toBe(signedRecordText);

    // 6. Enqueue unconfirmed with shortened remaining deadline (3_500ms passed to spawn):
    const deliveredAttempt = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: dropDir, name: SAMPLE_ID },
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        sender: { seat: 'tester-2', team: 'teamcli' },
      },
      {
        id: SAMPLE_ID,
        record: signedRecordText,
        pointer: SAMPLE_POINTER,
      },
      {
        now: advancingNow,
        deliveryTimeout: shortenedTimeouts,
        timeoutMs: 12_000, // clamped to 6_000ms, then 2_500ms elapsed -> 3_500ms remaining
        spawn: (_bin, args, opts) => {
          spawnCalls.push({ args, timeoutMs: opts.timeoutMs });
          return { status: 0, stdout: 'Queued\n', stderr: '' };
        },
      },
    );

    // Enqueue is transport queue acceptance only (never 'read'); durable copy is staged at <dropDir>/<id>.
    expect(deliveredAttempt.outcome).toBe('enqueue');
    expect(readFileSync(join(dropDir, SAMPLE_ID), 'utf8')).toBe(signedRecordText);
    expect(spawnCalls).toEqual([
      {
        args: ['queue', '--thread', scene.sessionId, '--message', SAMPLE_POINTER],
        timeoutMs: 3_500,
      },
    ]);
    expect(deliveredAttempt.walkAttempt).toEqual({
      route: 'native',
      outcome: 'delivered',
      liveRoutesRemain: false,
      at: new Date('2026-10-20T01:00:03.000Z'),
      ms: 3_000,
      reason: 'pushed to codex queue; no read receipt yet',
      receipt: { kind: 'maybe-consumed' },
    });
    const deliveredNote = walk.note(deliveredAttempt.walkAttempt);
    expect(deliveredNote.ok).toBe(true);
    if (deliveredNote.ok) {
      expect(deliveredNote.state).toBe('delivered');
      expect(deliveredNote.marker.receipt).toEqual({ kind: 'maybe-consumed' });
    }

    // 7. Spawn timeout / failure preserves the same staged record and message.id for the next fallback route
    const now = () => new Date('2026-10-20T01:00:00.000Z');
    const timeoutAttempt = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: dropDir, name: SAMPLE_ID },
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        sender: { seat: 'tester-2', team: 'teamcli' },
      },
      {
        id: SAMPLE_ID,
        record: signedRecordText,
        pointer: SAMPLE_POINTER,
      },
      {
        now,
        deliveryTimeout: shortenedTimeouts,
        liveRoutesRemain: true,
        spawn: (_bin, _args, opts) => ({
          status: null,
          stdout: '',
          stderr: '',
          error: new Error(`timed out after ${String(opts.timeoutMs)}ms`),
        }),
      },
    );
    expect(timeoutAttempt.outcome).toBe('unreachable');
    if (timeoutAttempt.outcome !== 'enqueue') {
      expect(timeoutAttempt.timedOut).toBe(true);
    }
    expect(timeoutAttempt.walkAttempt).toEqual({
      route: 'native',
      outcome: 'timeout',
      liveRoutesRemain: true,
      at: new Date('2026-10-20T01:00:00.000Z'),
      ms: 0,
      reason: 'codex queue could not run: timed out after 6000ms',
      receipt: { kind: 'stored', id: SAMPLE_ID },
    });
    expect(readFileSync(join(dropDir, SAMPLE_ID), 'utf8')).toBe(signedRecordText);

    // 8. skipStage caller preparation (routeStartedAt / startedAt) counts toward the whole route deadline:
    //   - Caller started route preparation at 01:00:00.000Z, spent 2_200ms in ensureDrop/ensureEpisode/policy
    //     before calling deliverCodexNativeRoute with skipStage: true, and liveProbe took 300ms (total 2_500ms).
    //     Under the 6_000ms signed budget, liveProbe receives min(400, 3_800) = 400ms and spawn receives 3_500ms.
    let skipStageStep = 0;
    const skipStageTimesMs = [
      Date.parse('2026-10-20T01:00:02.200Z'), // entryMs inside deliverCodexNativeRoute (2_200ms after routeStartedAt)
      Date.parse('2026-10-20T01:00:02.200Z'), // skipStage copyReceipt timestamp
      Date.parse('2026-10-20T01:00:02.200Z'), // elapsedBeforeProbeMs check (2_200ms elapsed -> 3_800ms left)
      Date.parse('2026-10-20T01:00:02.500Z'), // post-liveProbe elapsedMs check (2_500ms elapsed -> 3_500ms left)
      Date.parse('2026-10-20T01:00:02.900Z'), // post-spawn completion timestamp (2_900ms total)
    ];
    let observedLiveProbeBudgetMs = -1;
    let observedSkipStageSpawnBudgetMs = -1;
    const skipStageAttempt = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: dropDir, name: SAMPLE_ID },
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        sender: { seat: 'tester-2', team: 'teamcli' },
      },
      {
        id: SAMPLE_ID,
        record: signedRecordText,
        pointer: SAMPLE_POINTER,
      },
      {
        now: () => {
          const idx = Math.min(skipStageStep, skipStageTimesMs.length - 1);
          skipStageStep += 1;
          return new Date(skipStageTimesMs[idx]!);
        },
        routeStartedAt: Date.parse('2026-10-20T01:00:00.000Z'),
        startedAt: Date.parse('2026-10-20T01:00:00.000Z'),
        skipStage: true,
        deliveryTimeout: shortenedTimeouts,
        liveProbe: async (probeReq) => {
          observedLiveProbeBudgetMs = probeReq.timeoutMs;
          return {
            ok: true,
            thread: {
              id: probeReq.threadId,
              status: { type: 'idle' },
              canAcceptDirectInput: true,
            },
          };
        },
        spawn: (_bin, _args, opts) => {
          observedSkipStageSpawnBudgetMs = opts.timeoutMs;
          return { status: 0, stdout: 'Queued\n', stderr: '' };
        },
      },
    );
    expect(skipStageAttempt.outcome).toBe('enqueue');
    expect(observedLiveProbeBudgetMs).toBe(400);
    expect(observedSkipStageSpawnBudgetMs).toBe(3_500);
    expect(skipStageAttempt.walkAttempt.ms).toBe(2_900);

    // 9. Bounded <=400ms live readiness probe (probeCodexLiveReadiness + queryCodexAppServerThreadRead)
    //    over a real Unix-socket WebSocket mock app-server: ready | would-hold | unavailable
    const { createHash } = await import('node:crypto');
    const { createServer } = await import('node:net');
    const sockPath = resolveCodexControlSocketPath(scene.home);
    expect(sockPath).toBe(join(scene.home, '.codex', 'app-server-control', 'app-server-control.sock'));
    if (!sockPath) throw new Error('expected default control socket path');

    // 9a. Missing control socket -> unavailable
    const missingSocketProbe = await probeCodexLiveReadiness({
      root: scene.root,
      home: scene.home,
      session: 'teamcli',
      seat: 'builder-3',
      id: SAMPLE_ID,
      sender: { seat: 'lead', team: 'acme' },
    });
    expect(missingSocketProbe).toEqual({
      status: 'unavailable',
      reason: 'codex app-server control socket is not listening (ENOENT)',
    });

    // Start a local mock app-server WebSocket Unix socket (short /tmp path for macOS 104-byte sun_path limit)
    const testSockPath = join('/tmp', `codex-probe-${String(process.pid)}-${String(Date.now())}.sock`);
    const testRemote = `unix://${testSockPath}`;
    let nextThreadMode:
      | 'idle'
      | 'active-approval'
      | 'not-loaded'
      | 'hang'
      | 'masked-frame'
      | 'reserved-bits'
      | 'oversize-frame' = 'idle';
    let misplaceAccept = false;
    const seenRpcMethods: string[] = [];

    const unmaskClientFrame = (buf: Buffer): { text: string; total: number } | null => {
      if (buf.length < 6) return null;
      let offset = 2;
      let len = buf[1]! & 0x7f;
      if (len === 126) {
        if (buf.length < 8) return null;
        len = buf.readUInt16BE(2);
        offset = 4;
      }
      if (buf.length < offset + 4 + len) return null;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) {
        payload[i] = buf[offset + 4 + i]! ^ mask[i % 4]!;
      }
      return { text: payload.toString('utf8'), total: offset + 4 + len };
    };
    const sendServerFrame = (c: import('node:net').Socket, obj: unknown) => {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const hdr =
        payload.length < 126
          ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
      c.write(Buffer.concat([hdr, payload]));
    };

    const server = createServer((conn) => {
      let upgraded = false;
      let rem: Buffer = Buffer.alloc(0);
      conn.on('data', (chunk: Buffer) => {
        rem = Buffer.concat([rem, chunk]);
        if (!upgraded) {
          const endIdx = rem.indexOf('\r\n\r\n');
          if (endIdx === -1) return;
          const req = rem.subarray(0, endIdx).toString('utf8');
          rem = rem.subarray(endIdx + 4);
          const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(req)?.[1] ?? '';
          const accept = createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
          const acceptHeader = misplaceAccept
            ? `X-Echoed-Accept: ${accept}\r\nSec-WebSocket-Accept: not-the-probe-key`
            : `Sec-WebSocket-Accept: ${accept}`;
          conn.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${acceptHeader}\r\n\r\n`,
          );
          upgraded = true;
        }
        while (rem.length > 0) {
          const frame = unmaskClientFrame(rem);
          if (!frame) break;
          rem = rem.subarray(frame.total);
          const msg = JSON.parse(frame.text) as { id?: string; method: string };
          seenRpcMethods.push(msg.method);
          if (msg.method === 'initialize') {
            sendServerFrame(conn, { id: msg.id, result: { userAgent: 'codex/0.161.0' } });
          } else if (msg.method === 'thread/read') {
            if (nextThreadMode === 'hang') {
              return;
            }
            if (nextThreadMode === 'masked-frame') {
              // SERVERS MUST NOT MASK; the probe refuses instead of unmasking a server frame.
              const payload = Buffer.from(JSON.stringify({ id: msg.id, result: {} }));
              const mask = Buffer.from([1, 2, 3, 4]);
              const masked = Buffer.alloc(payload.length);
              for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
              conn.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
              return;
            }
            if (nextThreadMode === 'reserved-bits') {
              // RSV1 set on a text frame: a malformed frame under RFC 6455.
              conn.write(Buffer.from([0xc1, 0x02, 0x7b, 0x7d]));
              return;
            }
            if (nextThreadMode === 'oversize-frame') {
              // Header only, declaring 8 MiB: larger than this probe reads.
              const hdr = Buffer.alloc(10);
              hdr[0] = 0x81;
              hdr[1] = 127;
              hdr.writeBigUInt64BE(BigInt(8 * 1024 * 1024), 2);
              conn.write(hdr);
              return;
            }
            if (nextThreadMode === 'idle') {
              sendServerFrame(conn, {
                id: msg.id,
                result: {
                  thread: {
                    id: scene.sessionId,
                    status: { type: 'idle' },
                    canAcceptDirectInput: true,
                  },
                },
              });
            } else if (nextThreadMode === 'active-approval') {
              sendServerFrame(conn, {
                id: msg.id,
                result: {
                  thread: {
                    id: scene.sessionId,
                    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
                    canAcceptDirectInput: false,
                  },
                },
              });
            } else if (nextThreadMode === 'not-loaded') {
              sendServerFrame(conn, {
                id: msg.id,
                result: {
                  thread: {
                    id: scene.sessionId,
                    status: { type: 'notLoaded' },
                    canAcceptDirectInput: null,
                  },
                },
              });
            }
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(testSockPath, resolve));
    try {
      // 9b. Live idle thread -> ready
      nextThreadMode = 'idle';
      const liveReady = await probeCodexLiveReadiness({
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        id: SAMPLE_ID,
        sender: { seat: 'lead', team: 'acme' },
        remote: testRemote,
      });
      expect(liveReady.status).toBe('ready');
      expect(seenRpcMethods).toEqual(['initialize', 'initialized', 'thread/read']);

      // 9c. Live active thread (waitingOnApproval) -> would-hold, and deliverCodexNativeRoute aborts without spawning codex queue
      nextThreadMode = 'active-approval';
      const liveWouldHold = await probeCodexLiveReadiness({
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        id: SAMPLE_ID,
        sender: { seat: 'lead', team: 'acme' },
        remote: testRemote,
      });
      expect(liveWouldHold).toMatchObject({
        status: 'would-hold',
        threadId: scene.sessionId,
        threadStatus: 'active',
        activeFlags: ['waitingOnApproval'],
        canAcceptDirectInput: false,
      });

      const wouldHoldDeliver = await deliverCodexNativeRoute(
        {
          route: 'native',
          runtime: 'codex',
          copy: { dir: dropDir, name: SAMPLE_ID },
          root: scene.root,
          home: scene.home,
          session: 'teamcli',
          seat: 'builder-3',
          sender: { seat: 'tester-2', team: 'teamcli' },
          remote: testRemote,
        },
        {
          id: SAMPLE_ID,
          record: signedRecordText,
          pointer: SAMPLE_POINTER,
        },
        {
          now,
          deliveryTimeout: shortenedTimeouts,
          liveRoutesRemain: true,
          liveProbe: true,
          spawn: () => {
            throw new Error('must never spawn codex queue when live thread/read reports would-hold');
          },
        },
      );
      expect(wouldHoldDeliver.outcome).toBe('unreachable');
      if (wouldHoldDeliver.outcome !== 'enqueue') {
        expect(wouldHoldDeliver.wouldHold).toBe(true);
      }
      expect(wouldHoldDeliver.walkAttempt).toEqual({
        route: 'native',
        outcome: 'unreachable',
        liveRoutesRemain: true,
        at: new Date('2026-10-20T01:00:00.000Z'),
        ms: 0,
        reason: `codex thread ${scene.sessionId} is active (waitingOnApproval); codex queue would hold the message`,
        receipt: { kind: 'stored', id: SAMPLE_ID },
      });

      // 9d. Live notLoaded thread -> unavailable
      nextThreadMode = 'not-loaded';
      const liveNotLoaded = await probeCodexLiveReadiness({
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        id: SAMPLE_ID,
        sender: { seat: 'lead', team: 'acme' },
        remote: testRemote,
      });
      expect(liveNotLoaded).toEqual({
        status: 'unavailable',
        reason: `codex thread ${scene.sessionId} is notLoaded on the app-server daemon`,
      });

      // 9e. Hanging thread/read is bounded by timeoutMs (<= 400ms) -> unavailable + timedOut: true
      nextThreadMode = 'hang';
      const liveTimedOut = await probeCodexLiveReadiness({
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        id: SAMPLE_ID,
        sender: { seat: 'lead', team: 'acme' },
        remote: testRemote,
        timeoutMs: 40,
      });
      expect(liveTimedOut).toEqual({
        status: 'unavailable',
        timedOut: true,
        reason: 'codex app-server thread/read probe timed out after 40ms',
      });

      const probeMock = () => probeCodexLiveReadiness({
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        id: SAMPLE_ID,
        sender: { seat: 'lead', team: 'acme' },
        remote: testRemote,
      });

      // 9f. A server must not mask its frames; the probe refuses rather than unmasking.
      nextThreadMode = 'masked-frame';
      expect(await probeMock()).toEqual({
        status: 'unavailable',
        reason: 'codex app-server sent a masked WebSocket frame',
      });

      // 9g. Reserved bits are a malformed frame under RFC 6455.
      nextThreadMode = 'reserved-bits';
      expect(await probeMock()).toEqual({
        status: 'unavailable',
        reason: 'codex app-server sent a WebSocket frame with reserved bits set',
      });

      // 9h. A declared frame larger than the probe reads fails fast instead of buffering.
      nextThreadMode = 'oversize-frame';
      expect(await probeMock()).toEqual({
        status: 'unavailable',
        reason: 'codex app-server declared a WebSocket frame larger than this probe reads',
      });

      // 9i. The upgrade is accepted only from the Sec-WebSocket-Accept header itself, compared
      // exactly: the right value echoed in another header is not that header.
      nextThreadMode = 'idle';
      misplaceAccept = true;
      expect(await probeMock()).toEqual({
        status: 'unavailable',
        reason: 'codex app-server control socket rejected WebSocket upgrade',
      });
      misplaceAccept = false;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(testSockPath, { force: true });
    }
  });

  test('live readiness requires the bound thread id exactly, idle exactly, and an explicit canAcceptDirectInput true', async () => {
    const { probeCodexLiveReadiness } = await import('../../src/send/push-adapters/codex-relay.ts');
    const scene = makeCodexPushScene();
    const bound = {
      root: scene.root,
      home: scene.home,
      session: 'teamcli',
      seat: 'builder-3',
      id: SAMPLE_ID,
      sender: { seat: 'lead', team: 'acme' },
    };
    const probe = (thread: unknown) => probeCodexLiveReadiness({
      ...bound,
      liveProbe: async () => ({
        ok: true as const,
        thread: thread as CodexThreadReadSnapshot,
      }),
    });
    const notAccepting = `codex thread ${scene.sessionId} does not report whether it accepts direct input; readiness is unknown`;
    const otherId = '019a0000-9999-7bbb-8ccc-ddddeeeeffff';

    // Ready: the bound thread, idle, and an explicit yes.
    expect(await probe({ id: scene.sessionId, status: { type: 'idle' }, canAcceptDirectInput: true })).toMatchObject({
      status: 'ready',
      threadId: scene.sessionId,
      threadStatus: 'idle',
      canAcceptDirectInput: true,
    });

    // A reply for another thread, or one with no id, says nothing about this thread.
    expect(await probe({ id: otherId, status: { type: 'idle' }, canAcceptDirectInput: true })).toEqual({
      status: 'unavailable',
      reason: `codex app-server answered for thread ${otherId}, not the bound thread ${scene.sessionId}`,
    });
    expect(await probe({ status: { type: 'idle' }, canAcceptDirectInput: true })).toEqual({
      status: 'unavailable',
      reason: 'codex app-server thread/read response is missing thread status',
    });

    // Idle is not enough: a null or missing direct-accepts reading is unknown, never assumed yes.
    expect(await probe({ id: scene.sessionId, status: { type: 'idle' }, canAcceptDirectInput: null })).toEqual({
      status: 'unavailable',
      reason: notAccepting,
    });
    expect(await probe({ id: scene.sessionId, status: { type: 'idle' } })).toEqual({
      status: 'unavailable',
      reason: notAccepting,
    });

    // An explicit no holds; so does an active thread, even one that reports it accepts.
    expect(await probe({ id: scene.sessionId, status: { type: 'idle' }, canAcceptDirectInput: false })).toMatchObject({
      status: 'would-hold',
      threadStatus: 'idle',
      canAcceptDirectInput: false,
    });
    expect(
      await probe({
        id: scene.sessionId,
        status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        canAcceptDirectInput: true,
      }),
    ).toMatchObject({
      status: 'would-hold',
      threadStatus: 'active',
      activeFlags: ['waitingOnUserInput'],
      canAcceptDirectInput: true,
    });

    // The status is matched exactly; an unknown word is unavailable, never ready.
    expect(await probe({ id: scene.sessionId, status: { type: 'IDLE' }, canAcceptDirectInput: true })).toEqual({
      status: 'unavailable',
      reason: `codex thread ${scene.sessionId} reports the unrecognised status "IDLE" on the app-server daemon`,
    });
    expect(await probe({ id: scene.sessionId, status: { type: 'systemError' }, canAcceptDirectInput: true })).toEqual({
      status: 'unavailable',
      reason: `codex thread ${scene.sessionId} is systemError on the app-server daemon`,
    });

    // The hard deadline covers an injected promise that never settles, not only the socket query.
    const startedAt = Date.now();
    expect(
      await probeCodexLiveReadiness({
        ...bound,
        timeoutMs: 20,
        liveProbe: () => new Promise<CodexThreadReadResult>(() => {}),
      }),
    ).toEqual({
      status: 'unavailable',
      timedOut: true,
      reason: 'codex app-server thread/read probe timed out after 20ms',
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);

    // An injected probe that throws reads as unavailable; it never escapes the probe.
    expect(
      await probeCodexLiveReadiness({
        ...bound,
        liveProbe: () => {
          throw new Error('injected probe failed');
        },
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'codex app-server thread/read probe failed: injected probe failed',
    });
  });

  test('a route start that is invalid or in the future is refused before staging, never read as a fresh budget', async () => {
    const { deliverCodexNativeRoute } = await import('../../src/send/push-adapters/codex-relay.ts');
    const scene = makeCodexPushScene();
    const nowMs = Date.parse('2026-10-20T01:00:00.000Z');
    const dropDir = join(scene.dir, 'drops');
    let spawned = false;
    const deliver = (routeStartedAt: number | Date) => deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: dropDir, name: SAMPLE_ID },
        root: scene.root,
        home: scene.home,
        session: 'teamcli',
        seat: 'builder-3',
        sender: { seat: 'tester-2', team: 'teamcli' },
      },
      { id: SAMPLE_ID, record: 'unseen: rejected before staging', pointer: SAMPLE_POINTER },
      {
        now: () => new Date(nowMs),
        routeStartedAt,
        spawn: () => {
          spawned = true;
          return { status: 0, stdout: 'Queued\n', stderr: '' };
        },
      },
    );

    const invalid = 'the native route start time is not a valid instant; refusing to grant a fresh attempt budget';
    expect(await deliver(Number.NaN)).toEqual({
      route: 'native',
      outcome: 'unsupported',
      reason: invalid,
      walkAttempt: {
        route: 'native',
        outcome: 'unreachable',
        liveRoutesRemain: true,
        at: new Date(nowMs),
        ms: 0,
        reason: invalid,
        receipt: { kind: 'unknown' },
      },
    });
    expect(await deliver(new Date('not an instant'))).toMatchObject({ outcome: 'unsupported', reason: invalid });

    const future = 'the native route start time is 5000ms in the future; refusing to grant a fresh attempt budget';
    expect(await deliver(nowMs + 5000)).toEqual({
      route: 'native',
      outcome: 'unsupported',
      reason: future,
      walkAttempt: {
        route: 'native',
        outcome: 'unreachable',
        liveRoutesRemain: true,
        at: new Date(nowMs),
        ms: 0,
        reason: future,
        receipt: { kind: 'unknown' },
      },
    });

    expect(spawned).toBe(false);
    expect(existsSync(join(dropDir, SAMPLE_ID))).toBe(false);
  });

  test('a live-probed native attempt binds its probe and its queue to one explicit endpoint', async () => {
    const { deliverCodexNativeRoute, resolveCodexAttemptEndpoint, resolveCodexControlSocketPath } =
      await import('../../src/send/push-adapters/codex-relay.ts');
    const scene = makeCodexPushScene();
    const sockPath = resolveCodexControlSocketPath(scene.home);
    if (sockPath === null) throw new Error('expected a local control socket path');

    // One resolver: the team home's `.codex` by default, `CODEX_HOME` when the queue's own
    // process names one, and an explicit socket ahead of both.
    expect(resolveCodexAttemptEndpoint(scene.home, undefined)).toEqual({
      socketPath: sockPath,
      remote: `unix://${sockPath}`,
    });
    const codexHome = join(scene.dir, 'codex-home');
    expect(resolveCodexAttemptEndpoint(scene.home, undefined, undefined, { CODEX_HOME: codexHome })).toEqual({
      socketPath: join(codexHome, 'app-server-control', 'app-server-control.sock'),
      remote: `unix://${join(codexHome, 'app-server-control', 'app-server-control.sock')}`,
    });
    const explicit = join(scene.dir, 'explicit.sock');
    expect(resolveCodexAttemptEndpoint(scene.home, undefined, explicit)).toEqual({
      socketPath: explicit,
      remote: `unix://${explicit}`,
    });
    // A ws/wss remote is its own endpoint: there is no local socket to read or pass.
    expect(resolveCodexAttemptEndpoint(scene.home, 'ws://127.0.0.1:8791')).toEqual({
      socketPath: null,
      remote: 'ws://127.0.0.1:8791',
    });

    // The attempt hands the probe socket P and the queue `--remote unix://P`: one endpoint, not
    // one default per side.
    const savedCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    const probedSocket: (string | null | undefined)[] = [];
    const spawnArgs: (readonly string[])[] = [];
    try {
      const attempt = await deliverCodexNativeRoute(
        {
          route: 'native',
          runtime: 'codex',
          copy: { dir: join(scene.dir, 'drops'), name: SAMPLE_ID },
          root: scene.root,
          home: scene.home,
          session: 'teamcli',
          seat: 'builder-3',
          sender: { seat: 'tester-2', team: 'teamcli' },
        },
        { id: SAMPLE_ID, record: 'unused: skipStage', pointer: SAMPLE_POINTER },
        {
          deliveryTimeout: { native: 5 },
          skipStage: true,
          liveProbe: async (probeReq) => {
            probedSocket.push(probeReq.socketPath);
            return {
              ok: true,
              thread: { id: probeReq.threadId, status: { type: 'idle' }, canAcceptDirectInput: true },
            };
          },
          spawn: (_bin, args) => {
            spawnArgs.push(args);
            return { status: 0, stdout: 'Queued\n', stderr: '' };
          },
        },
      );
      expect(attempt.outcome).toBe('enqueue');
    } finally {
      if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome;
    }
    expect(probedSocket).toEqual([sockPath]);
    expect(spawnArgs).toEqual([
      ['queue', '--remote', `unix://${sockPath}`, '--thread', scene.sessionId, '--message', SAMPLE_POINTER],
    ]);
  });
});
