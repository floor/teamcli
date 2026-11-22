// `team owner-seat install`: sets up, once, the owner state of a machine whose accounts share one
// owner (Linux): the system folder the pin and the machine record go in, the owner helper's own
// user and the ledger it alone writes, the helper's code in a folder the administrator owns, the
// launcher that starts it with an environment of its own, and the one privilege rule through which
// the named entity accounts start it (src/client/owner-spend.ts).
//
// The owner runs it from the administrator's account with sudo. `--dry-run` runs every check and
// prints every step, and changes nothing; a real run prints the same steps as it takes them and
// stops at the first that fails.
//
// Before anything changes, every path the install writes, and every folder above it up to `/`,
// is read without following links: a link anywhere, or a folder or file that someone other than
// the administrator owns (or, for the helper's own folders, the helper's user) or that its group
// or others may write, refuses the install. A folder only the administrator can change cannot be
// swapped under the install between that check and the step that writes in it.
//
// The helper's user is made by this install and recorded at once in an install record the
// administrator owns (its uid and gid). A user of that name with no record, or that differs from
// its record, is never adopted: an install stopped between making the user and recording it says
// so and names the repair. Every folder and file is made with `install` (its mode and owner set as
// it is made), and the rule is checked by the system's own checker before it is put in place.
// Running it again is safe; only the rule's account list changes, to the accounts named this time.

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from '../host/guarded-fs.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_NAME_PATTERN, OWNER_HELPER_FORMAT, SHARED_OWNER_LEDGER, SYSTEM_OWNER_FOLDER } from './owner-pin-path.ts';
import { OWNER_HELPER_APP, OWNER_HELPER_BUN, OWNER_HELPER_HOME, OWNER_HELPER_LAUNCHER, OWNER_HELPER_ROOT, OWNER_HELPER_TMP, OWNER_HELPER_USER } from './owner-spend.ts';
import { hostedCommit } from '../host/request-scope.ts';

export { OWNER_HELPER_HOME };
export const OWNER_HELPER_SUDOERS = '/etc/sudoers.d/teamcli-owner';
export const OWNER_INSTALL_RECORD = `${SYSTEM_OWNER_FOLDER}/owner-install.json`;
export const OWNER_INSTALL_FORMAT = 'team-owner-install-v1';
const OWNER_HELPER_RECORD = `${SYSTEM_OWNER_FOLDER}/owner-helper.json`;
/** Where the install stages the files it puts in place: a folder of the administrator's alone,
 *  below folders only the administrator can change — never the process's temporary folder, which
 *  its environment names. */
export const OWNER_INSTALL_STAGING = '/var/lib/teamcli-owner-install';
const NOLOGIN = '/usr/sbin/nologin';

/** One path as read without following links. */
export type PathStat = { kind: 'absent' } | { kind: 'present'; type: 'dir' | 'file' | 'link' | 'other'; uid: number; mode: number };

