// `team start`, without the empty-account door. An account with no durable record stops
// on bootstrap and writes nothing: that door is not this command. A caller the ordinary
// map already admits (the owner, once a durable record exists) gets one pass: detect the
// folder, write the small preset, register the root as running, then init, up, and the
// lead's send through the ordinary send command. A folder that already holds a team file,
// with no preset step recorded, is refused. The registry is noted only on the pass that
// wrote the file. A later run resumes at the first step that is not done. It does not
// call `team config` and it does not grant a sender.
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, isOwner } from '../caller.ts';
import { daemonSocketPath } from '../daemon/paths.ts';
import { charterPath } from '../charter/body.ts';
import type { Command, Io } from '../io.ts';
import { presetMayStaff, sandboxRootFor } from '../launchers/sandbox-root.ts';
import { noteTeam } from '../registry/teams.ts';
import { checkLogin } from './doctor.ts';
import { profileFor } from '../profiles/index.ts';
import { StartFiles, StartFilesError } from '../start/files.ts';

export const USAGE = `Usage: team start [--json]

The folder is the one this session is in. An empty account stops on bootstrap
and writes nothing. A later run resumes at the first step that is not done.

  --json  the proof and the six timestamps, as one JSON document

Exits 0 when the pass is complete, 1 when a step is not done, 2 when the
invocation cannot be read.
`;

const PRESET_CLIS = ['grok', 'cursor', 'claude-code', 'codex'] as const;

const VENDOR: Record<(typeof PRESET_CLIS)[number], string> = {
  grok: 'xai',
  cursor: 'cursor',
  'claude-code': 'anthropic',
  codex: 'openai',
};

export type StartSendResult = {
  ok: boolean;
  id: string | null;
  arrived: boolean;
  read: boolean;
  working: boolean;
  claimedTask: string | null;
};

export type StartSources = {
  home?: string;
  now?: () => number;
  loggedIn?: (cli: string) => boolean;
  notifyRoot?: (root: string) => void;
  init?: (root: string, io: Io) => Promise<number>;
  up?: (root: string, io: Io) => Promise<number>;
  check?: (root: string) => boolean;
  ready?: () => { lead: boolean; builder: boolean };
  send?: (input: { lead: string; builder: string; body: string }) => Promise<StartSendResult>;
  daemonRunning?: () => boolean;
};

type Steps = {
  detect?: boolean;
  preset?: boolean;
  init?: boolean;
  up?: boolean;
  exchange?: boolean;
  exchangeId?: string;
  working?: boolean;
  clis?: string[];
};

type Report = {
  versionOk: boolean;
  daemonRunning: boolean;
  roots: number;
  teamFile: boolean;
  checkClean: boolean;
  readyLead: boolean;
  readyBuilder: boolean;
  exchangeId: string | null;
  exchangeArrived: boolean;
  exchangeRead: boolean;
  working: boolean;
  claimedTask: string | null;
  bootstrapMs: number;
  detectMs: number;
  upMs: number;
  exchangeMs: number;
  startedMs: number;
};

const FAILED_SEND: StartSendResult = {
  ok: false, id: null, arrived: false, read: false, working: false, claimedTask: null,
};

function durableRecordExists(home: string): boolean {
  const paths = [
    join(home, '.config', 'team', 'teams.yaml'),
    join(home, '.config', 'team', 'projects.yaml'),
    join(home, '.config', 'team', 'entities.yaml'),
    join(home, '.config', 'team', 'owner-seat.json'),
    join(home, '.config', 'team', 'grants'),
    join(home, '.config', 'team-key'),
    charterPath(home),
  ];
  return paths.some((path) => existsSync(path));
}

function projectName(root: string): string {
  const base = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base === '' ? 'project' : base.slice(0, 40);
}

function readSteps(text: string | undefined): Steps {
  try {
    const parsed = JSON.parse(text ?? '{}') as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Steps;
  } catch {
    return {};
  }
}

