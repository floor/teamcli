// `team owner-seat install`: sets up, once, the owner state of a machine whose accounts share one
// owner (Linux): the system folder the pin and the machine record go in, the owner helper's own
// user and the ledger it alone writes, the helper's code in a folder the administrator owns, and
// the one privilege rule through which the named entity accounts start it (src/client/owner-spend.ts).
//
// The owner runs it from the administrator's account with sudo. `--dry-run` prints every step and
// changes nothing; a real run prints the same steps as it takes them and stops at the first that
// fails. Every folder and file is made with `install` (its mode and owner set as it is made), the
// rule is checked by the system's own checker before it is put in place, and a user of the
// helper's name that this install did not make is refused, never changed. Running it again is
// safe: each step leaves what is already right as it is. Only the rule's account list changes,
// to the accounts named this time.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_NAME_PATTERN, OWNER_HELPER_FORMAT, SHARED_OWNER_LEDGER, SYSTEM_OWNER_FOLDER } from './owner-pin-path.ts';
import { OWNER_HELPER_APP, OWNER_HELPER_BUN, OWNER_HELPER_ROOT, OWNER_HELPER_USER } from './owner-spend.ts';

export const OWNER_HELPER_HOME = '/var/lib/teamcli-owner';
export const OWNER_HELPER_SUDOERS = '/etc/sudoers.d/teamcli-owner';
const NOLOGIN = '/usr/sbin/nologin';

