// The hosted watch on a registry root keeps its authority while it cycles. The daemon's team
// lives in the registry, so the conventional `.agents/team.yaml` may name no file at all, or a
// file left behind by an earlier life; neither is the team. The watch itself reads its definition
// through the one seam on every pass, and its authority record is identified by the root.
//
// One live failure this pins: a watch pass performs host reads synchronously, so it can hold the
// daemon's only event loop past the freshness window. The beat after such a pass finds a
// heartbeat older than the window; a renew that refused it ended both watches for good. The loop
// is the same process that minted the epoch, and no other host can acquire its stale record, so
// the renew refreshes that record and the watch keeps cycling. Every root, clock and sender here
// is synthetic; no live daemon, socket or pane is read.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch, type HostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchAuthority, type HostedWatchAuthorityInput } from '../src/daemon/watch-authority.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { mintWatchEpoch, WATCH_AUTHORITY_MAX_AGE_MS } from '../src/watch/epoch.ts';
import { intoRegistry, underRegistry } from './helpers/registry-team.ts';

const AT = Date.parse('2026-11-02T04:00:00Z');
const SESSION = 'harvest';
const TEAM = `format: 1
project: orchard
session: harvest
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: picker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --dangerously-load-development-channels server:team-inbox
`;
const STALE = TEAM.replace('project: orchard', 'project: retired')
  .replace('session: harvest', 'session: retired')
  .replace('name: picker', 'name: retired-picker');

const bases: string[] = [];
const hosts: HostedWatch[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop('scene cleanup');
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function registryWorld(leftover: string | null) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-registry-authority-')));
  bases.push(base);
  const root = join(base, 'orchard');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const teamFile = join(dir, 'team.yaml');
  writeFileSync(teamFile, TEAM);
  updateState(dir, state => { state.sessions[SESSION] = emptySession(); });
  intoRegistry(root, home);
  if (leftover === null) unlinkSync(teamFile);
  else writeFileSync(teamFile, leftover);
  const route = routeOf(root, 'orchard', SESSION, ['lead', 'picker']);
  const clock = { at: AT };
  const logs: string[] = [];
  let unsafeWrites = 0;
  const unsafe = (): false => { unsafeWrites += 1; return false; };
  const sources: WatchSources = {
    home,
    pid: process.pid,
    now: () => new Date(clock.at),
    alive: pid => pid === process.pid,
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
    machine: () => ({ loadPerCore: 0.1, memoryFree: 75, diskFree: 100e9, swapTotal: 0, swapFree: 0, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    processes: () => null,
    typeText: unsafe,
    pressEnter: unsafe,
    sendKey: unsafe,
    notify: unsafe,
    sleep: async () => {},
    wait: async () => false,
    renameWorkspace: unsafe,
    reportDisplayAgent: unsafe,
  };
  const input: HostedWatchAuthorityInput = {
    route,
    teamFile,
    base: sources,
    now: () => new Date(clock.at),
    alive: pid => pid === process.pid,
    log: line => logs.push(line),
    // A verified sender and verifier are both present, so the recorded effects state opens the
    // way the daemon's own wiring opens it; nothing here sends anywhere.
    sender: () => async () => ({ ok: true, outcome: 'synthetic' }),
    verifyAuthority: () => ({ ok: true }),
  };
  return {
    root, dir, home, teamFile, route, clock, logs, input,
    session: () => readState(dir).sessions[SESSION],
    unsafeWrites: () => unsafeWrites,
  };
}
type World = ReturnType<typeof registryWorld>;

async function flush() {
  for (let n = 0; n < 20; n += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

async function nextPass(w: World, host: HostedWatch) {
  const before = host.state().cycles;
  for (let n = 0; n < 120 && host.state().cycles === before; n += 1) {
    w.clock.at += 5_000;
    host.tick(new Date(w.clock.at));
    await flush();
  }
}

function start(w: World): HostedWatch {
  const build = hostedWatchAuthority(w.input);
  const host = createHostedWatch({
    route: w.route,
    ...build,
    onTick: build.tick,
    now: () => new Date(w.clock.at),
  });
  hosts.push(host);
  return host;
}

async function authorityScene(leftover: string | null): Promise<void> {
  const w = registryWorld(leftover);
  await underRegistry(async () => {
    const host = start(w);
    try {
      await flush();
      expect(host.state()).toMatchObject({ phase: 'running', cycles: 1, effects: 'open', required: true });
      const epoch = w.session()?.watch?.epoch;
      expect(epoch).toMatch(/^watch_[0-9a-f]{32}$/);
      expect(w.session()?.watchdog).toEqual({ file: w.teamFile });

      // Ordinary cycles: every pass resolves the root through the registry again.
      await nextPass(w, host);
      await nextPass(w, host);
      expect(host.state().cycles).toBe(3);
      expect(host.state().effects).toBe('open');

      // The gap the live daemon hit: one synchronous pass held the only event loop far past the
      // freshness window, so the next beat found a heartbeat older than the window.
      w.clock.at += WATCH_AUTHORITY_MAX_AGE_MS + 5_000;
      host.tick(new Date(w.clock.at));
      await flush();
      // Red before the renew fix: this beat drained the host and stopped the watch for good.
      expect(host.state()).toMatchObject({ phase: 'running', effects: 'open' });
      expect(w.session()?.watch?.heartbeat).toBe(new Date(w.clock.at).toISOString());

      // Authority survives the gap: later cycles keep the same epoch and keep counting.
      await nextPass(w, host);
      await nextPass(w, host);
      expect(host.state().cycles).toBe(5);
      expect(host.state().effects).toBe('open');
      expect(w.session()?.watch?.epoch).toBe(epoch);
      expect(w.session()?.watch?.pid).toBe(process.pid);
      expect(w.unsafeWrites()).toBe(0);
    } finally {
      await host.stop('authority scene complete');
    }
  });
}

test('a registry root with no team file keeps the hosted watch authority across cycles', async () => {
  await authorityScene(null);
});

test('a registry root with a stale leftover keeps the hosted watch authority across cycles', async () => {
  await authorityScene(STALE);
});

test('a successor epoch between cycles still ends the hosted watch and closes its effects', async () => {
  // The fence on the refresh: a heartbeat past the window is refreshed only because the record
  // still carries this runtime's captured epoch. The moment another holder has written a
  // successor epoch — even under this same pid, as an in-place rotation would — the captured
  // proof is no longer this host's, and the next beat drains instead of refreshing.
  const w = registryWorld(null);
  await underRegistry(async () => {
    const host = start(w);
    try {
      await flush();
      expect(host.state()).toMatchObject({ phase: 'running', cycles: 1, effects: 'open' });
      const epoch = w.session()?.watch?.epoch;
      const successor = mintWatchEpoch();
      updateState(w.dir, state => {
        state.sessions[SESSION]!.watch = {
          pid: process.pid,
          epoch: successor,
          heartbeat: new Date(w.clock.at).toISOString(),
        };
      });
      w.clock.at += 5_000;
      host.tick(new Date(w.clock.at));
      await flush();
      expect(host.state()).toMatchObject({ phase: 'stopped', why: 'the watch loop ended', effects: 'blocked' });
      // The successor's record is untouched: the old holder wrote nothing over it.
      expect(w.session()?.watch).toEqual({
        pid: process.pid,
        epoch: successor,
        heartbeat: new Date(w.clock.at - 5_000).toISOString(),
      });
      expect(w.session()?.watch?.epoch).not.toBe(epoch);
    } finally {
      await host.stop('successor scene complete');
    }
  });
});