/** What the install touches, as a seam: tests pass a fake that records every command. */
export type InstallSystem = {
  platform: NodeJS.Platform;
  uid: () => number;
  /** Runs one command (absolute tools, no shell) and returns its status and output. */
  run: (argv: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  /** Reads one path without following a link. */
  lstat: (path: string) => PathStat;
  /** Reads one small file the administrator owns (the install record); null when it cannot. */
  read: (path: string) => string | null;
  /** The Bun the helper runs under: this process's own. */
  bun: string;
  /** The helper's program, bundled into one file; returns its text. */
  bundle: () => Promise<string>;
  /** Makes a fresh private folder under `root` (the install's own staging folder) for the files
   *  the install puts in place, and returns its path; it is removed after. */
  staging: (root: string) => string;
  write: (path: string, text: string) => void;
  remove: (path: string) => void;
};

export type InstallStep = { what: string; argv: string[] };
export type InstallOutcome = { ok: true; steps: InstallStep[]; ran: boolean } | { ok: false; why: string; steps: InstallStep[] };

/** The launcher: `/` as its folder, an environment written out in full, and only the calling
 *  account's identity passed on, as the privilege tool gave it. */
export function launcherText(): string {
  return [
    '#!/bin/sh',
    '# TeamCLI owner helper launcher (written by team owner-seat install). The privilege rule starts',
    '# this program alone. It starts Bun in / with an environment written out here in full: nothing',
    '# the caller or the machine\'s rule keeps reaches Bun, but the calling account as the privilege',
    '# tool named it.',
    'cd / || exit 1',
    `exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C HOME=${OWNER_HELPER_HOME} TMPDIR=${OWNER_HELPER_TMP} XDG_CONFIG_HOME=${OWNER_HELPER_HOME} XDG_CACHE_HOME=${OWNER_HELPER_TMP} BUN_INSTALL=${OWNER_HELPER_HOME} BUN_INSTALL_CACHE_DIR=${OWNER_HELPER_TMP} BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 TEAMCLI_CALLER_UID="$SUDO_UID" TEAMCLI_CALLER_USER="$SUDO_USER" ${OWNER_HELPER_BUN} --no-env-file ${OWNER_HELPER_APP}`,
    '',
  ].join('\n');
}

/** The privilege rule's text: these accounts may start exactly the launcher, with no arguments,
 *  as the helper's user, in `/`, keeping none of their environment. */
export function sudoersText(accounts: readonly string[]): string {
  return [
    '# TeamCLI owner helper (written by team owner-seat install; run it again to change the accounts).',
    '# The entity accounts below may start the owner helper\'s launcher as the helper\'s own user:',
    '# this exact program with no arguments, in /, keeping none of their environment, with no password.',
    `Cmnd_Alias TEAMCLI_OWNER_SPEND = ${OWNER_HELPER_LAUNCHER} ""`,
    'Defaults!TEAMCLI_OWNER_SPEND env_reset, !setenv, !env_keep',
    `${accounts.join(', ')} ALL = (${OWNER_HELPER_USER}) CWD=/ NOPASSWD: TEAMCLI_OWNER_SPEND`,
    '',
  ].join('\n');
}

function passwdEntry(system: InstallSystem, name: string): string[] | null {
  const got = system.run(['/usr/bin/getent', 'passwd', name]);
  if (got.status !== 0) return null;
  const fields = got.stdout.trim().split(':');
  return fields.length >= 7 && fields[0] === name ? fields : null;
}

function groupId(system: InstallSystem, name: string): number | null {
  const got = system.run(['/usr/bin/getent', 'group', name]);
  if (got.status !== 0) return null;
  const fields = got.stdout.trim().split(':');
  return fields.length >= 3 && fields[0] === name && /^[0-9]+$/.test(fields[2]!) ? Number(fields[2]) : null;
}

/** Every folder above `path`, up to and with `/`. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  let at = dirname(path);
  while (true) {
    out.push(at);
    if (at === '/') return out;
    at = dirname(at);
  }
}

/**
 * Why one path the install writes cannot be trusted, or null: a link, a thing of another type, an
 * owner outside `owners`, or a mode its group or others may write. `absent` is fine for a path
 * the install makes. Every folder above it must be a folder only the administrator (or, inside
 * the helper's own folder, the helper's user) can write, `/` among them.
 */
function pathProblem(system: InstallSystem, path: string, type: 'dir' | 'file', owners: readonly number[]): string | null {
  for (const folder of ancestors(path)) {
    const above = system.lstat(folder);
    if (above.kind === 'absent') continue;
    if (above.type === 'link') return `${folder} is a link; the install writes nothing through a link`;
    if (above.type !== 'dir') return `${folder} is not a folder`;
    if (!owners.includes(above.uid) || (above.mode & 0o022) !== 0) return `${folder} is not a folder only the administrator can change, so what the install puts below it could be swapped`;
  }
  const here = system.lstat(path);
  if (here.kind === 'absent') return null;
  if (here.type === 'link') return `${path} is a link; the install writes nothing through a link`;
  if (here.type !== type) return `${path} is not a ${type === 'dir' ? 'folder' : 'plain file'}`;
  if (!owners.includes(here.uid)) return `${path} exists and is owned by uid ${here.uid}, not by ${owners.includes(0) && owners.length === 1 ? 'the administrator' : `the administrator or ${OWNER_HELPER_USER}`}`;
  if ((here.mode & 0o022) !== 0) return `${path} exists and its group or others may write it`;
  return null;
}

type InstallRecord = { user: string; uid: number; gid: number };

function readInstallRecord(system: InstallSystem): InstallRecord | 'absent' | 'refused' {
  const stat = system.lstat(OWNER_INSTALL_RECORD);
  if (stat.kind === 'absent') return 'absent';
  if (stat.type !== 'file' || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return 'refused';
  const text = system.read(OWNER_INSTALL_RECORD);
  if (text === null) return 'refused';
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.format !== OWNER_INSTALL_FORMAT || raw.user !== OWNER_HELPER_USER) return 'refused';
    if (typeof raw.uid !== 'number' || !Number.isInteger(raw.uid) || raw.uid <= 0 || typeof raw.gid !== 'number' || !Number.isInteger(raw.gid) || raw.gid <= 0) return 'refused';
    return { user: raw.user, uid: raw.uid, gid: raw.gid };
  } catch {
    return 'refused';
  }
}

