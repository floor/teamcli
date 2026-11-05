// The service manager's own record of the running daemon, in the verbatim form a read of the
// running service produced on 2026-11-01: both commands, every line field for field. The
// adapter's parser is the only reader, so these scenes give it the captured text and nothing
// else. The shapes were supplied from that read, not measured by this seat.
//
// Paths and environment values are synthetic, and the job's pid, program and launch words are
// this process's own, because the admission compares the record with the process it runs in.
// Every other line's form, order and field spelling is the captured output's.
//
// A unit written now names no general grant and no client key. The captured stopgap unit did,
// and once the daemon's own words are a fresh install's, that unit's words no longer match them;
// the stopgap scene keeps the captured form and is refused, which is the check that keeps a
// copied or edited unit from being run.
//
// No scene runs a service-manager command, starts a daemon or touches a real unit: the live
// adapter's runner is injected.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { DAEMON_LABEL } from '../src/daemon/paths.ts';
import { systemServiceManager } from '../src/daemon/service.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const bases: string[] = [];

function scratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-excerpt-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** The launch words this process actually carries; a unit that matches them is the one it was
 *  started from. They name no grant and no key, the same shape an install writes now. */
const OWN_WORDS: readonly string[] = [process.execPath, ...process.argv.slice(1)];

/** The captured stopgap unit's words: a general grant and a client key an install no longer
 *  writes. The first word is this process's executable so only the words differ. */
const STOPGAP_WORDS: readonly string[] = [
  process.execPath,
  '/synthetic/team/dist/cli.js',
  'daemon',
  'run',
  '--started-by',
  'service-manager',
  '--root',
  '/synthetic/material',
  '--presence',
  '--watch',
  '--general',
  '/synthetic/grant',
  '--key',
  '/synthetic/key',
];

type Captured = { pid: number; program: string; words: readonly string[] };

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `launchctl print`'s answer as captured: the job block, the arguments block, the environment
 *  blocks, the job's counters, and the coalition blocks that follow them. */
function printText(captured: Captured, unit: string): string {
  const words = captured.words.map((word) => `\t\t${word}`).join('\n');
  return `gui/501/${DAEMON_LABEL} = {
	active count = 1
	path = ${unit}
	type = LaunchAgent
	state = running

	program = ${captured.program}
	arguments = {
${words}
	}

	working directory = /synthetic/home

	stdout path = /synthetic/home/.config/team/daemon.log
	stderr path = /synthetic/home/.config/team/daemon.log
	inherited environment = {
		SSH_AUTH_SOCK => /var/run/synthetic-listeners
	}

	default environment = {
		PATH => /usr/bin:/bin:/usr/sbin:/sbin
	}

	environment = {
		OSLogRateLimit => 64
		PATH => /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
		XPC_SERVICE_NAME => ${DAEMON_LABEL}
	}

	domain = gui/501 [100025]
	asid = 100025
	minimum runtime = 10
	exit timeout = 5
	runs = 1
	pid = ${String(captured.pid)}
	immediate reason = speculative
	forks = 586
	execs = 1
	initialized = 1
	trampolined = 1
	started suspended = 0
	proxy started suspended = 0
	checked allocations = 0 (queried = 1)
	checked allocations reason = no host
	checked allocations flags = 0x0
	last exit code = (never exited)

	semaphores = {
		successful exit => 0
	}

	resource coalition = {
		ID = 109368
		type = resource
		state = active
		active count = 1
		name = ${DAEMON_LABEL}
	}

	jetsam coalition = {
		ID = 109369
		type = jetsam
		state = active
		active count = 1
		name = ${DAEMON_LABEL}
	}

	spawn type = background (5)
	jetsam priority = 40
	jetsam memory limit (active) = (unlimited)
	jetsam memory limit (inactive) = (unlimited)
	jetsamproperties category = daemon
	jetsam thread limit = 32
	cpumon = default

	properties = runatload | inferred program
}`;
}

