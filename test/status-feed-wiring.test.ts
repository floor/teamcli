// Synthetic files, placement and transport inputs only. No managed endpoint or CLI home.
// Registered adapter/reducer scenes are a test seam, never production correlation proof.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_KINDS, isPrivilegedKind } from '../src/bus/kinds.ts';
import { readEvents, type EventAppendInput } from '../src/bus/log.ts';
import { EVENT_ROUTING_DEFAULTS } from '../src/policy/events.ts';
import { createNativeFeed, nativeCandidateFromText, nativeHookEnabled as enabled } from '../src/daemon/presence/native-feed.ts';
import runHook from '../src/daemon/presence/hook.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { establishContext, initialNativeCandidate, reduceNativeObservation } from '../src/status/native-observation.ts';
import type { Io } from '../src/io.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { daemonStatePath } from '../src/daemon/paths.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'native-feed-fixtures-'));
afterAll(() => { try { Bun.spawnSync(['trash', sandbox]); } catch { /* platform keeps its temp fixture */ } });
const binding = 'prs_0123456789ab';
const next = 'prs_abcdef012345';
const session = 'sandbox';
const nativeHookEnabled = (identity: Parameters<typeof enabled>[0], io: Io) => enabled(identity, io, undefined, () => io.env.HOME!);
const hook = (argv: string[], input: () => string, io: Io) => runHook(argv, input, io, () => io.env.HOME!);
let index = 0;
function world(realBus = false) {
  const base = join(sandbox, String(++index));
  const stateDir = join(base, '.agents');
  mkdirSync(stateDir, { recursive: true });
  const input = { stateDir, session, seats: ['alpha', 'beta'], root: join(base, 'repo'), home: join(sandbox, `home-${index}`), project: 'example', daemonOwner: 'a'.repeat(32) };
  const events: EventAppendInput[] = [];
  const state = { format: 1, sessions: { [session]: { seats: {
    alpha: { stage: 'ready', pane: 'pane-alpha', presence_binding: binding },
    beta: { stage: 'ready', pane: 'pane-beta', presence_binding: binding },
  }, worktrees: {}, briefs: {} as Record<string, unknown> } } };
  const save = () => writeFileSync(join(stateDir, 'team.state.json'), JSON.stringify(state));
  save();
  const feed = createNativeFeed({ ...input, ...(realBus ? {} : { append: (event: EventAppendInput) => { events.push(event); return true; } }) });
  writeDaemonState(input.home, { format: 1, pid: process.pid, uid: process.getuid!(), since: new Date().toISOString(), startedBy: 'manual',
    version: 'example', heartbeatAt: new Date().toISOString(), socket: join(base, 'daemon.sock'), features: { broker: 'absent' }, stuck: [], roots: [], nativeFeedOwner: input.daemonOwner });
  const identity = (seat = 'alpha') => ({ stateDir, session, seat, binding });
  const io = (seat = 'alpha', pane = `pane-${seat}`): Io => ({ cwd: base, env: { HOME: input.home }, stdinIsTTY: false,
    stdout: () => {}, stderr: () => {}, caller: { kind: 'seat', name: seat, pane, session } });
  const path = (seat = 'alpha') => presencePaths(stateDir, session, seat)!.root;
  const marker = (seat = 'alpha') => join(path(seat), 'status-feed.json');
  const argv = (seat = 'alpha', launch = binding) => ['--dir', stateDir, '--session', session, '--seat', seat, '--binding', launch, '--event', 'turn-start'];
  return { ...input, feed, events, state, save, identity, io, path, marker, argv };
}
const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'provider-session', prompt_id: 'provider-prompt', prompt: 'private fixture body' });
const approval = JSON.stringify({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-example', turnId: 'turn-example', itemId: 'item-example' } });

describe('default-off native feed', () => {
  test('absent daemon marker preserves turn stdin and existing legacy staging', () => {
    const w = world(); let reads = 0;
    expect(hook(w.argv(), () => { reads++; return prompt; }, w.io())).toBe(0);
    expect(reads).toBe(0);
    expect(existsSync(join(w.path(), 'status-spool'))).toBe(false);
    expect(readdirSync(join(w.path(), 'spool'))).toHaveLength(1);
    expect(w.events).toEqual([]);
  });
  test('new closed kind has no routing default and is not privileged', () => {
    expect(EVENT_KINDS).toContain('seat.status');
    expect(Object.hasOwn(EVENT_ROUTING_DEFAULTS, 'seat.status')).toBe(false);
    expect(isPrivilegedKind('seat.status')).toBe(false);
  });
  test('on: real hook ingress, fixed receipt, daemon owner and signed bus append', () => {
    const w = world(true); w.feed.step(); let reads = 0;
    expect(hook(w.argv(), () => { reads++; return prompt; }, w.io())).toBe(0);
    expect(reads).toBe(1);
    const files = readdirSync(join(w.path(), 'status-spool'));
    expect(files).toHaveLength(1);
    const receipt = readFileSync(join(w.path(), 'status-spool', files[0]!), 'utf8');
    expect(receipt).not.toContain('private fixture body');
    expect(receipt).not.toContain('provider-prompt');
    w.feed.step();
    const bus = readEvents(w.project, w.root, w.home);
    expect(bus.ok).toBe(true);
    if (!bus.ok) throw new Error('synthetic bus read failed');
    expect(bus.unverified).toBe(0);
    expect(bus.events).toHaveLength(1);
    expect(bus.events[0]!.payload).toMatchObject({ kind: 'seat.status', seat: 'alpha', status_seq: 1,
      status_source: 'claude-hook', status_availability: 'correlation-unproven', status_advisory: 'unknown',
      status_continuity: 'unproven', status_gate: 'unknown', status_process_confirmation: 'needed' });
    expect(bus.events[0]!.payload.record_id).toBe(`status:alpha:${binding}:1`);
    w.feed.close(); expect(existsSync(w.marker())).toBe(false);
  });
  test.each(['wrong', 'stale', 'expired', 'claim', 'extra'] as const)('%s marker leaves additional stdin off', (kind) => {
    const w = world(); w.feed.step();
    const marker = JSON.parse(readFileSync(w.marker(), 'utf8'));
    if (kind === 'wrong') marker.binding = next;
    if (kind === 'stale') { w.state.sessions[session].seats.alpha.presence_binding = next; w.save(); }
    if (kind === 'expired') marker.expires = Date.now() - 1;
    if (kind === 'claim') marker.epoch = 'run_0123456789ab';
    if (kind === 'extra') marker.payload = 'untrusted';
    writeFileSync(w.marker(), JSON.stringify(marker));
    let reads = 0;
    expect(hook(w.argv(), () => { reads++; return prompt; }, w.io())).toBe(0);
    expect(reads).toBe(0); expect(w.events).toEqual([]);
    w.feed.close();
  });
  test.each(['pane-old', 'pane-beta'])('placement %s is refused before native stdin', (pane) => {
    const w = world(); w.feed.step(); let reads = 0;
    hook(w.argv(), () => { reads++; return prompt; }, w.io('alpha', pane));
    expect(reads).toBe(0); expect(existsSync(join(w.path(), 'status-spool'))).toBe(false);
    w.feed.close();
  });
  test('owner, another seat and another session cannot use the marker', () => {
    const w = world(); w.feed.step();
    for (const caller of [{ kind: 'owner' as const }, { kind: 'seat' as const, name: 'beta', pane: 'pane-beta', session },
      { kind: 'seat' as const, name: 'alpha', pane: 'pane-alpha', session: 'other' }]) {
      expect(nativeHookEnabled(w.identity(), { ...w.io(), caller })).toBe(false);
    }
    w.feed.close();
  });
  test('symlink and oversized markers are not read through', () => {
    const w = world(); mkdirSync(w.path(), { recursive: true });
    const planted = join(w.root, '..', 'large.json'); writeFileSync(planted, 'x'.repeat(10000));
    symlinkSync(planted, w.marker());
    expect(nativeHookEnabled(w.identity(), w.io())).toBe(false);
    expect(readFileSync(planted, 'utf8')).toHaveLength(10000);
  });
  test('matching identifiers in hook text cannot register or open a gate', () => {
    const w = world(); w.feed.step();
    hook(w.argv(), () => JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'provider-session', prompt_id: 'provider-prompt',
      tool_name: 'Read', tool_input: {}, seatId: 'alpha', incarnation: binding, mainTurn: 'turn-example', lane: 'main', gateId: 'gate-example' }), w.io());
    w.feed.step();
    expect(w.events).toHaveLength(1);
    expect(w.events[0]!.status_gate).toBe('unknown');
    expect(w.events[0]!.status_availability).toBe('correlation-unproven'); w.feed.close();
  });
  test('matching binding and epoch cannot enable a planted marker without an opted-in live daemon record', () => {
    const w = world(); w.feed.step();
    const machine = JSON.parse(readFileSync(daemonStatePath(w.home), 'utf8'));
    for (const owner of [undefined, 'b'.repeat(32)]) {
      writeFileSync(daemonStatePath(w.home), JSON.stringify({ ...machine, nativeFeedOwner: owner }));
      let reads = 0; hook(w.argv(), () => { reads++; return prompt; }, w.io());
      expect(reads).toBe(0);
    }
    writeFileSync(daemonStatePath(w.home), '{}');
    expect(nativeHookEnabled(w.identity(), w.io())).toBe(false); w.feed.close();
  });
  test('a fake machine record under the checkout is refused even with matching nonce', () => {
    const w = world(); w.feed.step();
    const home = join(w.path(), 'seat-home');
    const machine = JSON.parse(readFileSync(daemonStatePath(w.home), 'utf8'));
    writeDaemonState(home, machine);
    expect(enabled(w.identity(), w.io(), undefined, () => home)).toBe(false);
    expect(enabled(w.identity(), { ...w.io(), env: { HOME: home } }, undefined, () => w.home)).toBe(true);
    w.feed.close();
  });
  test('claim changes fence markers and pending receipts without resetting publication sequence', () => {
    const w = world(); w.feed.close();
    let allow = false;
    const feed = createNativeFeed({ ...w, append: (event) => { if (allow) w.events.push(event); return allow; } });
    feed.step(); feed.codexFrame(w.identity(), approval); feed.step();
    w.state.sessions[session].briefs.alpha = { id: '12345678-1234-1234-1234-123456789abc', at: new Date().toISOString(),
      incarnation: 'inc_0123456789ab', epoch: 'run_0123456789ab', sha256: 'a'.repeat(64) };
    w.save(); expect(nativeHookEnabled(w.identity(), w.io())).toBe(false);
    allow = true; feed.step(); expect(w.events).toEqual([]);
    expect(JSON.parse(readFileSync(w.marker(), 'utf8')).epoch).toBe('run_0123456789ab');
    feed.codexFrame(w.identity(), approval); feed.step();
    expect(w.events).toHaveLength(1); expect(w.events[0]!.status_seq).toBe(2); feed.close();
  });
  test('Codex approvals, resolution, foreign threads, string ids and session end stay unproven', () => {
    const w = world(); w.feed.step();
    const frames = [approval, JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread-example', requestId: 8 } }),
      JSON.stringify({ id: '8', result: {} }), JSON.stringify({ method: 'thread/closed', params: { threadId: 'other' } }), 'broken'];
    for (const frame of frames) w.feed.codexFrame(w.identity(), frame);
    w.feed.step();
    expect(w.events).toHaveLength(1); // unchanged unproven answer is deduped, never a health heartbeat
    for (const event of w.events) expect(event).toMatchObject({ status_gate: 'unknown', status_availability: 'correlation-unproven',
      status_source: 'codex-frame', status_process_confirmation: 'needed', status_continuity: 'unproven' });
    w.feed.close();
  });
  test('stale producer cannot replace a successor, and two seats own separate sequences', () => {
    const w = world(); w.feed.step();
    w.feed.codexFrame(w.identity(), approval); w.feed.codexFrame(w.identity('beta'), approval); w.feed.step();
    expect(w.events.map((event) => [event.seat, event.status_seq])).toEqual([['alpha', 1], ['beta', 1]]);
    w.state.sessions[session].seats.alpha.presence_binding = next; w.save(); w.feed.step();
    w.feed.codexFrame(w.identity(), approval); w.feed.step(); expect(w.events).toHaveLength(2);
    w.feed.codexFrame({ ...w.identity(), binding: next }, approval); w.feed.step();
    expect(w.events[2]!).toMatchObject({ status_binding: next, status_seq: 1, status_gate: 'unknown' });
    w.feed.close();
  });
  test('stale and non-refusal receipts never publish', () => {
    const w = world(); w.feed.step(); w.feed.codexFrame(w.identity(), approval);
    const spool = join(w.path(), 'status-spool'); const name = readdirSync(spool)[0]!;
    const receipt = JSON.parse(readFileSync(join(spool, name), 'utf8'));
    writeFileSync(join(spool, name), JSON.stringify({ ...receipt, status_gate: 'clear' })); w.feed.step();
    expect(w.events).toEqual([]);
    writeFileSync(join(spool, name), JSON.stringify({ ...receipt, binding: next })); w.feed.step();
    expect(w.events).toEqual([]); w.feed.close();
  });
  test('failed append replays the same durable id across owner restart', () => {
    const w = world(); w.feed.close(); const attempts: EventAppendInput[] = [];
    const first = createNativeFeed({ ...w, append: (event) => { attempts.push(event); return false; } });
    first.step(); first.codexFrame(w.identity(), approval); first.step(); expect(attempts).toHaveLength(1); first.close();
    const second = createNativeFeed({ ...w, append: (event) => { attempts.push(event); return true; } });
    second.step(); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    second.codexFrame(w.identity(), approval); second.step(); expect(attempts[2]!.status_seq).toBe(2); second.close();
  });
  test('old owner close cannot remove a successor marker, and close stops staging', () => {
    const w = world(); w.feed.step();
    const successor = createNativeFeed({ ...w, append: () => true }); successor.step();
    w.feed.close(); expect(nativeHookEnabled(w.identity(), w.io())).toBe(true);
    w.feed.codexFrame(w.identity(), approval); expect(existsSync(join(w.path(), 'status-spool'))).toBe(false);
    successor.close(); expect(existsSync(w.marker())).toBe(false);
  });
});