/**
 * Plans and, unless `dryRun`, runs the install for `accounts`. Refused off Linux, without root for
 * a real run, for an account the user database does not hold (or root's), for a helper user this
 * install did not make and record, and for any path it would write that is not safe to write.
 */
export async function installOwnerState(system: InstallSystem, accounts: readonly string[], dryRun: boolean): Promise<InstallOutcome> {
  const steps: InstallStep[] = [];
  const refuse = (why: string): InstallOutcome => ({ ok: false, why: `${why}; nothing was changed`, steps });
  if (system.platform !== 'linux') return { ok: false, why: 'this install is for a Linux machine whose accounts share one owner; on macOS the owner seat stays on this machine', steps };
  if (!dryRun && system.uid() !== 0) return { ok: false, why: "the install needs the administrator: run it with sudo from the owner's own account (or pass --dry-run to see what it does)", steps };
  const named = [...new Set(accounts)].sort();
  if (named.length === 0) return { ok: false, why: 'name the entity accounts with --account <a,b>', steps };
  for (const account of named) {
    if (!ACCOUNT_NAME_PATTERN.test(account) || account === OWNER_HELPER_USER) return refuse(`"${account}" is not an entity account name`);
    const entry = passwdEntry(system, account);
    if (entry === null) return refuse(`account ${account} is not in the user database; make it first`);
    if (entry[2] === '0') return refuse(`account ${account} is the administrator; entity accounts are unprivileged`);
  }

  // The helper's user: made here and recorded, or the one an earlier install recorded.
  const helper = passwdEntry(system, OWNER_HELPER_USER);
  const record = readInstallRecord(system);
  if (record === 'refused') return refuse(`${OWNER_INSTALL_RECORD} cannot be read, or is not a plain file only the administrator can write`);
  let helperUid: number | null = null;
  if (helper !== null && record === 'absent') {
    return refuse(`a user ${OWNER_HELPER_USER} exists that no install record names. If an earlier install stopped right after making it, remove that user (sudo userdel ${OWNER_HELPER_USER}, once no process of it runs) and run the install again; a user this install did not make is never adopted`);
  }
  if (helper === null && record !== 'absent') return refuse(`${OWNER_INSTALL_RECORD} names the user ${OWNER_HELPER_USER} (uid ${record.uid}), which the user database no longer holds; the owner state is not set up again over it`);
  if (helper !== null && record !== 'absent') {
    const gid = groupId(system, OWNER_HELPER_USER);
    if (helper[2] !== String(record.uid) || helper[3] !== String(record.gid) || gid !== record.gid || helper[5] !== OWNER_HELPER_HOME || helper[6] !== NOLOGIN) {
      return refuse(`the user ${OWNER_HELPER_USER} is not the one ${OWNER_INSTALL_RECORD} records (uid ${record.uid}, gid ${record.gid}, home ${OWNER_HELPER_HOME}, no login)`);
    }
    helperUid = record.uid;
  }

  // Every path written, and every folder above it, before anything changes.
  const rootOnly = [0];
  const helperOrRoot = helperUid === null ? [0] : [0, helperUid];
  const checks: Array<[string, 'dir' | 'file', readonly number[]]> = [
    [SYSTEM_OWNER_FOLDER, 'dir', rootOnly],
    [OWNER_INSTALL_RECORD, 'file', rootOnly],
    [OWNER_HELPER_RECORD, 'file', rootOnly],
    [OWNER_HELPER_ROOT, 'dir', rootOnly],
    [`${OWNER_HELPER_ROOT}/bin`, 'dir', rootOnly],
    [`${OWNER_HELPER_ROOT}/app`, 'dir', rootOnly],
    [OWNER_HELPER_BUN, 'file', rootOnly],
    [OWNER_HELPER_LAUNCHER, 'file', rootOnly],
    [OWNER_HELPER_APP, 'file', rootOnly],
    [OWNER_HELPER_HOME, 'dir', helperOrRoot],
    [SHARED_OWNER_LEDGER, 'dir', helperOrRoot],
    [OWNER_HELPER_TMP, 'dir', helperOrRoot],
    [OWNER_HELPER_SUDOERS, 'file', rootOnly],
    [OWNER_INSTALL_STAGING, 'dir', rootOnly],
  ];
  for (const [path, type, owners] of checks) {
    const problem = pathProblem(system, path, type, owners);
    if (problem !== null) return refuse(problem);
  }
  if (system.lstat(dirname(OWNER_HELPER_SUDOERS)).kind === 'absent') return refuse(`${dirname(OWNER_HELPER_SUDOERS)} does not exist; the privilege rule cannot be put in place`);

  const install = (mode: string, owner: string, from: string, to: string): string[] => ['/usr/bin/install', '-m', mode, '-o', owner, '-g', owner, from, to];
  const folders = (mode: string, owner: string, ...paths: string[]): string[] => ['/usr/bin/install', '-d', '-m', mode, '-o', owner, '-g', owner, ...paths];
  const stagingStep: InstallStep = { what: "the install's own staging folder, the administrator's alone", argv: folders('0700', 'root', OWNER_INSTALL_STAGING) };
  const plan = (staging: string) => {
    const planned: InstallStep[] = [];
    const bundled = join(staging, 'owner-spend.js');
    const launcher = join(staging, 'owner-spend.sh');
    const installRecord = join(staging, 'owner-install.json');
    const helperRecord = join(staging, 'owner-helper.json');
    const rule = join(staging, 'teamcli-owner.sudoers');
    planned.push({ what: "the system owner folder, the administrator's, read by every account", argv: folders('0755', 'root', SYSTEM_OWNER_FOLDER) });
    if (helper === null) {
      planned.push(
        { what: `make the owner helper's user ${OWNER_HELPER_USER} (a system user, no login, no home made)`, argv: ['/usr/sbin/useradd', '--system', '--user-group', '--home-dir', OWNER_HELPER_HOME, '--no-create-home', '--shell', NOLOGIN, OWNER_HELPER_USER] },
        { what: 'record that this install made that user (its uid and gid), at once', argv: install('0644', 'root', installRecord, OWNER_INSTALL_RECORD) },
      );
    }
    planned.push(
      { what: "the helper's code folders, the administrator's", argv: folders('0755', 'root', OWNER_HELPER_ROOT, `${OWNER_HELPER_ROOT}/bin`, `${OWNER_HELPER_ROOT}/app`) },
      { what: 'the Bun the helper runs under, copied so no account can replace it', argv: install('0755', 'root', system.bun, OWNER_HELPER_BUN) },
      { what: "the helper's launcher, which starts Bun with an environment of its own", argv: install('0755', 'root', launcher, OWNER_HELPER_LAUNCHER) },
      { what: "the helper's program, bundled into one file", argv: install('0644', 'root', bundled, OWNER_HELPER_APP) },
      { what: "the helper's folder and the ledger, written by the helper alone and read by every account", argv: folders('0755', OWNER_HELPER_USER, OWNER_HELPER_HOME, SHARED_OWNER_LEDGER) },
      { what: "the helper's own temporary folder", argv: folders('0700', OWNER_HELPER_USER, OWNER_HELPER_TMP) },
      { what: "the helper's record in the system owner folder (its user and uid)", argv: install('0644', 'root', helperRecord, OWNER_HELPER_RECORD) },
      { what: "check the privilege rule with the system's own checker", argv: ['/usr/sbin/visudo', '-cf', rule] },
      { what: `the privilege rule: ${named.join(', ')} may start the helper as ${OWNER_HELPER_USER}`, argv: install('0440', 'root', rule, OWNER_HELPER_SUDOERS) },
    );
    return { planned, bundled, launcher, installRecord, helperRecord, rule };
  };
  if (dryRun) {
    steps.push(stagingStep, ...plan(`${OWNER_INSTALL_STAGING}/<run>`).planned);
    return { ok: true, steps, ran: false };
  }
  // The staging folder first, checked once made: the administrator's, a folder, and closed to
  // everyone else, below folders only the administrator can change (checked above). Then a fresh
  // folder in it for this run, checked the same way. Nothing is staged anywhere else.
  steps.push(stagingStep);
  const madeStaging = system.run(stagingStep.argv);
  if (madeStaging.status !== 0) return { ok: false, why: `${stagingStep.what}: ${stagingStep.argv.join(' ')} failed (${(madeStaging.stderr || madeStaging.stdout).trim().split('\n')[0] ?? `status ${madeStaging.status}`}); nothing else was changed`, steps };
  const closed = (path: string): boolean => {
    const stat = system.lstat(path);
    return stat.kind === 'present' && stat.type === 'dir' && stat.uid === 0 && (stat.mode & 0o077) === 0;
  };
  if (!closed(OWNER_INSTALL_STAGING)) return refuse(`${OWNER_INSTALL_STAGING} is not a folder of the administrator's alone`);
  let staging: string;
  try {
    staging = system.staging(OWNER_INSTALL_STAGING);
  } catch {
    return refuse(`no folder for this run can be made in ${OWNER_INSTALL_STAGING}`);
  }
  const { planned, bundled, launcher, installRecord, helperRecord, rule } = plan(staging);
  steps.push(...planned);
  try {
    if (!closed(staging)) return refuse(`${staging} is not a folder of the administrator's alone`);
    let program: string;
    try {
      program = await system.bundle();
    } catch (error) {
      return refuse(`the owner helper's program could not be bundled from this build (${error instanceof Error ? error.message : 'no reason given'})`);
    }
    system.write(bundled, program);
    system.write(launcher, launcherText());
    system.write(rule, sudoersText(named));
    let made: InstallRecord | null = record === 'absent' ? null : record;
    for (const step of planned) {
      // The records are written once the user exists, from the user database.
      if (step.argv.includes(installRecord)) {
        const entry = passwdEntry(system, OWNER_HELPER_USER);
        const uid = entry === null ? NaN : Number(entry[2]);
        const gid = entry === null ? NaN : Number(entry[3]);
        if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) return { ok: false, why: `the user ${OWNER_HELPER_USER} cannot be read back from the user database; it was made but not recorded, so the next install refuses it until it is removed (sudo userdel ${OWNER_HELPER_USER})`, steps };
        made = { user: OWNER_HELPER_USER, uid, gid };
        system.write(installRecord, `${JSON.stringify({ format: OWNER_INSTALL_FORMAT, ...made, made_by: 'team owner-seat install' }, null, 2)}\n`);
      }
      if (step.argv.includes(helperRecord)) {
        if (made === null) return { ok: false, why: `the user ${OWNER_HELPER_USER} has no install record`, steps };
        system.write(helperRecord, `${JSON.stringify({ format: OWNER_HELPER_FORMAT, user: OWNER_HELPER_USER, uid: made.uid }, null, 2)}\n`);
      }
      const done = system.run(step.argv);
      if (done.status !== 0) return { ok: false, why: `${step.what}: ${step.argv.join(' ')} failed (${(done.stderr || done.stdout).trim().split('\n')[0] ?? `status ${done.status}`}); the steps before it stand, and running the install again is safe`, steps };
    }
    return { ok: true, steps, ran: true };
  } finally {
    system.remove(staging);
  }
}