/** What the install touches, as a seam: tests pass a fake that records every command. */
export type InstallSystem = {
  platform: NodeJS.Platform;
  uid: () => number;
  /** Runs one command (absolute tools, no shell) and returns its status and output. */
  run: (argv: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  /** The Bun the helper runs under: this process's own. */
  bun: string;
  /** The helper's program, bundled into one file; returns its text. */
  bundle: () => Promise<string>;
  /** A private folder for the files the install puts in place; removed after. */
  staging: () => string;
  write: (path: string, text: string) => void;
  remove: (path: string) => void;
};

export type InstallStep = { what: string; argv: string[] };
export type InstallOutcome = { ok: true; steps: InstallStep[]; ran: boolean } | { ok: false; why: string; steps: InstallStep[] };

/** The privilege rule's text: these accounts may start exactly the helper's program, as its user, in `/`, with a reset environment. */
export function sudoersText(accounts: readonly string[]): string {
  return [
    '# TeamCLI owner helper (written by team owner-seat install; run it again to change the accounts).',
    '# The entity accounts below may start the owner helper as its own user: this exact command and',
    '# no other arguments, in /, with a reset environment, and with no password.',
    `Cmnd_Alias TEAMCLI_OWNER_SPEND = ${OWNER_HELPER_BUN} ${OWNER_HELPER_APP}`,
    'Defaults!TEAMCLI_OWNER_SPEND env_reset, !setenv',
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

/**
 * Plans and, unless `dryRun`, runs the install for `accounts`. Refused off Linux, without root for
 * a real run, for an account the user database does not hold (or root's), and when a user of the
 * helper's name exists that this install did not make.
 */
export async function installOwnerState(system: InstallSystem, accounts: readonly string[], dryRun: boolean): Promise<InstallOutcome> {
  const steps: InstallStep[] = [];
  if (system.platform !== 'linux') return { ok: false, why: 'this install is for a Linux machine whose accounts share one owner; on macOS the owner seat stays on this machine', steps };
  if (!dryRun && system.uid() !== 0) return { ok: false, why: "the install needs the administrator: run it with sudo from the owner's own account (or pass --dry-run to see what it does)", steps };
  const named = [...new Set(accounts)].sort();
  if (named.length === 0) return { ok: false, why: 'name the entity accounts with --account <name>[,<name>…]', steps };
  for (const account of named) {
    if (!ACCOUNT_NAME_PATTERN.test(account) || account === OWNER_HELPER_USER) return { ok: false, why: `"${account}" is not an entity account name`, steps };
    const entry = passwdEntry(system, account);
    if (entry === null) return { ok: false, why: `account ${account} is not in the user database; make it first`, steps };
    if (entry[2] === '0') return { ok: false, why: `account ${account} is the administrator; entity accounts are unprivileged`, steps };
  }
  const helper = passwdEntry(system, OWNER_HELPER_USER);
  if (helper !== null && (helper[5] !== OWNER_HELPER_HOME || helper[6] !== NOLOGIN || helper[2] === '0')) {
    return { ok: false, why: `a user ${OWNER_HELPER_USER} exists that this install did not make (home ${helper[5]}, shell ${helper[6]}); nothing was changed`, steps };
  }
  const staging = dryRun ? '<staging>' : system.staging();
  const bundled = join(staging, 'owner-spend.js');
  const record = join(staging, 'owner-helper.json');
  const rule = join(staging, 'teamcli-owner.sudoers');
  try {
    if (helper === null) {
      steps.push({ what: `make the owner helper's user ${OWNER_HELPER_USER} (a system user, no login, no home made)`, argv: ['/usr/sbin/useradd', '--system', '--user-group', '--home-dir', OWNER_HELPER_HOME, '--no-create-home', '--shell', NOLOGIN, OWNER_HELPER_USER] });
    }
    steps.push(
      { what: 'the system owner folder, the administrator\'s, read by every account', argv: ['/usr/bin/install', '-d', '-m', '0755', '-o', 'root', '-g', 'root', SYSTEM_OWNER_FOLDER] },
      { what: "the helper's code folders, the administrator's", argv: ['/usr/bin/install', '-d', '-m', '0755', '-o', 'root', '-g', 'root', OWNER_HELPER_ROOT, `${OWNER_HELPER_ROOT}/bin`, `${OWNER_HELPER_ROOT}/app`] },
      { what: 'the Bun the helper runs under, copied so no account can replace it', argv: ['/usr/bin/install', '-m', '0755', '-o', 'root', '-g', 'root', system.bun, OWNER_HELPER_BUN] },
      { what: "the helper's program, bundled into one file", argv: ['/usr/bin/install', '-m', '0644', '-o', 'root', '-g', 'root', bundled, OWNER_HELPER_APP] },
      { what: "the helper's folder and the ledger, written by the helper alone and read by every account", argv: ['/usr/bin/install', '-d', '-m', '0755', '-o', OWNER_HELPER_USER, '-g', OWNER_HELPER_USER, OWNER_HELPER_HOME, SHARED_OWNER_LEDGER] },
      { what: "the helper's record in the system owner folder (its user and uid)", argv: ['/usr/bin/install', '-m', '0644', '-o', 'root', '-g', 'root', record, `${SYSTEM_OWNER_FOLDER}/owner-helper.json`] },
      { what: 'check the privilege rule with the system\'s own checker', argv: ['/usr/sbin/visudo', '-cf', rule] },
      { what: `the privilege rule: ${named.join(', ')} may start the helper as ${OWNER_HELPER_USER}`, argv: ['/usr/bin/install', '-m', '0440', '-o', 'root', '-g', 'root', rule, OWNER_HELPER_SUDOERS] },
    );
    if (dryRun) return { ok: true, steps, ran: false };
    let program: string;
    try {
      program = await system.bundle();
    } catch {
      return { ok: false, why: "the owner helper's program could not be bundled from this build; nothing was changed", steps };
    }
    system.write(bundled, program);
    system.write(rule, sudoersText(named));
    for (const step of steps) {
      if (step.argv.includes(record)) {
        // The uid is read once the user exists, from the user database.
        const made = passwdEntry(system, OWNER_HELPER_USER);
        const uid = made === null ? NaN : Number(made[2]);
        if (!Number.isInteger(uid) || uid <= 0) return { ok: false, why: `the user ${OWNER_HELPER_USER} cannot be read back from the user database`, steps };
        system.write(record, `${JSON.stringify({ format: OWNER_HELPER_FORMAT, user: OWNER_HELPER_USER, uid }, null, 2)}\n`);
      }
      const done = system.run(step.argv);
      if (done.status !== 0) return { ok: false, why: `${step.what}: ${step.argv.join(' ')} failed (${(done.stderr || done.stdout).trim().split('\n')[0] ?? `status ${done.status}`}); the steps before it stand, and running the install again is safe`, steps };
    }
    return { ok: true, steps, ran: true };
  } finally {
    if (!dryRun) system.remove(staging);
  }
}

/** The real system: this process's Bun, the helper's program bundled from this build. */
export function realInstallSystem(): InstallSystem {
  return {
    platform: process.platform,
    uid: () => process.getuid?.() ?? -1,
    run: (argv) => {
      const run = Bun.spawnSync([...argv], { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      return { status: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
    },
    bun: process.execPath,
    bundle: async () => {
      const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './owner-spend-main.ts' : './owner-spend-main.js', import.meta.url));
      const built = await Bun.build({ entrypoints: [entry], target: 'bun' });
      if (!built.success || built.outputs.length !== 1) throw new Error("the owner helper's program could not be bundled");
      return await built.outputs[0]!.text();
    },
    staging: () => mkdtempSync(join(tmpdir(), 'teamcli-owner-install-')),
    write: (path, text) => writeFileSync(path, text, { mode: 0o600, flag: 'wx' }),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
  };
}