test('test-only registration uses both adopted text adapters and preserves gate fences', () => {
  const context = { seatId: 'example', incarnation: 'launch-example', mainTurn: 'main-example' };
  const envelope = { ...context, lane: 'main' as const, seq: 1, threadId: 'thread-example', turnId: 'turn-example', itemId: 'item-example',
    requestId: 8, toolId: 'tool-example', gateId: 'gate-example', binding: 'gate-binding' };
  const open = nativeCandidateFromText(initialNativeCandidate(), 'codex-frame', approval, { context, envelope });
  expect(open.state.gate?.ownerRequired).toBe(true);
  for (const [source, text] of [['codex-frame', '{"method":"serverRequest/resolved","params":{"requestId":8}}'],
    ['claude-hook', '{"hook_event_name":"Stop"}']] as const) {
    expect(nativeCandidateFromText(open.state, source, text).state).toBe(open.state);
  }
  const claudeEnvelope = { ...context, seq: 2, lane: 'main', sessionId: 'provider-session', promptId: 'provider-prompt',
    toolUseId: 'tool-example', gateId: 'gate-example', binding: 'gate-binding' };
  const tool = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'provider-session', prompt_id: 'provider-prompt',
    tool_use_id: 'tool-example', tool_name: 'Read', tool_input: {}, tool_response: {} });
  const subagent = nativeCandidateFromText(open.state, 'claude-hook', tool, { context, envelope: { ...claudeEnvelope, lane: 'subagent', agentId: 'child' } });
  expect(subagent.state.gate).toEqual(open.state.gate);
  const clear = nativeCandidateFromText(open.state, 'claude-hook', tool, { context, envelope: claudeEnvelope });
  expect(clear.state.gate).toBeNull();
  const gap = nativeCandidateFromText(open.state, 'claude-hook', tool, { context, envelope: { ...claudeEnvelope, seq: 3 } });
  expect(gap.state.continuity).toBe('unproven'); expect(gap.state.gate).toEqual(open.state.gate);
  const foreign = nativeCandidateFromText(open.state, 'claude-hook', tool, { context, envelope: { ...claudeEnvelope, incarnation: 'foreign' } });
  expect(foreign.state.gate).toEqual(open.state.gate);
  const ended = reduceNativeObservation(open.state, { source: 'native', seq: 2, kind: 'session-end', ...context, lane: 'main' });
  expect(ended.state.processConfirmation).toBe('needed'); expect(ended.state.gate).toEqual(open.state.gate);
  expect(establishContext(initialNativeCandidate(), context).state.gate).toBeNull();
});
