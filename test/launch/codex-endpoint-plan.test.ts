// What a plan decides about the managed Codex endpoint, and what it does not. The marker is an
// intent for the launch, never a change to the printed line: a dry run prints the file's own
// command, and the attach is decided at launch time against the endpoint that actually exists.
// The scenes are pure — the plan starts nothing — and pin the four refusals: a policy that is
// not on, a line that already names its own `--remote` or `--no-daemon`, and a launcher whose
// own binary is not the Codex CLI (its endpoint is not ours to bind or to speak for).
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamConfig } from '../../src/file/team-config.ts';
import { remoteCodexCommand, upPlan, type UpInput, type UpSeat } from '../../src/launch/plan.ts';

const REPAIR = '`team remove coder --keep` then `team add coder`';
const STATE_DIR = '/tmp/acme/.agents';

function seat(extra: Partial<UpSeat> = {}): UpSeat {
  return {
    name: 'coder',
    cli: 'codex',
    launch: 'codex',
    cwd: '/tmp/acme',
    label: 'coder',
    repairLine: REPAIR,
    stopped: false,
    rules: 'Rules.',
    codexDaemon: 'on',
    ...extra,
  };
}

function input(over: Partial<UpInput> = {}, seatOver: Partial<UpSeat> = {}): UpInput {
  return {
    root: '/tmp/acme',
    session: 'scratch',
    sessionRunning: true,
    seats: [seat(seatOver)],
    watchAlive: true,
    watchLabel: 'Watch · scratch',
    stateDir: STATE_DIR,
    ...over,
  };
}

function launchOp(plan: ReturnType<typeof upPlan>) {
  const launch = plan.find((step) => step.do?.do === 'launch');
  if (launch?.do === undefined || launch.do.do !== 'launch') throw new Error('the plan launches no seat');
  return launch;
}

