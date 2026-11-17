// Whether the machine holds a credential item a vendor needs, read the way the profile declares
// it. The store's own naming and its flags live in the adapter's profile; this file only runs the
// declared command and reads its exit status. The check is attribute-only: it names the item and
// the account, never asks the store for the secret, and never runs a command whose prompt waits
// for one. A swap the machine cannot prove is refused, never guessed at.

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { SECRET_ABSENT, type SecretStore } from '../secrets/store.ts';
import type { CredentialsBlock } from './profile.ts';
import { hostedCommit } from '../host/request-scope.ts';

/** What the store answered: it holds the item, it does not, or this machine cannot say. */
export type CredentialState = 'present' | 'absent' | 'unavailable';

/** Whether one credential item is present. Injected everywhere it is used, so no test and no dry
 *  run touches the machine's real store. */
export type CredentialProbe = (item: string) => CredentialState;

/** One run of the store's check command. `status` is its exit status, `error` set when it could
 *  not be started at all — either way, `null` when no status came back. */
export type CredentialRun = { status: number | null; error?: unknown };

export type CredentialRunner = (file: string, args: readonly string[]) => CredentialRun;

/** The argv that asks the store whether it holds `item` for `account`, without the secret. */
export function checkArgv(credentials: CredentialsBlock, item: string, account: string): string[] {
  return [...credentials.check, '-s', item, '-a', account];
}

/** The one-time command a refusal shows: it asks the store for the secret itself, so the value is
 *  never typed here, never read from stdin and never reaches shell history. */
export function addCommandFor(credentials: CredentialsBlock, item: string): string {
  return credentials.add.replaceAll('{item}', item);
}

/** A probe on this machine: the declared check, its stdin closed, a short timeout, and the
 *  declared status for "no such item". Anything else — another status, no status, a failure to
 *  start — leaves the store unreadable rather than present or absent. */
export function credentialProbeFor(
  credentials: CredentialsBlock,
  account: string,
  run: CredentialRunner = realRun,
): CredentialProbe {
  return (item) => {
    let answer: CredentialRun;
    try {
      answer = run(credentials.check[0]!, checkArgv(credentials, item, account).slice(1));
    } catch {
      return 'unavailable';
    }
    if (answer === undefined || answer === null) return 'unavailable';
    if (answer.error !== undefined && answer.error !== null) return 'unavailable';
    if (answer.status === 0) return 'present';
    if (answer.status === credentials.missingStatus) return 'absent';
    return 'unavailable';
  };
}

function realRun(file: string, args: readonly string[]): CredentialRun {
  try {
    hostedCommit('node:child_process.spawnSync');
    const done = spawnSync(file, [...args], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
    return { status: done.status, error: done.error };
  } catch (error) {
    return { status: null, error };
  }
}

/** Whether the profile's own check can run on this machine: its program is an executable here.
 *  A machine whose store the profile's check does not name asks the system's secret store. */
export function profileCheckRuns(credentials: CredentialsBlock, isExecutable: (path: string) => boolean = executable): boolean {
  const program = credentials.check[0];
  return program !== undefined && isExecutable(program);
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the system's secret store holds `item`, for a machine where the profile's own check
 * does not run. The store has no attribute-only check, so the entry is read once into this
 * process's memory and dropped at once: it is never returned, printed or logged. Its absence is
 * the store's own sentence for an absent entry; any other failure leaves the store unreadable.
 */
export async function storeCredentialState(store: SecretStore | null, item: string): Promise<CredentialState> {
  if (store === null) return 'unavailable';
  let read;
  try {
    read = await store.read(item);
  } catch {
    return 'unavailable';
  }
  if (read.ok) return 'present';
  return read.reason === SECRET_ABSENT ? 'absent' : 'unavailable';
}
