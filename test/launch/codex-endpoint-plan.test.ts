// What a plan decides about the managed Codex endpoint, and what it does not. The marker is an
// intent for the launch, never a change to the printed line: a dry run prints the file's own
// command, and the attach is decided at launch time against the endpoint that actually exists.
// The scenes are pure — the plan starts nothing — and pin the four refusals: a policy that is
// not on, a line that already names its own `--remote` or `--no-daemon`, and a launcher whose
// own binary is not the Codex CLI (its endpoint is not ours to bind or to speak for).
import { describe, expect, test } from 'bun:test';
import { upPlan, type UpInput, type UpSeat } from '../../src/launch/plan.ts';

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