/** The real system: this process's Bun, the helper's program bundled from this build. */
export function realInstallSystem(): InstallSystem {
  return {
    platform: process.platform,
    uid: () => process.getuid?.() ?? -1,
    run: (argv) => {
      hostedCommit('node:child_process.spawnSync');
      const run = spawnSync(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: Infinity, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? (run.error?.message ?? '') };
    },
    lstat: (path) => {
      try {
        const stat = lstatSync(path);
        const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
        return { kind: 'present', type, uid: stat.uid, mode: stat.mode & 0o7777 };
      } catch (error) {
        // Only a path that names nothing is absent; any other failure reads as an untrusted link.
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'present', type: 'other', uid: -1, mode: 0o777 };
      }
    },
    read: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    bun: process.execPath,
    bundle: async () => {
      const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './owner-spend-main.ts' : './owner-spend-main.js', import.meta.url));
      // The helper runs under Bun, and only Bun bundles it: the install refuses under any other runtime.
      const bun = (globalThis as { Bun?: { build?: (options: { entrypoints: string[]; target: 'bun' }) => Promise<{ success: boolean; outputs: Array<{ text(): Promise<string> }> }> } }).Bun;
      if (bun?.build === undefined) throw new Error('the install runs under Bun, which bundles the helper; run it with bun');
      const built = await bun.build({ entrypoints: [entry], target: 'bun' });
      if (!built.success || built.outputs.length !== 1) throw new Error('the bundler gave no single program');
      return await built.outputs[0]!.text();
    },
    staging: (root) => mkdtempSync(join(root, 'run-')),
    write: (path, text) => writeFileSync(path, text, { mode: 0o600, flag: 'wx' }),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
  };
}