describe('the managed Codex endpoint intent', () => {
  test('a plain Codex line with the policy on and a state folder is marked for the endpoint', () => {
    const launch = launchOp(upPlan(input()));
    expect(launch.do).toMatchObject({ do: 'launch', codexEndpoint: { dir: STATE_DIR } });
    // The printed command is the file's own: the attach is decided at launch time.
    expect(launch.kind === 'run' ? launch.argv.at(-1) : '').not.toContain('--remote');
  });

  test('nothing is marked when the policy is off or unresolved', () => {
    expect(launchOp(upPlan(input({}, { codexDaemon: 'off' }))).do).not.toHaveProperty('codexEndpoint');
    expect(launchOp(upPlan(input({}, { codexDaemon: undefined }))).do).not.toHaveProperty('codexEndpoint');
  });

  test('nothing is marked when the run carries no state folder', () => {
    expect(launchOp(upPlan(input({ stateDir: undefined }))).do).not.toHaveProperty('codexEndpoint');
  });

  test('a line that already names --remote is never probed and re-pointed', () => {
    const launch = launchOp(upPlan(input({}, { launch: 'codex --remote unix:///tmp/own.sock' })));
    expect(launch.do).not.toHaveProperty('codexEndpoint');
  });

  test('a line that already names --no-daemon is not given an endpoint either', () => {
    const launch = launchOp(upPlan(input({}, { launch: 'codex --no-daemon' })));
    expect(launch.do).not.toHaveProperty('codexEndpoint');
  });

  test('a wrapper’s endpoint is not ours to bind', () => {
    const launch = launchOp(upPlan(input({}, { launch: './tools/codex-wrapper --fast' })));
    expect(launch.do).not.toHaveProperty('codexEndpoint');
  });

  test('a shell running a pass-through script before codex is still a Codex launch, and is marked', () => {
    // `zsh ~/tools/as-floor.sh codex …` execs codex with the remaining words, so the
    // `--remote` the launch appends reaches codex and the seat's thread loads on its endpoint.
    const launch = launchOp(upPlan(input({}, { launch: 'zsh ./tools/as-floor.sh codex -m gpt' })));
    expect(launch.do).toHaveProperty('codexEndpoint');
    // A script that names --remote itself is still left alone.
    const own = launchOp(upPlan(input({}, { launch: 'zsh ./tools/as-floor.sh codex --remote unix:///tmp/own.sock' })));
    expect(own.do).not.toHaveProperty('codexEndpoint');
    // A script naming another program is not a Codex launch.
    const other = launchOp(upPlan(input({}, { launch: 'zsh ./tools/as-floor.sh ./tools/codex-wrapper' })));
    expect(other.do).not.toHaveProperty('codexEndpoint');
  });

  test('a team read from the registry resolves the policy from the team, not a file it has no file at', () => {
    // A registry team has no team.yaml under its checkout. Resolving the seat's codex-daemon
    // policy through that path read as unresolved (off), so no endpoint was ever planned for it.
    const base = mkdtempSync(join(tmpdir(), 'codex-plan-'));
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
    copyFileSync(new URL('../fixtures/example.yaml', import.meta.url), join(root, 'team.yaml'));
    const loaded = readTeamConfig(root, { home, file: join(root, 'team.yaml') });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const over = { root, home, teamFile: join(root, '.agents', 'team.yaml') };
    const seatOver = { name: 'codex-acme', codexDaemon: undefined };
    expect(launchOp(upPlan(input(over, seatOver))).do).not.toHaveProperty('codexEndpoint');
    expect(launchOp(upPlan(input({ ...over, team: loaded.team }, seatOver))).do).toHaveProperty('codexEndpoint');
  });

  test('a resume carrying permission overrides is marked; the attach sheds the overrides', () => {
    // codex-cli 0.161.0 refuses -a/-s on a remote resume and exits to the shell; without them the
    // resumed thread keeps the permissions it was recorded with.
    const launch = launchOp(upPlan(input({}, { launch: 'codex resume 01a1 -a never -s danger-full-access' })));
    expect(launch.do).toHaveProperty('codexEndpoint');
    const fresh = launchOp(upPlan(input({}, { launch: 'codex -a never -s danger-full-access' })));
    expect(fresh.do).toHaveProperty('codexEndpoint');
  });

  test('remoteCodexCommand strips permission overrides from a resume line only', () => {
    expect(remoteCodexCommand('AGENT_UNATTENDED=1 codex -m gpt resume 01a1 -a never -s danger-full-access'))
      .toBe('AGENT_UNATTENDED=1 codex -m gpt resume 01a1');
    expect(remoteCodexCommand('codex resume 01a1 --ask-for-approval=never --sandbox workspace-write --full-auto -m gpt'))
      .toBe('codex resume 01a1 -m gpt');
    expect(remoteCodexCommand('codex resume 01a1 --dangerously-bypass-approvals-and-sandbox'))
      .toBe('codex resume 01a1');
    // A fresh thread takes its permissions from the line, so they stay.
    expect(remoteCodexCommand('codex -a never -s danger-full-access')).toBe('codex -a never -s danger-full-access');
    // A quoted argument that happens to hold the flags is not touched.
    expect(remoteCodexCommand(`codex resume 01a1 -s danger-full-access 'Read /x -s y.md'`))
      .toBe(`codex resume 01a1 'Read /x -s y.md'`);
    // Words that only contain the flags are not touched.
    expect(remoteCodexCommand('codex resume 01a1 -m gpt-sa')).toBe('codex resume 01a1 -m gpt-sa');
  });

  test('a non-Codex seat is never marked, whatever the policy value', () => {
    const plan = upPlan({
      ...input(),
      seats: [seat({ cli: 'claude-code', launch: 'claude' })],
    });
    expect(launchOp(plan).do).not.toHaveProperty('codexEndpoint');
  });

  test('the policy default that shapes the line and the marker is the same decision', () => {
    // `off` shapes the line with `--no-daemon`; the marker follows the same resolved value, so a
    // seat that runs without the shared daemon is never attached to an endpoint by this plan.
    const plan = upPlan(input({}, { codexDaemon: 'off' }));
    const launch = launchOp(plan);
    expect(launch.kind === 'run' ? launch.argv.at(-1) : '').toContain('--no-daemon');
    expect(launch.do).not.toHaveProperty('codexEndpoint');
  });
});