/** `launchctl list`'s answer as captured: the plist dict without the surrounding plist tags. */
function listText(captured: Captured): string {
  const words = captured.words.map((word) => `\t\t"${word}";`).join('\n');
  return `{
	"StandardOutPath" = "/synthetic/home/.config/team/daemon.log";
	"LimitLoadToSessionType" = "Aqua";
	"StandardErrorPath" = "/synthetic/home/.config/team/daemon.log";
	"Label" = "${DAEMON_LABEL}";
	"OnDemand" = true;
	"LastExitStatus" = 0;
	"PID" = ${String(captured.pid)};
	"Program" = "${captured.program}";
	"ProgramArguments" = (
${words}
	);
};`;
}

/** The unit the job was started from: the daemon's own label, this user's file, and the words
 *  the scene gives it. */
function writeUnit(home: string, words: readonly string[]): string {
  const path = join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
  mkdirSync(dirname(path), { recursive: true });
  const args = words.map((word) => `    <string>${xml(word)}</string>`).join('\n');
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`);
  chmodSync(path, 0o600);
  return path;
}

type StartInput = Parameters<NonNullable<DaemonCommandSources['start']>>[0];

type Run = { code: number; out: string; err: string; started: StartInput[]; asked: string[] };

async function startWith(
  kind: 'print' | 'list',
  captured: Captured,
  unitWords: readonly string[] = OWN_WORDS,
): Promise<Run> {
  const { root, home } = scratch();
  const unit = writeUnit(home, unitWords);
  const asked: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const runner = (command: string, args: string[]): { status: number; stdout: string; stderr: string } => {
    asked.push([command, ...args].join(' '));
    if (command !== 'launchctl') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') {
      return kind === 'print'
        ? { status: 0, stdout: printText(captured, unit), stderr: '' }
        : { status: 113, stdout: '', stderr: 'synthetic: no such service' };
    }
    if (args[0] === 'list') {
      return kind === 'list'
        ? { status: 0, stdout: listText(captured), stderr: '' }
        : { status: 113, stdout: '', stderr: 'synthetic: no such service' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const manager = systemServiceManager({ platform: 'darwin', uid, accountHome: home, sleep: () => {}, runner });
  if (manager === null) throw new Error('the darwin adapter did not answer');
  const io = testIo(root, { kind: 'owner-no-tty' });
  const started: StartInput[] = [];
  const code = await runDaemon(['run', '--started-by', 'service-manager', '--root', root], io, {
    home,
    accountHome: home,
    service: manager,
    start: async (input) => {
      started.push(input);
      return { kind: 'already-running', pid: 42 };
    },
  });
  return { code, out: io.out, err: io.err, started, asked };
}

const CHECK_PREFIX = "only the owner or the system's service manager starts the machine daemon: ";
const thisProcess: Captured = { pid: process.pid, program: process.execPath, words: OWN_WORDS };

describe('the admission parser reads the manager\'s captured answer', () => {
  test('the printed record of the running job admits the start', async () => {
    const ran = await startWith('print', thisProcess);
    expect(ran.code, ran.err + ran.out).toBe(0);
    expect(ran.started.length).toBe(1);
    expect(ran.started[0]?.startedBy).toBe('service-manager');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    expect(ran.asked[0]).toBe(`launchctl print gui/${String(uid)}/${DAEMON_LABEL}`);
  });

  test('the list form refuses when the printed record cannot be read', async () => {
    // The list form names the job's program but not the unit it was loaded from, so the
    // adapter cannot bind the record to the unit this home owns and refuses closed.
    const ran = await startWith('list', thisProcess);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the record of the job does not name this process`);
    expect(ran.started.length).toBe(0);
    expect(ran.asked.some((one) => one === `launchctl list ${DAEMON_LABEL}`)).toBe(true);
  });

  test('the captured stopgap unit is refused: its words are not this process\'s own', async () => {
    const ran = await startWith('print', { ...thisProcess, words: STOPGAP_WORDS }, STOPGAP_WORDS);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the record and the unit do not run this executable with these words`);
    expect(ran.started.length).toBe(0);
  });
});
