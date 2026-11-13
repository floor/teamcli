// The neutral secret-store interface behind `team git`, `team gh` and the key word of a provider
// seat's launch line. Every user-facing line says "the system's secret store" and nothing about
// one platform's own facility; the platform's names, files and commands live only in an adapter
// beside this file. A test injects a fake runner (or a whole fake store); the live adapter is
// chosen by `systemSecretStore()` and is the only place that runs the platform's store command.
//
// A secret is named, never held: the team's files carry the name of an entry, and the store
// answers with the value. An identity or an account names it twice: `keychain`, the owner's own
// entry on a store that keeps one set of entries for the machine, and `secret`, the generic name
// (`GITHUB_SEAT_TOKEN`, `KIMI_API_KEY`) a store that keeps one file per entity holds it under, so
// no entity's name is ever a constant inside a key's name. Each adapter reads the name its own
// store keeps; a plain string is the one name every store reads. Two ways out exist.
// `read` brings one value into this process's memory for the one command that needs it — the
// value is in the answer and nowhere else, and a reason never holds it. `lookupCommand` hands a
// launch line the store's own command, which the pane's shell runs inside `$(…)` when the seat
// starts, so a provider key never passes through TeamCLI, its records or its logs at all.
//
// The store is the owner's machine store, read as the same OS user as every seat: like the
// caller placement, this guards against a mistaken agent, not a hostile one.
import { darwinSecretStore } from './store-darwin.ts';
import { linuxSecretStore } from './store-linux.ts';
import type { SecretRunner } from './run.ts';

export type { SecretRunner, SecretRunOptions, SecretRunResult } from './run.ts';

/** One named secret, or why it could not be read. The reason never holds the value. */
export type SecretRead = { ok: true; value: string } | { ok: false; reason: string };

/** The store's own command that prints one named secret on its standard output, for a launch
 *  line's `$(…)`, or why the store has none for that name on this machine. */
export type SecretLookup = { ok: true; command: string } | { ok: false; reason: string };

/** One secret as an identity or an account names it: the owner's machine-wide entry
 *  (`keychain`), and the generic name an entity's own file holds it under (`secret`). `prefix`
 *  is what the value under the generic name must start with: a generic name is the same in every
 *  entity's file, so the kind of key it holds is checked when it is read. */
export type SecretEntry = { keychain: string; secret: string; prefix?: string };

/** What a caller asks a store for: one name every store reads, or an entry's two names. */
export type SecretName = string | SecretEntry;

export type SecretStore = {
  /** Reads one named secret into this process's memory, at most once per call. */
  read(name: SecretName): Promise<SecretRead>;
  /**
   * The command a pane's shell runs to print the named secret. It is one shell command with no
   * quote of its own, so wrapped in `"$(…)"` it stays a single word for the shell and for
   * TeamCLI's own line reader alike. Nothing is read here: the command names the entry only.
   */
  lookupCommand(name: SecretName): SecretLookup;
};

export type SecretStoreOptions = {
  /** Injected for a test that must not run the platform's store command. */
  runner?: SecretRunner;
  platform?: NodeJS.Platform;
  /** The environment the store's command runs in and its locations are read from; defaults to
   *  this process's own. */
  env?: Record<string, string | undefined>;
  /** The account home the store's default locations are under; defaults to `env.HOME`. */
  home?: string;
  /** The entity whose secrets are read. A store that keeps one file per entity opens this one's
   *  and refuses without it; a store that keeps one set of entries for the machine ignores it. */
  entity?: string;
  /** Whether a path is a regular file. Injected by a test that must not read the machine. */
  isFile?: (path: string) => boolean;
  /** Whether a path is a file this user may execute. Injected likewise. */
  isExecutable?: (path: string) => boolean;
};

/** The reason a store gives when it holds no entry by the name asked: a caller may tell an absent
 *  entry from a store that could not answer by this sentence alone. */
export const SECRET_ABSENT = 'the system\'s secret store holds no entry for it';

/** The sentence a command says when this platform has no secret-store adapter. */
export const NO_SECRET_STORE = 'the system\'s secret store is not available on this platform';

/** The local system's secret store, or null when this platform has no adapter yet. */
export function systemSecretStore(options: SecretStoreOptions = {}): SecretStore | null {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return darwinSecretStore(options);
  if (platform === 'linux') return linuxSecretStore(options);
  return null;
}