function detectFolder(root: string, now: () => number): string {
  const deadline = now() + 1_000;
  const bits: string[] = [];
  for (const name of ['README.md', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml']) {
    if (now() >= deadline) break;
    if (existsSync(join(root, name))) bits.push(name);
  }
  if (now() < deadline && existsSync(join(root, '.git'))) bits.push('git');
  return bits.join(', ');
}

function presetText(name: string, clis: readonly [string, string]): string {
  const seat = (role: string, seatName: string, cli: string, leads: boolean): string => {
    const vendor = VENDOR[cli as (typeof PRESET_CLIS)[number]] ?? cli;
    return [
      '  - role: ' + role,
      '    name: ' + seatName,
      '    cli: ' + cli,
      '    vendor: ' + vendor,
      '    model: ' + cli,
      '    version: "0"',
      '    launch: ' + cli,
      ...(leads ? ['    leads: true'] : []),
    ].join('\n');
  };
  return [
    'format: 1',
    `project: ${name}`,
    'coordinator: lead',
    'operator: builder',
    `session: ${name}`,
    'workspace:',
    '  mode: shared',
    'seats:',
    seat('coordinator', 'lead', clis[0], true),
    seat('worker', 'builder', clis[1], false),
    '',
  ].join('\n');
}

function notifyDaemon(home: string, root: string): void {
  const socketPath = daemonSocketPath(home);
  if (!existsSync(socketPath)) return;
  const socket = connect({ path: socketPath });
  socket.unref();
  const timer = setTimeout(() => socket.destroy(), 200);
  timer.unref();
  socket.once('connect', () => {
    socket.end(`${JSON.stringify({ v: 2, id: 'root.added', op: 'root.added', scope: { root } })}\n`);
  });
  socket.once('error', () => {
    clearTimeout(timer);
    socket.destroy();
  });
}

function signedIn(cli: string): boolean {
  const profile = profileFor(cli);
  if (!profile) return false;
  return checkLogin(profile) === true;
}

function quiet(io: Io): Io {
  return { ...io, stdout() {}, stderr() {} };
}

const command: Command = (argv, io) => runStart(argv, io);

export async function runStart(argv: string[], io: Io, sources: StartSources = {}): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  if (args.error || args.rest.length > 0) {
    io.stderr(`team start: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    return 2; // exit: start.usage
  }
  const json = args.flags.has('json');
  const now = sources.now ?? Date.now;
  const begun = now();
  const home = sources.home ?? homedir();
  const root = io.cwd;
  const report: Report = {
    versionOk: true,
    daemonRunning: false,
    roots: 0,
    teamFile: false,
    checkClean: false,
    readyLead: false,
    readyBuilder: false,
    exchangeId: null,
    exchangeArrived: false,
    exchangeRead: false,
    working: false,
    claimedTask: null,
    bootstrapMs: 0,
    detectMs: 0,
    upMs: 0,
    exchangeMs: 0,
    startedMs: 0,
  };
  const finish = (code: number, mark: () => void): void => {
    mark();
    if (json) io.stdout(`${JSON.stringify(report)}\n`);
    else io.stderr(`team start: ${code === 0 ? 'started' : 'a step is not done'}\n`);
  };

  if (!durableRecordExists(home)) {
    finish(1, () => {
      report.bootstrapMs = now() - begun;
    });
    return 1; // exit: start.bootstrap
  }
  report.bootstrapMs = now() - begun;
  if (!isOwner(callerOf(io))) {
    io.stderr('team start: only the owner starts a team on this account\n');
    finish(1, () => {
      report.detectMs = now() - begun;
    });
    return 1; // exit: start.caller
  }

  let files: StartFiles | undefined;
  try {
    files = new StartFiles(root);
    const sandbox = sandboxRootFor({ mode: 'shared', projectRoot: root });
    const steps = readSteps(files.check()['start.json']?.text);
    const teamFile = join(root, '.agents', 'team.yaml');
    // The team-file check comes before any start.json write. A refusal leaves the folder as it was.
    if (steps.preset !== true && existsSync(teamFile)) {
      report.teamFile = true;
      io.stderr('team start: this folder already holds a team; run team up\n');
      finish(1, () => {
        report.detectMs = now() - begun;
      });
      return 1; // exit: start.existing-team
    }
    const loggedIn = sources.loggedIn ?? signedIn;
    let clis = steps.clis?.slice(0, 2) ?? [];
    if (steps.detect !== true) {
      detectFolder(root, now);
      const staffed = PRESET_CLIS.filter((cli) => presetMayStaff({
        cli,
        loggedIn: loggedIn(cli),
        sandboxRoot: sandbox.ok ? sandbox.root : root,
        folder: root,
      }));
      if (staffed.length < 2) {
        finish(1, () => {
          report.detectMs = now() - begun;
        });
        return 1; // exit: start.clis
      }
      clis = staffed.slice(0, 2);
      steps.detect = true;
      steps.clis = clis;
      files.write('start.json', `${JSON.stringify(steps)}\n`);
    }
    report.detectMs = now() - begun;

    let wrotePreset = false;
    if (steps.preset !== true) {
      files.write('team.yaml', presetText(projectName(root), [clis[0] ?? 'grok', clis[1] ?? 'cursor']), true);
      steps.preset = true;
      files.write('start.json', `${JSON.stringify(steps)}\n`);
      wrotePreset = true;
    }
    report.teamFile = existsSync(teamFile);

    files.check();
    if (wrotePreset) {
      const noted = noteTeam(home, root, {
        project: projectName(root),
        entity: null,
        session: projectName(root),
        lobby: null,
      }, 'running', 'owner');
      if (noted === null) {
        (sources.notifyRoot ?? ((path: string) => notifyDaemon(home, path)))(root);
        report.roots = 1;
        report.daemonRunning = sources.daemonRunning?.() ?? false;
      }
    } else if (steps.preset === true) {
      report.roots = 1;
      report.daemonRunning = sources.daemonRunning?.() ?? false;
    }

    files.check();
    if (steps.init !== true) {
      const code = await (sources.init ?? (async (project: string, stream: Io) => {
        const { default: run } = await import('./init.ts');
        return run(['--file', join(project, '.agents', 'team.yaml')], quiet(stream));
      }))(root, io);
      if (code === 0) {
        steps.init = true;
        files.write('start.json', `${JSON.stringify(steps)}\n`);
      }
    }
    files.check();
    report.checkClean = sources.check?.(root) ?? false;
    files.check();
    if (steps.up !== true) {
      const upBegun = now();
      const code = await (sources.up ?? (async (_project: string, stream: Io) => {
        const { default: run } = await import('./up.ts');
        return run([], quiet(stream));
      }))(root, io);
      report.upMs = now() - upBegun;
      if (code === 0) {
        steps.up = true;
        files.write('start.json', `${JSON.stringify(steps)}\n`);
      }
    } else {
      report.upMs = 0;
    }
    files.check();
    const ready = sources.ready?.() ?? { lead: false, builder: false };
    report.readyLead = ready.lead;
    report.readyBuilder = ready.builder;

    files.check();
    const body = 'send the builder its first task now';
    if (steps.exchange === true && steps.exchangeId !== undefined) {
      report.exchangeId = steps.exchangeId;
      report.exchangeArrived = true;
      report.exchangeRead = true;
      report.working = steps.working === true;
      report.claimedTask = steps.exchangeId;
      report.exchangeMs = 0;
    } else {
      const exchangeBegun = now();
      const sent = await (sources.send ?? (async (input: { lead: string; builder: string; body: string }) => {
        const { default: run } = await import('./send.ts');
        const code = await run([input.builder, input.body], quiet(io));
        return { ...FAILED_SEND, ok: code === 0 };
      }))({
        lead: 'lead',
        builder: 'builder',
        body,
      });
      report.exchangeMs = now() - exchangeBegun;
      if (sent.ok && sent.id !== null) {
        report.exchangeId = sent.id;
        report.exchangeArrived = sent.arrived;
        report.exchangeRead = sent.read;
        report.working = sent.working;
        report.claimedTask = sent.claimedTask ?? sent.id;
        if (sent.arrived && sent.read) {
          steps.exchange = true;
          steps.exchangeId = sent.id;
          steps.working = sent.working;
          files.write('start.json', `${JSON.stringify(steps)}\n`);
        }
      }
    }
    files.check();
    report.startedMs = now() - begun;
    const complete = report.daemonRunning && report.roots === 1 && report.teamFile && report.checkClean
      && report.readyLead && report.readyBuilder && report.exchangeId !== null && report.exchangeArrived
      && report.exchangeRead && report.working && report.claimedTask === report.exchangeId;
    finish(complete ? 0 : 1, () => {});
    if (complete) {
      return 0; // exit: start.complete
    }
    return 1; // exit: start.incomplete
  } catch (error) {
    if (!(error instanceof StartFilesError)) throw error;
    io.stderr(`team start: setup files refused: ${error.message}\n`);
    finish(1, () => { report.startedMs = now() - begun; });
    return 1; // exit: start.files
  } finally {
    files?.close();
  }
};

export default command;
